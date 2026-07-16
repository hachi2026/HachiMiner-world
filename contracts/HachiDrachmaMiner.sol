// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  HachiDrachmaMiner
//  World Chain
//
//  Cada tier (segun licencia WLD o Lock, el mas alto) da acceso
//  a un monto FIJO de Drachma:
//    Basica:    500 Drachma
//    Estandar: 1000 Drachma
//    Premium:  1500 Drachma
//    Elite:    2000 Drachma
//
//  El costo en HACHI se calcula en vivo (Drachma -> WLD via V3,
//  WLD -> HACHI via V2), con un descuento configurable (15% por
//  defecto) sobre ese costo de mercado.
//
//  El Drachma se entrega de a poco durante un plazo configurable
//  (30 dias por defecto). Solo 1 mina activa por usuario.
//  El HACHI pagado va directo al owner (no queda en el contrato).
//
//  No depende del PriceOracle compartido — contrato aislado.
// ============================================================

interface IUniswapV2PairMini {
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
    function token0() external view returns (address);
}

interface IUniswapV3PoolMini {
    function slot0() external view returns (
        uint160 sqrtPriceX96, int24 tick,
        uint16 observationIndex, uint16 observationCardinality,
        uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked
    );
    function token0() external view returns (address);
}

interface IPermit2Transfer {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

interface IHachiMinerCoreView {
    function getHighestActiveWLDType(address user) external view returns (uint8);
}

interface IHachiLockView {
    function getUserTier(address user) external view returns (uint8);
}

contract HachiDrachmaMiner is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPermit2Transfer public constant PERMIT2 = IPermit2Transfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    uint256 private constant Q96 = 79228162514264337593543950336;

    uint256 public mineDuration = 30 days;
    uint256 public discountBps = 1500; // 15% de descuento sobre el costo de mercado

    address public immutable HACHI;
    address public immutable WLD;
    address public immutable DRACHMA;

    address public hachiWldPair;
    address public poolWLD_DRACHMA;
    address public minerCore;
    address public lockContract;

    address public owner;
    address public worldVerifier;
    mapping(address => bool) public humanVerified;

    // Monto FIJO de Drachma por tier (0=Basica, 1=Estandar, 2=Premium, 3=Elite)
    uint256[4] public tierDrachmaAmounts = [
        uint256(500 * 1e18),
        uint256(1000 * 1e18),
        uint256(1500 * 1e18),
        uint256(2000 * 1e18)
    ];

    struct DrachmaMine {
        address owner_;
        uint8   tier;
        uint256 hachiPaid;
        uint256 drachmaTotal;
        uint256 drachmaClaimed;
        uint256 drachmaPerSec;
        uint256 startTime;
        uint256 endTime;
        uint256 lastClaim;
        bool active;
    }

    mapping(uint256 => DrachmaMine) public mines;
    mapping(address => uint256) public activeMineId; // 0 = sin mina activa
    uint256 public mineId;

    uint256 public drachmaPool;      // Drachma total depositado por el owner
    uint256 public drachmaCommitted; // Drachma reservado para minas activas

    event Mined(address indexed user, uint8 tier, uint256 hachiIn, uint256 drachmaTotal, uint256 indexed id);
    event Claimed(address indexed user, uint256 indexed id, uint256 amount);
    event PoolFunded(uint256 amount, uint256 newTotal);
    event UserVerified(address indexed user);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyHuman() { require(humanVerified[msg.sender], "World ID required"); _; }

    constructor(address _hachi, address _wld, address _drachma, address _hachiWldPair, address _poolWLD_DRACHMA) {
        owner = msg.sender;
        HACHI = _hachi;
        WLD = _wld;
        DRACHMA = _drachma;
        hachiWldPair = _hachiWldPair;
        poolWLD_DRACHMA = _poolWLD_DRACHMA;
    }

    // --- CONFIG ---------------------------------------------------
    function transferOwnership(address n) external onlyOwner { owner = n; }
    function setWorldVerifier(address _v) external onlyOwner { worldVerifier = _v; }
    function setHachiWldPair(address _p) external onlyOwner { hachiWldPair = _p; }
    function setPoolWLD_DRACHMA(address _p) external onlyOwner { poolWLD_DRACHMA = _p; }
    function setMinerCore(address _c) external onlyOwner { minerCore = _c; }
    function setLockContract(address _l) external onlyOwner { lockContract = _l; }

    function setTierDrachmaAmounts(uint256[4] calldata amounts) external onlyOwner {
        tierDrachmaAmounts = amounts;
    }

    function setDiscountBps(uint256 _bps) external onlyOwner {
        require(_bps < 10000, "must be < 100%");
        discountBps = _bps;
    }

    function setMineDuration(uint256 _seconds) external onlyOwner {
        require(_seconds > 0, "must be > 0");
        mineDuration = _seconds;
    }

    function setHumanVerified(address user) external {
        require(msg.sender == owner || msg.sender == worldVerifier, "not authorized");
        humanVerified[user] = true;
        emit UserVerified(user);
    }

    function fundPool(uint256 amount) external onlyOwner {
        IERC20(DRACHMA).safeTransferFrom(msg.sender, address(this), amount);
        drachmaPool += amount;
        emit PoolFunded(amount, drachmaPool);
    }

    // --- TIER DEL USUARIO (el mas alto entre WLD y Lock, normalizado a 0-3) ---
    // WLD: 0=Basica,1=Estandar,2=Premium,3=Elite (255 = sin licencia)
    // Lock: 0=sin tier (menos de 50k, SIN acceso), 1-2=Basica, 3=Estandar, 4=Premium, 5=Elite
    function _normalizeLockTier(uint8 lockRaw) internal pure returns (uint8) {
        if (lockRaw == 0) return 255;
        if (lockRaw <= 2) return 0;
        if (lockRaw == 3) return 1;
        if (lockRaw == 4) return 2;
        return 3;
    }

    function getUserTier(address user) public view returns (uint8) {
        uint8 wldTier = 255;
        uint8 lockTier = 255;
        if (minerCore != address(0)) {
            try IHachiMinerCoreView(minerCore).getHighestActiveWLDType(user) returns (uint8 t) { wldTier = t; } catch {}
        }
        if (lockContract != address(0)) {
            try IHachiLockView(lockContract).getUserTier(user) returns (uint8 t) { lockTier = _normalizeLockTier(t); } catch {}
        }
        uint8 best = 255;
        if (wldTier != 255 && (best == 255 || wldTier > best)) best = wldTier;
        if (lockTier != 255 && (best == 255 || lockTier > best)) best = lockTier;
        return best; // 255 = sin ningun tier (ni WLD ni Lock)
    }

    // --- LECTURA DE PRECIOS (en vivo, sin cache) -------------------
    function _v2Price(address pool, address tokenIn) internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = IUniswapV2PairMini(pool).getReserves();
        require(r0 > 0 && r1 > 0, "Pool V2 vacio");
        address t0 = IUniswapV2PairMini(pool).token0();
        return tokenIn == t0 ? (uint256(r1) * 1e18) / uint256(r0) : (uint256(r0) * 1e18) / uint256(r1);
    }

    function _slot0Price(address pool, address tokenIn) internal view returns (uint256) {
        (uint160 sqrtPX96,,,,,,) = IUniswapV3PoolMini(pool).slot0();
        require(sqrtPX96 > 0, "Pool V3 vacio");
        address t0 = IUniswapV3PoolMini(pool).token0();
        uint256 sqrtScaled = (uint256(sqrtPX96) * 1e9) / Q96;
        uint256 price = sqrtScaled * sqrtScaled;
        if (tokenIn != t0) {
            require(price > 0, "precio invalido");
            price = 1e36 / price;
        }
        return price;
    }

    /// @notice Costo en HACHI (con descuento ya aplicado) para minar el tier indicado, ahora mismo.
    function costInHachi(uint8 tier) public view returns (uint256 hachiCost) {
        require(tier <= 3, "tier invalido");
        uint256 drachmaAmount = tierDrachmaAmounts[tier];
        uint256 wldPerDrachma = _slot0Price(poolWLD_DRACHMA, DRACHMA);
        uint256 wldEquivalent = (drachmaAmount * wldPerDrachma) / 1e18;
        uint256 hachiPerWld = _v2Price(hachiWldPair, WLD);
        uint256 fullCost = (wldEquivalent * hachiPerWld) / 1e18;
        hachiCost = (fullCost * (10000 - discountBps)) / 10000;
    }

    // --- MINAR (elige tier hasta el que califique, paga HACHI con descuento) ---
    function mineDrachma(uint8 tier, uint256 maxHachiIn) external nonReentrant onlyHuman returns (uint256 id) {
        require(activeMineId[msg.sender] == 0 || !mines[activeMineId[msg.sender]].active, "Ya tenes una mina activa");

        uint8 userTier = getUserTier(msg.sender);
        require(userTier != 255, "Necesitas una licencia WLD o Lock activo");
        require(tier <= userTier, "No calificas para ese tier");

        uint256 drachmaTotal = tierDrachmaAmounts[tier];
        require(drachmaPool - drachmaCommitted >= drachmaTotal, "Pool de Drachma insuficiente");

        uint256 hachiCost = costInHachi(tier);
        require(hachiCost <= maxHachiIn, "Slippage: costo mayor al esperado");

        PERMIT2.transferFrom(msg.sender, owner, uint160(hachiCost), HACHI);

        drachmaCommitted += drachmaTotal;

        mineId++;
        id = mineId;
        mines[id] = DrachmaMine({
            owner_: msg.sender,
            tier: tier,
            hachiPaid: hachiCost,
            drachmaTotal: drachmaTotal,
            drachmaClaimed: 0,
            drachmaPerSec: drachmaTotal / mineDuration,
            startTime: block.timestamp,
            endTime: block.timestamp + mineDuration,
            lastClaim: block.timestamp,
            active: true
        });
        activeMineId[msg.sender] = id;

        emit Mined(msg.sender, tier, hachiCost, drachmaTotal, id);
    }

    // --- VISTAS -------------------------------------------------
    function pendingDrachma(uint256 id) public view returns (uint256) {
        DrachmaMine storage m = mines[id];
        if (!m.active) return 0;
        uint256 endT = block.timestamp < m.endTime ? block.timestamp : m.endTime;
        if (endT <= m.lastClaim) return 0;
        uint256 elapsed = endT - m.lastClaim;
        uint256 pending = m.drachmaPerSec * elapsed;
        uint256 maxRemaining = m.drachmaTotal - m.drachmaClaimed;
        return pending > maxRemaining ? maxRemaining : pending;
    }

    // --- RECLAMAR -------------------------------------------------
    function claimDrachma(uint256 id) external nonReentrant {
        DrachmaMine storage m = mines[id];
        require(m.owner_ == msg.sender, "not owner");
        require(m.active, "not active");

        uint256 pending = pendingDrachma(id);
        require(pending > 0, "nothing to claim");

        m.drachmaClaimed += pending;
        m.lastClaim = block.timestamp;
        drachmaCommitted -= pending;
        drachmaPool -= pending;

        if (m.drachmaClaimed >= m.drachmaTotal) m.active = false;

        IERC20(DRACHMA).safeTransfer(msg.sender, pending);
        emit Claimed(msg.sender, id, pending);
    }
}
