// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  HachiWeeklyBonus
//  World Chain
//
//  Bono semanal en SUSHI, combinando 2 fuentes (se calculan
//  en vivo, sin historial exacto de cuando cambio cada una):
//
//   1) 100 SUSHI/dia por cada WLD invertido en licencias
//      WLD ACTIVAS (HachiMinerCore, compartido entre v1 y v2).
//   2) Bono fijo diario si tenes una mineria de Drachma ACTIVA
//      ahora mismo (HachiDrachmaMiner), segun tu tier:
//        Basica:250 Estandar:500 Premium:750 Elite:1000
//
//  Se acumula hasta un tope de 7 dias (configurable). Para
//  reclamar en el caso normal hay que esperar el cooldown de
//  7 dias desde el ultimo reclamo. Si la tasa combinada cae a
//  CERO (ni licencia WLD activa, ni mineria Drachma activa),
//  se puede reclamar el saldo acumulado antes, sin esperar el
//  cooldown — pero hay una ventana de gracia de 3 dias desde
//  el ultimo reclamo para hacerlo, si no, se pierde el saldo
//  y el reloj se reinicia sin pagar nada. El PRIMER reclamo de
//  cada usuario ya paga de inmediato (se trata como si ya
//  hubiera pasado un ciclo completo).
// ============================================================

interface IHachiMinerCoreView {
    function getUserWLDLics(address user) external view returns (uint256[] memory);
    function wldLics(uint256 id) external view returns (
        address owner_, uint8 wldType, uint256 wldPrice, uint256 hachiTotal,
        uint256 hachiPerSec, uint256 hachiClaimed, uint256 startTime, uint256 endTime,
        uint256 lastHachiClaim, uint256 hachiCommitted, bool active, bool matured
    );
}

interface IHachiDrachmaMinerView {
    function activeMineId(address user) external view returns (uint256);
    function mines(uint256 id) external view returns (
        address owner_, uint8 tier, uint256 hachiPaid, uint256 drachmaTotal,
        uint256 drachmaClaimed, uint256 drachmaPerSec, uint256 startTime,
        uint256 endTime, uint256 lastClaim, bool active
    );
}

contract HachiWeeklyBonus is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable SUSHI;

    address public owner;
    address public worldVerifier;
    mapping(address => bool) public humanVerified;

    address public minerCore;
    address public drachmaMinerContract;

    uint256 public wldDailyRatePerWld = 100 * 1e18; // 100 SUSHI/dia por WLD invertido
    uint256[4] public drachmaTierDailyBonus = [
        uint256(250 * 1e18), 500 * 1e18, 750 * 1e18, 1000 * 1e18
    ];

    uint256 public cycleDuration = 7 days;
    uint256 public graceWindow = 3 days;

    mapping(address => uint256) public lastActionTime; // 0 = nunca arranco

    uint256 public sushiPool;

    event CycleStarted(address indexed user);
    event BonusClaimed(address indexed user, uint256 amount);
    event BonusForfeited(address indexed user);
    event PoolFunded(uint256 amount, uint256 newTotal);
    event UserVerified(address indexed user);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyHuman() { require(humanVerified[msg.sender], "World ID required"); _; }

    constructor(address _sushi, address _minerCore, address _drachmaMinerContract) {
        owner = msg.sender;
        SUSHI = IERC20(_sushi);
        minerCore = _minerCore;
        drachmaMinerContract = _drachmaMinerContract;
    }

    // --- CONFIG ---------------------------------------------------
    function transferOwnership(address n) external onlyOwner { owner = n; }
    function setWorldVerifier(address _v) external onlyOwner { worldVerifier = _v; }
    function setMinerCore(address _c) external onlyOwner { minerCore = _c; }
    function setDrachmaMinerContract(address _d) external onlyOwner { drachmaMinerContract = _d; }
    function setWldDailyRatePerWld(uint256 _rate) external onlyOwner { wldDailyRatePerWld = _rate; }
    function setDrachmaTierDailyBonus(uint256[4] calldata amounts) external onlyOwner { drachmaTierDailyBonus = amounts; }
    function setCycleDuration(uint256 _seconds) external onlyOwner { require(_seconds > 0, "must be > 0"); cycleDuration = _seconds; }
    function setGraceWindow(uint256 _seconds) external onlyOwner { graceWindow = _seconds; }

    function setHumanVerified(address user) external {
        require(msg.sender == owner || msg.sender == worldVerifier, "not authorized");
        humanVerified[user] = true;
        emit UserVerified(user);
    }

    function fundPool(uint256 amount) external onlyOwner {
        SUSHI.safeTransferFrom(msg.sender, address(this), amount);
        sushiPool += amount;
        emit PoolFunded(amount, sushiPool);
    }

    // --- FUENTE 1: WLD invertido en licencias activas ---------------
    function getWldInvested(address user) public view returns (uint256 total) {
        if (minerCore == address(0)) return 0;
        uint256[] memory ids;
        try IHachiMinerCoreView(minerCore).getUserWLDLics(user) returns (uint256[] memory r) { ids = r; } catch { return 0; }
        for (uint256 i = 0; i < ids.length; i++) {
            try IHachiMinerCoreView(minerCore).wldLics(ids[i]) returns (
                address, uint8, uint256 wldPrice, uint256, uint256, uint256,
                uint256, uint256 endTime, uint256, uint256, bool active, bool
            ) {
                if (active && endTime > block.timestamp) total += wldPrice;
            } catch {}
        }
    }

    // --- FUENTE 2: bono fijo si tiene mineria de Drachma activa -----
    function getDrachmaBonus(address user) public view returns (uint256) {
        if (drachmaMinerContract == address(0)) return 0;
        uint256 mineId;
        try IHachiDrachmaMinerView(drachmaMinerContract).activeMineId(user) returns (uint256 r) { mineId = r; } catch { return 0; }
        if (mineId == 0) return 0;
        try IHachiDrachmaMinerView(drachmaMinerContract).mines(mineId) returns (
            address, uint8 tier, uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool active
        ) {
            if (!active || tier > 3) return 0;
            return drachmaTierDailyBonus[tier];
        } catch { return 0; }
    }

    /// @notice Tasa combinada actual, en SUSHI por dia.
    function getDailyRate(address user) public view returns (uint256) {
        return (getWldInvested(user) * wldDailyRatePerWld) / 1e18 + getDrachmaBonus(user);
    }

    /// @notice Cuanto se llevaria si reclamara ahora mismo (0 si no corresponde todavia).
    function previewClaim(address user) external view returns (uint256) {
        uint256 last = lastActionTime[user];
        bool firstTime = (last == 0);
        uint256 effectiveLast = firstTime ? block.timestamp - cycleDuration : last;
        uint256 elapsed = block.timestamp - effectiveLast;
        uint256 rate = getDailyRate(user);
        bool cooldownDone = elapsed >= cycleDuration;
        bool rateIsZero = rate == 0;
        bool expiredPastGrace = !firstTime && elapsed > cycleDuration + graceWindow;
        if (expiredPastGrace) return 0;
        if (!cooldownDone && !rateIsZero) return 0;
        uint256 cappedElapsed = elapsed > cycleDuration ? cycleDuration : elapsed;
        return (rate * cappedElapsed) / 1 days;
    }

    // --- RECLAMAR -------------------------------------------------
    function claimBonus() external nonReentrant {
        uint256 last = lastActionTime[msg.sender];
        bool firstTime = (last == 0);
        uint256 effectiveLast = firstTime ? block.timestamp - cycleDuration : last;

        uint256 elapsed = block.timestamp - effectiveLast;
        uint256 currentRate = getDailyRate(msg.sender);
        bool cooldownDone = elapsed >= cycleDuration;
        bool rateIsZero = currentRate == 0;
        bool expiredPastGrace = !firstTime && elapsed > cycleDuration + graceWindow;

        if (expiredPastGrace) {
            lastActionTime[msg.sender] = block.timestamp;
            emit BonusForfeited(msg.sender);
            return;
        }

        require(cooldownDone || rateIsZero, "Todavia no se puede reclamar");

        uint256 cappedElapsed = elapsed > cycleDuration ? cycleDuration : elapsed;
        uint256 amount = (currentRate * cappedElapsed) / 1 days;
        require(amount > 0, "Nada para reclamar");
        require(sushiPool >= amount, "Pool insuficiente");

        sushiPool -= amount;
        lastActionTime[msg.sender] = block.timestamp;

        SUSHI.safeTransfer(msg.sender, amount);
        emit BonusClaimed(msg.sender, amount);
    }
}
