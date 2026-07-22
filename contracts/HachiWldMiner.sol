// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  HachiWldMiner
//  World Chain
//
//  Paga WLD, recibe HACHI + Drachma combinados, generados
//  linealmente durante el plazo elegido. 3 variantes:
//    0: 30 dias, 30% de retorno
//    1: 15 dias, 15% de retorno
//    2:  7 dias, 10% de retorno
//
//  El retorno se reparte 70% HACHI / 30% Drachma (configurable).
//  El precio de WLD->HACHI se lee del PriceOracle compartido.
//  El precio de WLD->Drachma se lee en vivo del pool V3 (spot).
//
//  Tope de WLD invertible por tier (WLD activa o Lock, el mas
//  alto, mismo mapeo que HachiDrachmaMiner):
//    Basica: 2 WLD | Estandar: 5 WLD | Premium: 7 WLD | Elite: 12 WLD
//
//  Solo 1 mina activa por usuario (de cualquiera de las 3
//  variantes). Sin exigencia de World ID (funciona en v1 y v2).
//  Limitado por el stock disponible de AMBOS pools (HACHI y Drachma).
// ============================================================

interface IPriceOracleView {
    function wldToHachi(uint256 wldAmount) external view returns (uint256);
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

contract HachiWldMiner is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPermit2Transfer public constant PERMIT2 = IPermit2Transfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    uint256 private constant Q96 = 79228162514264337593543950336;

    address public immutable WLD;
    address public immutable HACHI;
    address public immutable DRACHMA;

    address public priceOracle;
    address public poolWLD_DRACHMA;
    address public minerCore;
    address public lockContract;

    address public owner;
    mapping(address => bool) public humanVerified; // sin uso en claim, disponible a futuro

    uint256 public hachiSplitBps = 7000; // 70% HACHI, resto Drachma

    struct VariantConfig {
        uint256 duration;
        uint256 returnBps;
    }
    VariantConfig[3] public variants;

    // Tope de WLD invertible por tier (0=Basica,1=Estandar,2=Premium,3=Elite)
    uint256[4] public tierCapsWld = [
        uint256(2 * 1e18), 5 * 1e18, 7 * 1e18, 12 * 1e18
    ];

    struct WldMine {
        address owner_;
        uint8 variant;
        uint256 wldPaid;
        uint256 hachiTotal;
        uint256 hachiClaimed;
        uint256 drachmaTotal;
        uint256 drachmaClaimed;
        uint256 startTime;
        uint256 endTime;
        uint256 lastClaim;
        bool active;
    }

    mapping(uint256 => WldMine) public mines;
    mapping(address => uint256) public activeMineId;
    uint256 public mineId;

    uint256 public hachiPool;
    uint256 public hachiCommitted;
    uint256 public drachmaPool;
    uint256 public drachmaCommitted;

    event Mined(address indexed user, uint8 variant, uint256 wldIn, uint256 hachiTotal, uint256 drachmaTotal, uint256 indexed id);
    event Claimed(address indexed user, uint256 indexed id, uint256 hachiAmount, uint256 drachmaAmount);
    event PoolFunded(string token, uint256 amount, uint256 newTotal);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(
        address _wld, address _hachi, address _drachma,
        address _priceOracle, address _poolWLD_DRACHMA
    ) {
        owner = msg.sender;
        WLD = _wld;
        HACHI = _hachi;
        DRACHMA = _drachma;
        priceOracle = _priceOracle;
        poolWLD_DRACHMA = _poolWLD_DRACHMA;

        variants[0] = VariantConfig({duration: 30 days, returnBps: 3000});
        variants[1] = VariantConfig({duration: 15 days, returnBps: 1500});
        variants[2] = VariantConfig({duration: 7 days, returnBps: 1000});
    }

    // --- CONFIG ---------------------------------------------------
    function transferOwnership(address n) external onlyOwner { owner = n; }
    function setPriceOracle(address _p) external onlyOwner { priceOracle = _p; }
    function setPoolWLD_DRACHMA(address _p) external onlyOwner { poolWLD_DRACHMA = _p; }
    function setMinerCore(address _c) external onlyOwner { minerCore = _c; }
    function setLockContract(address _l) external onlyOwner { lockContract = _l; }
    function setHachiSplitBps(uint256 _bps) external onlyOwner { require(_bps <= 10000, "max 100%"); hachiSplitBps = _bps; }
    function setTierCapsWld(uint256[4] calldata caps) external onlyOwner { tierCapsWld = caps; }

    function setVariant(uint8 idx, uint256 duration, uint256 returnBps) external onlyOwner {
        require(idx < 3, "invalid variant");
        variants[idx] = VariantConfig({duration: duration, returnBps: returnBps});
    }

    function setHumanVerified(address user) external onlyOwner {
        humanVerified[user] = true;
    }

    function fundHachiPool(uint256 amount) external onlyOwner {
        IERC20(HACHI).safeTransferFrom(msg.sender, address(this), amount);
        hachiPool += amount;
        emit PoolFunded("HACHI", amount, hachiPool);
    }

    function fundDrachmaPool(uint256 amount) external onlyOwner {
        IERC20(DRACHMA).safeTransferFrom(msg.sender, address(this), amount);
        drachmaPool += amount;
        emit PoolFunded("DRACHMA", amount, drachmaPool);
    }

    // --- TIER DEL USUARIO (mismo mapeo que HachiDrachmaMiner) -------
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
        return best;
    }

    function maxInvestableWld(address user) public view returns (uint256) {
        uint8 tier = getUserTier(user);
        if (tier == 255 || tier > 3) return 0;
        return tierCapsWld[tier];
    }

    // --- PRECIOS (en vivo) ------------------------------------------
    function _slot0PriceWldToDrachma(uint256 wldAmount) internal view returns (uint256) {
        (uint160 sqrtPX96,,,,,,) = IUniswapV3PoolMini(poolWLD_DRACHMA).slot0();
        require(sqrtPX96 > 0, "Pool V3 vacio");
        address t0 = IUniswapV3PoolMini(poolWLD_DRACHMA).token0();
        uint256 sqrtScaled = (uint256(sqrtPX96) * 1e9) / Q96;
        uint256 price = sqrtScaled * sqrtScaled; // precio de token1 por token0, x1e18
        if (WLD != t0) {
            require(price > 0, "precio invalido");
            price = 1e36 / price;
        }
        return (wldAmount * price) / 1e18;
    }

    /// @notice Cuanto HACHI y Drachma total se generaria por una cantidad de WLD, en la variante indicada.
    function previewMine(uint256 wldAmount, uint8 variantIdx) public view returns (uint256 hachiTotal, uint256 drachmaTotal) {
        require(variantIdx < 3, "invalid variant");
        VariantConfig memory v = variants[variantIdx];
        uint256 effectiveWld = (wldAmount * (10000 + v.returnBps)) / 10000;
        uint256 wldForHachi = (effectiveWld * hachiSplitBps) / 10000;
        uint256 wldForDrachma = effectiveWld - wldForHachi;
        hachiTotal = IPriceOracleView(priceOracle).wldToHachi(wldForHachi);
        drachmaTotal = _slot0PriceWldToDrachma(wldForDrachma);
    }

    // --- MINAR ------------------------------------------------------
    function mineWld(uint256 wldAmount, uint8 variantIdx, uint256 minHachiTotal, uint256 minDrachmaTotal) external nonReentrant returns (uint256 id) {
        require(variantIdx < 3, "invalid variant");
        require(activeMineId[msg.sender] == 0 || !mines[activeMineId[msg.sender]].active, "Ya tenes una mina activa");

        uint256 cap = maxInvestableWld(msg.sender);
        require(cap > 0, "Necesitas una licencia WLD o Lock activo");
        require(wldAmount <= cap, "Supera tu tope de inversion");

        PERMIT2.transferFrom(msg.sender, owner, uint160(wldAmount), WLD);
        // el WLD se envia directo al owner, no queda en el contrato

        (uint256 hachiTotal, uint256 drachmaTotal) = previewMine(wldAmount, variantIdx);
        require(hachiTotal >= minHachiTotal, "Slippage: HACHI total too low");
        require(drachmaTotal >= minDrachmaTotal, "Slippage: Drachma total too low");
        require(hachiPool - hachiCommitted >= hachiTotal, "Pool de HACHI insuficiente");
        require(drachmaPool - drachmaCommitted >= drachmaTotal, "Pool de Drachma insuficiente");

        hachiCommitted += hachiTotal;
        drachmaCommitted += drachmaTotal;

        VariantConfig memory v = variants[variantIdx];
        mineId++;
        id = mineId;
        mines[id] = WldMine({
            owner_: msg.sender,
            variant: variantIdx,
            wldPaid: wldAmount,
            hachiTotal: hachiTotal,
            hachiClaimed: 0,
            drachmaTotal: drachmaTotal,
            drachmaClaimed: 0,
            startTime: block.timestamp,
            endTime: block.timestamp + v.duration,
            lastClaim: block.timestamp,
            active: true
        });
        activeMineId[msg.sender] = id;

        emit Mined(msg.sender, variantIdx, wldAmount, hachiTotal, drachmaTotal, id);
    }

    // --- VISTAS -------------------------------------------------
    function pendingRewards(uint256 id) public view returns (uint256 pendingHachi, uint256 pendingDrachma) {
        WldMine storage m = mines[id];
        if (!m.active) return (0, 0);
        uint256 endT = block.timestamp < m.endTime ? block.timestamp : m.endTime;
        if (endT <= m.lastClaim) return (0, 0);
        uint256 elapsed = endT - m.lastClaim;
        uint256 totalDuration = m.endTime - m.startTime;

        uint256 hachiRate = m.hachiTotal / totalDuration;
        uint256 drachmaRate = m.drachmaTotal / totalDuration;

        uint256 pHachi = hachiRate * elapsed;
        uint256 maxHachi = m.hachiTotal - m.hachiClaimed;
        pendingHachi = pHachi > maxHachi ? maxHachi : pHachi;

        uint256 pDrachma = drachmaRate * elapsed;
        uint256 maxDrachma = m.drachmaTotal - m.drachmaClaimed;
        pendingDrachma = pDrachma > maxDrachma ? maxDrachma : pDrachma;
    }

    // --- RECLAMAR -------------------------------------------------
    function claimRewards(uint256 id) external nonReentrant {
        WldMine storage m = mines[id];
        require(m.owner_ == msg.sender, "not owner");
        require(m.active, "not active");

        (uint256 pHachi, uint256 pDrachma) = pendingRewards(id);
        require(pHachi > 0 || pDrachma > 0, "nothing to claim");

        m.hachiClaimed += pHachi;
        m.drachmaClaimed += pDrachma;
        m.lastClaim = block.timestamp;

        hachiCommitted -= pHachi;
        hachiPool -= pHachi;
        drachmaCommitted -= pDrachma;
        drachmaPool -= pDrachma;

        if (m.hachiClaimed >= m.hachiTotal && m.drachmaClaimed >= m.drachmaTotal) m.active = false;

        if (pHachi > 0) IERC20(HACHI).safeTransfer(msg.sender, pHachi);
        if (pDrachma > 0) IERC20(DRACHMA).safeTransfer(msg.sender, pDrachma);

        emit Claimed(msg.sender, id, pHachi, pDrachma);
    }
}
