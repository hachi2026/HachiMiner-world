// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  HachiLock v4 (Permit2 / World App compatible)
//  World Chain - HACHI: 0xbE0313f279580FDD1aA1b1b6888407E6504fF19E
//
//  CAMBIO v4: el deposito del usuario ahora jala HACHI via
//  Permit2 (permit2.transferFrom) para funcionar dentro de
//  World App sin pantalla en blanco. El frontend debe enviar
//  el approve de Permit2 + el deposit en una sola sendTransaction.
//
//  MECANICA (sin cambios):
//  - Una sola posicion por usuario
//  - Depositos: cada 12h minimo - se suman al total
//    cada lote tiene su propio contador de 15 dias
//  - APY: sobre saldo total - acumula por segundo
//    claim minimo cada 12h
//  - Retiros: cada 24h - solo fondos que cumplieron 15 dias
//  - Requisito licencias SUSHI: 5,000 HACHI lockeados activos
// ============================================================

interface IHachiRanking {
    function addPoints(address user, uint256 points) external;
}

/// @notice Interfaz minima de Permit2 (AllowanceTransfer) de Uniswap
///         Deployado en la misma direccion en todas las redes EVM, incl. World Chain
interface IAllowanceTransfer {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

contract HachiLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20  public immutable HACHI;
    address public owner;
    address public minerCore;
    address public rankingContract;

    // Permit2 canonico (misma direccion en todas las redes)
    IAllowanceTransfer public constant PERMIT2 =
        IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    // --- CONSTANTES ------------------------------------------
    uint256 public constant MIN_LOCK_DAYS   = 15 days;
    uint256 public constant CLAIM_COOLDOWN   = 24 hours;
    uint256 public constant UNSTAKE_COOLDOWN = 24 hours;
    uint256 public constant MIN_SUSHI_LIC    = 5_000 * 1e18; // minimo para licencias SUSHI
    uint256 public constant YEAR_SECONDS     = 365 days;

    // Tiers - minimo de HACHI total lockeado
    uint256 public constant TIER1_MIN = 50_000    * 1e18; // Akira
    uint256 public constant TIER2_MIN = 200_000   * 1e18; // Zen
    uint256 public constant TIER3_MIN = 500_000   * 1e18; // Koban
    uint256 public constant TIER4_MIN = 750_000   * 1e18; // Tayko
    uint256 public constant TIER5_MIN = 1_000_000 * 1e18; // Hachi

    // APY por tier (% anual, pagado en HACHI)
    uint256 public constant TIER1_APY = 10;
    uint256 public constant TIER2_APY = 20;
    uint256 public constant TIER3_APY = 30;
    uint256 public constant TIER4_APY = 40;
    uint256 public constant TIER5_APY = 50;

    // --- STRUCT LOTE DE DEPOSITO -----------------------------
    struct Batch {
        uint256 amount;       // HACHI en este lote
        uint256 depositedAt;  // timestamp del deposito
        uint256 unlocksAt;    // depositedAt + 15 dias
    }

    // --- POSICION DEL USUARIO --------------------------------
    struct Position {
        uint256 totalAmount;    // suma de todos los lotes activos
        uint256 apyPerSec;      // HACHI/segundo = totalAmount * APY% / YEAR_SECONDS
        uint256 lastClaimTime;  // ultimo claim de APY
        uint256 lastDepositTime;// ultimo deposito (cooldown 12h)
        uint256 lastUnstakeTime;// ultimo retiro (cooldown 24h)
        uint256 accruedHachi;   // APY acumulado pendiente de cobrar
        uint8   tier;           // tier actual (0 = sin tier)
        bool    active;
    }

    mapping(address => Position)  public positions;
    mapping(address => Batch[])   public userBatches;

    // Pool APY
    uint256 public apyPool;
    uint256 public totalLocked;

    // Stats
    uint256 public totalUsers;
    uint256 public totalHachiPaid;

    // --- EVENTS ----------------------------------------------
    event Deposited(address indexed user, uint256 amount, uint256 newTotal, uint8 tier);
    event APYClaimed(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount, uint256 remaining);
    event APYPoolFunded(uint256 amount, uint256 newTotal);
    event TierUpdated(address indexed user, uint8 oldTier, uint8 newTier);

    modifier onlyOwner()  { require(msg.sender == owner, "not owner"); _; }
    modifier onlyCore()   { require(msg.sender == minerCore || msg.sender == owner, "not authorized"); _; }

    constructor(address _hachi) {
        owner = msg.sender;
        HACHI = IERC20(_hachi);
    }

    // --- CONFIG ----------------------------------------------
    function setMinerCore(address _core) external onlyOwner { minerCore = _core; }
    function setRanking(address _r) external onlyOwner { rankingContract = _r; }
    function transferOwnership(address n) external onlyOwner { require(n != address(0)); owner = n; }

    // --- FONDEAR POOL APY ------------------------------------
    // El owner fondea con approve clasico (no via World App). Se mantiene safeTransferFrom.
    function ownerFundAPYPool(uint256 amount) external onlyOwner {
        HACHI.safeTransferFrom(msg.sender, address(this), amount);
        apyPool += amount;
        emit APYPoolFunded(amount, apyPool);
    }

    /// @notice HachiMinerCore deposita 40% de ventas de licencias SUSHI
    /// Llamado contrato-a-contrato con approve clasico. Se mantiene safeTransferFrom.
    function fundAPYPool(uint256 amount) external onlyCore {
        HACHI.safeTransferFrom(msg.sender, address(this), amount);
        apyPool += amount;
        emit APYPoolFunded(amount, apyPool);
    }

    // --- DEPOSITAR (Permit2) ---------------------------------
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");

        Position storage p = positions[msg.sender];

        if (p.active) {
            _accrueAPY(msg.sender);
        }

        // Jala HACHI del usuario via Permit2 (World App ya aprobo el token a Permit2)
        PERMIT2.transferFrom(msg.sender, address(this), uint160(amount), address(HACHI));

        // Crear nuevo lote
        userBatches[msg.sender].push(Batch({
            amount:      amount,
            depositedAt: block.timestamp,
            unlocksAt:   block.timestamp + MIN_LOCK_DAYS
        }));

        if (!p.active) {
            p.active          = true;
            p.lastClaimTime   = block.timestamp;
            p.lastDepositTime = block.timestamp;
            p.lastUnstakeTime = 0;
            p.accruedHachi    = 0;
            totalUsers++;
        } else {
            p.lastDepositTime = block.timestamp;
        }

        p.totalAmount += amount;
        totalLocked   += amount;

        uint8 oldTier = p.tier;
        p.tier     = _calcTier(p.totalAmount);
        p.apyPerSec = _calcAPYPerSec(p.totalAmount, p.tier);

        if (p.tier != oldTier)
            emit TierUpdated(msg.sender, oldTier, p.tier);

        emit Deposited(msg.sender, amount, p.totalAmount, p.tier);
    }

    // --- RECLAMAR APY ----------------------------------------
    function claimAPY() external nonReentrant {
        Position storage p = positions[msg.sender];
        require(p.active, "No active position");
        require(
            block.timestamp >= p.lastClaimTime + CLAIM_COOLDOWN,
            "Claim cooldown: 12 hours"
        );

        _accrueAPY(msg.sender);

        uint256 toClaim = p.accruedHachi;
        require(toClaim > 0, "Nothing to claim");
        require(apyPool >= toClaim, "APY pool empty");

        p.accruedHachi  = 0;
        p.lastClaimTime = block.timestamp;
        apyPool        -= toClaim;
        totalHachiPaid += toClaim;

        HACHI.safeTransfer(msg.sender, toClaim);

        if (rankingContract != address(0))
            try IHachiRanking(rankingContract).addPoints(msg.sender, toClaim / 1e18) {} catch {}

        emit APYClaimed(msg.sender, toClaim);
    }

    // --- RETIRAR (UNSTAKE) -----------------------------------
    function unstake(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        Position storage p = positions[msg.sender];
        require(p.active, "No active position");
        require(
            block.timestamp >= p.lastUnstakeTime + UNSTAKE_COOLDOWN,
            "Unstake cooldown: 24 hours"
        );

        uint256 available = _availableToUnstake(msg.sender);
        require(available >= amount, "Insufficient unlocked balance");

        _accrueAPY(msg.sender);

        uint256 remaining = amount;
        Batch[] storage batches = userBatches[msg.sender];
        for (uint256 i = 0; i < batches.length && remaining > 0; i++) {
            if (batches[i].amount == 0) continue;
            if (block.timestamp < batches[i].unlocksAt) continue;

            if (batches[i].amount <= remaining) {
                remaining -= batches[i].amount;
                batches[i].amount = 0;
            } else {
                batches[i].amount -= remaining;
                remaining = 0;
            }
        }

        p.totalAmount    -= amount;
        p.lastUnstakeTime = block.timestamp;
        totalLocked      -= amount;

        uint8 oldTier = p.tier;
        p.tier      = _calcTier(p.totalAmount);
        p.apyPerSec = _calcAPYPerSec(p.totalAmount, p.tier);

        if (p.tier != oldTier)
            emit TierUpdated(msg.sender, oldTier, p.tier);

        if (p.totalAmount == 0) p.active = false;

        HACHI.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, p.totalAmount);
    }

    // --- VISTAS ----------------------------------------------

    function pendingAPY(address user) external view returns (uint256) {
        Position memory p = positions[user];
        if (!p.active || p.apyPerSec == 0) return p.accruedHachi;
        uint256 elapsed = block.timestamp - p.lastClaimTime;
        return p.accruedHachi + (elapsed * p.apyPerSec);
    }

    function availableToUnstake(address user) external view returns (uint256) {
        return _availableToUnstake(user);
    }

    function getUserBatches(address user) external view returns (
        uint256[] memory amounts,
        uint256[] memory unlocksAt,
        bool[]    memory unlocked
    ) {
        Batch[] memory b = userBatches[user];
        amounts   = new uint256[](b.length);
        unlocksAt = new uint256[](b.length);
        unlocked  = new bool[](b.length);
        for (uint256 i = 0; i < b.length; i++) {
            amounts[i]   = b[i].amount;
            unlocksAt[i] = b[i].unlocksAt;
            unlocked[i]  = block.timestamp >= b[i].unlocksAt;
        }
    }

    function getUserTier(address user) external view returns (uint8) {
        return positions[user].tier;
    }

    function canMine(address user) external view returns (bool) {
        Position memory p = positions[user];
        return p.active && p.totalAmount >= MIN_SUSHI_LIC;
    }

    function getPosition(address user) external view returns (
        uint256 totalAmount,
        uint256 availableUnstake,
        uint256 pendingAPY_,
        uint8   tier,
        uint256 apyPercent,
        uint256 nextDepositIn,
        uint256 nextClaimIn,
        uint256 nextUnstakeIn,
        bool    canBuySushiLic
    ) {
        Position memory p = positions[user];
        uint256 now_ = block.timestamp;

        totalAmount      = p.totalAmount;
        availableUnstake = _availableToUnstake(user);
        pendingAPY_      = p.active && p.apyPerSec > 0
            ? p.accruedHachi + (now_ - p.lastClaimTime) * p.apyPerSec
            : p.accruedHachi;
        tier             = p.tier;
        apyPercent       = _tierAPY(p.tier);
        nextDepositIn    = 0;
        nextClaimIn      = p.active && now_ < p.lastClaimTime + CLAIM_COOLDOWN
            ? (p.lastClaimTime + CLAIM_COOLDOWN) - now_ : 0;
        nextUnstakeIn    = p.active && now_ < p.lastUnstakeTime + UNSTAKE_COOLDOWN
            ? (p.lastUnstakeTime + UNSTAKE_COOLDOWN) - now_ : 0;
        canBuySushiLic   = p.active && p.totalAmount >= MIN_SUSHI_LIC;
    }

    function getPoolStatus() external view returns (
        uint256 pool,
        uint256 locked,
        uint256 users,
        uint256 paid
    ) {
        return (apyPool, totalLocked, totalUsers, totalHachiPaid);
    }

    // --- INTERNOS --------------------------------------------

    function _accrueAPY(address user) internal {
        Position storage p = positions[user];
        if (!p.active || p.apyPerSec == 0) return;
        uint256 elapsed = block.timestamp - p.lastClaimTime;
        if (elapsed > 0) {
            p.accruedHachi += elapsed * p.apyPerSec;
            p.lastClaimTime = block.timestamp;
        }
    }

    function _availableToUnstake(address user) internal view returns (uint256 total) {
        Batch[] memory b = userBatches[user];
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i].amount > 0 && block.timestamp >= b[i].unlocksAt)
                total += b[i].amount;
        }
    }

    function _calcTier(uint256 amount) internal pure returns (uint8) {
        if (amount >= TIER5_MIN) return 5;
        if (amount >= TIER4_MIN) return 4;
        if (amount >= TIER3_MIN) return 3;
        if (amount >= TIER2_MIN) return 2;
        if (amount >= TIER1_MIN) return 1;
        return 0;
    }

    function _tierAPY(uint8 tier) internal pure returns (uint256) {
        if (tier == 5) return TIER5_APY;
        if (tier == 4) return TIER4_APY;
        if (tier == 3) return TIER3_APY;
        if (tier == 2) return TIER2_APY;
        if (tier == 1) return TIER1_APY;
        return 0;
    }

    function _calcAPYPerSec(uint256 amount, uint8 tier) internal pure returns (uint256) {
        uint256 apy = _tierAPY(tier);
        if (apy == 0 || amount == 0) return 0;
        return (amount * apy) / (100 * YEAR_SECONDS);
    }

    // --- TIMELOCK EMERGENCIA ---------------------------------
    uint256 public constant EMERGENCY_DELAY = 48 hours;
    uint256 public emergencyUnlockTime;
    bool    public emergencyRequested;

    event EmergencyRequested(uint256 unlockTime);
    event EmergencyExecuted(address token, uint256 amount);
    event EmergencyCancelled();

    function requestEmergency() external onlyOwner {
        require(!emergencyRequested, "Already requested");
        emergencyUnlockTime = block.timestamp + EMERGENCY_DELAY;
        emergencyRequested  = true;
        emit EmergencyRequested(emergencyUnlockTime);
    }

    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        require(emergencyRequested, "Not requested");
        require(block.timestamp >= emergencyUnlockTime, "Timelock active");
        emergencyRequested = false;
        IERC20(token).safeTransfer(owner, amount);
        emit EmergencyExecuted(token, amount);
    }

    function cancelEmergency() external onlyOwner {
        require(emergencyRequested, "Nothing to cancel");
        emergencyRequested  = false;
        emergencyUnlockTime = 0;
        emit EmergencyCancelled();
    }
}
