// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  HachiDailyRewards
//  World Chain
//
//  Reemplaza al retiro diario viejo de HachiMinerCore
//  (withdrawDailyHachi), que no exigia verificacion World ID.
//  Este contrato exige onlyHuman desde el dia 1.
//
//  RECOMPENSA HACHI (una vez cada 24hs):
//  - Base: 5 HACHI para cualquier verificado
//  - +20 HACHI si tiene lock activo en HachiLock
//  - +20 HACHI si tiene al menos 1 licencia WLD activa
//  - Maximo: 45 HACHI/dia (con lock + licencia)
//  - Los 3 montos son ajustables por el owner
//
//  RECOMPENSA TOKEN NUEVO (una vez cada 24hs):
//  - 0.5 tokens por cada 1 WLD invertido en licencias activas
//  - Si tiene varias licencias activas, se suman los WLD de todas
//  - Tasa ajustable por el owner
//
//  Solo LEE de HachiMinerCore y HachiLock (view calls, no requiere
//  permisos ni modifica esos contratos).
// ============================================================

interface IHachiMinerCoreView {
    function getUserWLDLics(address u) external view returns (uint256[] memory);
}

interface IHachiLockView {
    function positions(address user) external view returns (
        uint256 totalAmount, uint256 apyPerSec, uint256 lastClaimTime,
        uint256 lastDepositTime, uint256 lastUnstakeTime, uint256 accruedHachi,
        uint8 tier, bool active
    );
}

contract HachiDailyRewards is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable HACHI;
    IERC20 public immutable BONUS_TOKEN;

    address public owner;
    address public worldVerifier;
    address public minerCore;
    address public lockContract;

    mapping(address => bool) public humanVerified;
    mapping(address => uint256) public lastClaim;

    // --- TASAS AJUSTABLES --------------------------------------
    uint256 public baseRate            = 5  * 1e18; // HACHI base, siempre
    uint256 public lockBonus           = 20 * 1e18; // HACHI extra si tiene lock activo
    uint256 public licenseBonus        = 20 * 1e18; // HACHI extra si tiene licencia WLD activa
    uint256 public bonusTokenRateBps   = 5000;       // 0.5 token por WLD = 5000/10000

    uint256 public constant CLAIM_COOLDOWN = 24 hours;

    // --- POOLS --------------------------------------------------
    uint256 public hachiPool;
    uint256 public bonusPool;

    event Claimed(address indexed user, uint256 hachiAmount, uint256 bonusAmount, bool hadLock, bool hadLicense, uint256 wldInvested);
    event PoolFunded(address indexed token, uint256 amount, uint256 newTotal);
    event UserVerified(address indexed user);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyHuman() { require(humanVerified[msg.sender], "World ID required"); _; }

    constructor(address _hachi, address _bonusToken) {
        owner = msg.sender;
        HACHI = IERC20(_hachi);
        BONUS_TOKEN = IERC20(_bonusToken);
    }

    // --- CONFIG ---------------------------------------------------
    function setContracts(address _core, address _lock) external onlyOwner {
        minerCore    = _core;
        lockContract = _lock;
    }
    function setWorldVerifier(address _v) external onlyOwner { worldVerifier = _v; }
    function setRates(uint256 _base, uint256 _lockBonus, uint256 _licenseBonus, uint256 _bonusTokenRateBps) external onlyOwner {
        baseRate          = _base;
        lockBonus         = _lockBonus;
        licenseBonus      = _licenseBonus;
        bonusTokenRateBps = _bonusTokenRateBps;
    }
    function transferOwnership(address n) external onlyOwner { owner = n; }

    /// @notice Sincronizar verificacion World ID (v4, verificado off-chain
    /// por el backend, via worldVerifier).
    function setHumanVerified(address user) external {
        require(msg.sender == owner || msg.sender == worldVerifier, "not authorized");
        humanVerified[user] = true;
        emit UserVerified(user);
    }

    // --- FONDEAR POOLS --------------------------------------------
    function fundHachiPool(uint256 amount) external onlyOwner {
        HACHI.safeTransferFrom(msg.sender, address(this), amount);
        hachiPool += amount;
        emit PoolFunded(address(HACHI), amount, hachiPool);
    }
    function fundBonusPool(uint256 amount) external onlyOwner {
        BONUS_TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        bonusPool += amount;
        emit PoolFunded(address(BONUS_TOKEN), amount, bonusPool);
    }

    // --- LECTURA DE CONDICIONES (view, no modifica nada) -----------
    function hasActiveLock(address user) public view returns (bool) {
        if (lockContract == address(0)) return false;
        try IHachiLockView(lockContract).positions(user) returns (
            uint256, uint256, uint256, uint256, uint256, uint256, uint8, bool active
        ) {
            return active;
        } catch { return false; }
    }

    // Lee solo 3 campos puntuales del struct LicenseWLD (wldPrice, endTime,
    // active) via staticcall crudo, en vez de decodificar los 12 campos
    // completos — evita el error de "stack too deep" del compilador.
    // Layout del getter publico wldLics(uint256), en orden (cada slot=32 bytes):
    // 0 owner_ | 1 wldType | 2 wldPrice | 3 hachiTotal | 4 hachiPerSec |
    // 5 hachiClaimed | 6 startTime | 7 endTime | 8 lastHachiClaim |
    // 9 hachiCommitted | 10 active | 11 matured
    function _licensePrice(uint256 id) internal view returns (uint256 price, bool activeNow) {
        (bool ok, bytes memory data) = minerCore.staticcall(
            abi.encodeWithSignature("wldLics(uint256)", id)
        );
        if (!ok || data.length < 384) return (0, false);

        uint256 wldPrice;
        uint256 endTime;
        bool active;
        assembly {
            wldPrice := mload(add(data, 96))
            endTime  := mload(add(data, 256))
            active   := mload(add(data, 352))
        }
        if (active && block.timestamp < endTime) {
            return (wldPrice, true);
        }
        return (0, false);
    }

    /// @notice Suma el WLD invertido en licencias ACTIVAS (no vencidas)
    /// del usuario. hasLicense = true si tiene al menos una vigente.
    function wldInvested(address user) public view returns (uint256 totalWLD, bool hasLicense) {
        if (minerCore == address(0)) return (0, false);
        uint256[] memory ids;
        try IHachiMinerCoreView(minerCore).getUserWLDLics(user) returns (uint256[] memory r) { ids = r; } catch { return (0, false); }
        for (uint256 i = 0; i < ids.length; i++) {
            (uint256 price, bool activeNow) = _licensePrice(ids[i]);
            if (activeNow) { totalWLD += price; hasLicense = true; }
        }
    }

    /// @notice Preview de lo que se cobraria AHORA si el usuario reclama
    /// (para mostrar en la UI sin gastar gas).
    function previewClaim(address user) external view returns (
        uint256 hachiAmount, uint256 bonusAmount, bool canClaimNow, uint256 secondsUntilNext
    ) {
        bool lock = hasActiveLock(user);
        (uint256 wld, bool lic) = wldInvested(user);

        hachiAmount = baseRate;
        if (lock) hachiAmount += lockBonus;
        if (lic)  hachiAmount += licenseBonus;

        bonusAmount = (wld * bonusTokenRateBps) / 10000;

        uint256 next = lastClaim[user] + CLAIM_COOLDOWN;
        canClaimNow = block.timestamp >= next;
        secondsUntilNext = canClaimNow ? 0 : next - block.timestamp;
    }

    // --- RECLAMAR ---------------------------------------------------
    function claim() external nonReentrant onlyHuman {
        require(block.timestamp >= lastClaim[msg.sender] + CLAIM_COOLDOWN, "Cooldown: 24 horas");

        bool lock = hasActiveLock(msg.sender);
        (uint256 wld, bool lic) = wldInvested(msg.sender);

        uint256 hachiAmount = baseRate;
        if (lock) hachiAmount += lockBonus;
        if (lic)  hachiAmount += licenseBonus;

        uint256 bonusAmount = (wld * bonusTokenRateBps) / 10000;

        lastClaim[msg.sender] = block.timestamp;

        if (hachiAmount > 0 && hachiPool >= hachiAmount) {
            hachiPool -= hachiAmount;
            HACHI.safeTransfer(msg.sender, hachiAmount);
        } else {
            hachiAmount = 0;
        }

        if (bonusAmount > 0 && bonusPool >= bonusAmount) {
            bonusPool -= bonusAmount;
            BONUS_TOKEN.safeTransfer(msg.sender, bonusAmount);
        } else {
            bonusAmount = 0;
        }

        emit Claimed(msg.sender, hachiAmount, bonusAmount, lock, lic, wld);
    }

    // --- TIMELOCK EMERGENCIA ------------------------------------
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
        emergencyRequested = false;
        emergencyUnlockTime = 0;
        emit EmergencyCancelled();
    }
}
