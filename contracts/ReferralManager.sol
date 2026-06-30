// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  ReferralManager v2
//  World Chain
//
//  MECANICA:
//  - Usuario A comparte su wallet como codigo de referido
//  - Usuario B se registra con la wallet de A como referidor
//  - Ambos reciben HACHI al momento del registro
//  - Puntos al ranking para ambos
//  - Solo usuarios World ID verificados
//  - Un usuario solo puede registrarse una vez con un referido
//  - No se puede referir a uno mismo
//
//  RECOMPENSAS (v2):
//  - Al registrarse: referidor recibe 500 HACHI
//  - Al registrarse: referido  recibe 500 HACHI
//  - Halving UNICO a 1M de registros: 500 -> 250 (permanente)
// ============================================================

interface IHachiRanking {
    function addPoints(address user, uint256 points) external;
}

contract ReferralManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20  public immutable HACHI;
    address public owner;
    address public minerCore;       // para verificar humanVerified
    address public rankingContract;

    // --- CONSTANTES ------------------------------------------
    // Bono base 500 HACHI a cada parte. Halving UNICO a 1M de registros.
    uint256 public constant BASE_REF_BONUS   = 500 * 1e18;  // 500 al referidor
    uint256 public constant BASE_NEW_BONUS   = 500 * 1e18;  // 500 al nuevo usuario
    uint256 public constant HALVING_THRESHOLD = 1_000_000;  // un solo halving a 1M registros

    // --- ESTADO ----------------------------------------------
    // user -> su referidor (address(0) si no tiene)
    mapping(address => address)   public referrerOf;
    // user -> lista de sus referidos
    mapping(address => address[]) public referralsOf;
    // user -> cantidad de referidos activos
    mapping(address => uint256)   public referralCount;
    // user -> HACHI ganados por referidos
    mapping(address => uint256)   public hachiEarnedByRefs;
    // user -> esta registrado en el sistema
    mapping(address => bool)      public registered;
    // Usuarios verificados World ID (sync desde HachiMinerCore)
    mapping(address => bool)      public humanVerified;

    // Pool de HACHI para bonos (fondeado por owner)
    uint256 public hachiPool;

    // Stats
    uint256 public totalReferrals;
    uint256 public totalHachiPaid;

    // --- EVENTS ----------------------------------------------
    event Registered(address indexed user, address indexed referrer);
    event ReferralBonus(address indexed referrer, address indexed referee, uint256 hachiToRef, uint256 hachiToNew);
    event PoolFunded(uint256 amount, uint256 newTotal);
    event UserVerified(address indexed user);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyCore()  { require(msg.sender == minerCore || msg.sender == owner, "not authorized"); _; }
    modifier onlyHuman() { require(humanVerified[msg.sender], "World ID required"); _; }

    constructor(address _hachi) {
        owner = msg.sender;
        HACHI = IERC20(_hachi);
    }

    // --- HALVING UNICO ---------------------------------------
    // Antes de 1M registros: bono completo. Despues: mitad permanente.
    function _halved(uint256 v) internal view returns (uint256) {
        return totalReferrals >= HALVING_THRESHOLD ? v / 2 : v;
    }
    function currentRefBonus() public view returns (uint256) { return _halved(BASE_REF_BONUS); }
    function currentNewBonus() public view returns (uint256) { return _halved(BASE_NEW_BONUS); }

    // --- CONFIG ----------------------------------------------
    function setMinerCore(address _c) external onlyOwner { minerCore = _c; }
    function setRanking(address _r) external onlyOwner { rankingContract = _r; }
    function transferOwnership(address n) external onlyOwner { owner = n; }

    /// @notice Sincronizar verificacion World ID desde HachiMinerCore
    function setHumanVerified(address user) external onlyCore {
        humanVerified[user] = true;
        // Auto-registrar sin referidor si no esta registrado
        if (!registered[user]) {
            registered[user] = true;
        }
        emit UserVerified(user);
    }

    // --- FONDEAR POOL -----------------------------------------
    function fundPool(uint256 amount) external onlyOwner {
        HACHI.safeTransferFrom(msg.sender, address(this), amount);
        hachiPool += amount;
        emit PoolFunded(amount, hachiPool);
    }

    // --- REGISTRAR CON REFERIDO -------------------------------
    /// @notice El nuevo usuario se registra indicando la wallet de quien lo refirio
    /// @param referrer Direccion de la wallet del referidor
    function registerWithReferral(address referrer) external nonReentrant {
        address newUser = msg.sender;

        require(referrer != address(0),  "Invalid referrer");
        require(referrer != newUser,     "Cannot refer yourself");
        require(referrerOf[newUser] == address(0), "Already registered with referral");

        // Registrar la relacion
        referrerOf[newUser]   = referrer;
        referralsOf[referrer].push(newUser);
        referralCount[referrer]++;
        registered[newUser] = true;
        totalReferrals++;

        // Calcular bonos con halving vigente
        uint256 refBonus = currentRefBonus();
        uint256 newBonus = currentNewBonus();
        uint256 totalNeeded = refBonus + newBonus;

        // Pagar bonos si el pool tiene fondos
        if (hachiPool >= totalNeeded) {
            hachiPool   -= totalNeeded;
            totalHachiPaid += totalNeeded;
            hachiEarnedByRefs[referrer] += refBonus;

            // Pagar al referidor
            HACHI.safeTransfer(referrer, refBonus);
            // Pagar al nuevo usuario
            HACHI.safeTransfer(newUser, newBonus);

            emit ReferralBonus(referrer, newUser, refBonus, newBonus);
        }

        // Puntos al ranking para ambos
        if (rankingContract != address(0)) {
            try IHachiRanking(rankingContract).addPoints(referrer, refBonus / 1e18) {} catch {}
            try IHachiRanking(rankingContract).addPoints(newUser,  newBonus / 1e18) {} catch {}
        }

        emit Registered(newUser, referrer);
    }

    // --- VISTAS ----------------------------------------------

    /// @notice Info completa de referidos de un usuario
    function getReferralInfo(address user) external view returns (
        address referrer,
        uint256 totalRefs,
        uint256 hachiEarned,
        address[] memory refs
    ) {
        return (
            referrerOf[user],
            referralCount[user],
            hachiEarnedByRefs[user],
            referralsOf[user]
        );
    }

    /// @notice Verifica si un usuario puede registrarse con referido
    function canRegister(address user, address referrer) external view returns (
        bool eligible,
        string memory reason
    ) {
        if (referrerOf[user] != address(0))
            return (false, "Already registered with referral");
        if (referrer == user)
            return (false, "Cannot refer yourself");
        return (true, "");
    }

    function getStats() external view returns (
        uint256 totalRefs,
        uint256 hachiDistributed,
        uint256 poolBalance
    ) {
        return (totalReferrals, totalHachiPaid, hachiPool);
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
