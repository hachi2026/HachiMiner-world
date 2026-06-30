// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  HachiRanking v4
//  Solo HACHI - sin SUSHI
//
//  CAMBIO v4: la distribucion ya NO es semanal. El ranking se
//  ejecuta y reparte cada 15 dias (PERIOD = 15 days). Los
//  50,000 HACHI fijos se reparten una vez por periodo de 15 dias.
//
//  POOL POR PERIODO (15 dias):
//  - 50,000 HACHI fijos (owner deposita cada periodo)
//  - + 10% de los HACHI recibidos por ventas ese periodo
//    (acumulado en HachiPools pool4, se transfiere aqui al ejecutar)
//
//  PUNTOS:
//  - Mineria: 1 punto base por SUSHI reclamado x mult. tier lock
//  - Lock: puntos al bloquear y al cobrar APY
//  - Referidos: puntos por cada referido activo
//  - Sin lock: x1 | Tier1: x1.5 | Tier2: x2 | T3: x3 | T4: x4 | T5: x5
//
//  DISTRIBUCION:
//  - Top 10 -> 50% del pool (porcentajes fijos)
//  - Resto  -> 50% proporcional a sus puntos
// ============================================================

interface IHachiLock {
    function getUserTier(address user) external view returns (uint8);
}

interface IHachiPools {
    function payPool4(address user, uint256 amount) external;
    function getPool4Available() external view returns (uint256);
}

contract HachiRanking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable HACHI;

    address public owner;
    address public lockContract;
    address public poolsContract;
    address public minerCore;
    address public referralsContract;

    uint256 public constant EPOCH = 1749340800; // domingo 8 jun 2026 00:00 UTC
    uint256 public constant PERIOD = 15 days;    // distribucion cada 15 dias
    uint256 public constant PERIOD_FIXED = 50_000 * 1e18; // 50k HACHI por periodo

    // Multiplicadores x 10 para evitar decimales
    mapping(uint8 => uint256) public tierMult; // 0=10, 1=15, 2=20, 3=30, 4=40, 5=50

    // Puntos del periodo y totales
    mapping(address => uint256) public periodPoints;
    mapping(address => uint256) public totalPoints;
    address[] public participants;
    mapping(address => bool) public isParticipant;

    // Premios
    mapping(address => uint256) public pendingHachi;
    mapping(address => uint256) public totalHachiWon;

    // Pool del periodo
    uint256 public periodPool;       // HACHI disponibles para el ranking
    uint256 public periodAccrued10;  // 10% acumulado de ventas este periodo

    // Historial
    struct PeriodResult {
        uint256 periodNum;
        uint256 poolTotal;
        uint256 participants_;
        uint256 executedAt;
        bool    executed;
    }
    mapping(uint256 => PeriodResult) public periodHistory;

    // Top 10: porcentajes del 50% del pool (base 1000)
    uint256[10] public topShares;

    event PointsAdded(address indexed user, uint256 base, uint256 multiplied);
    event PeriodExecuted(uint256 periodNum, uint256 pool, uint256 participants_);
    event PrizePaid(address indexed user, uint256 amount, uint256 rank);
    event PrizeClaimed(address indexed user, uint256 amount);
    event PoolFunded(uint256 fixed_, uint256 accrued, uint256 total);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyAuth() {
        require(
            msg.sender == owner || msg.sender == minerCore ||
            msg.sender == lockContract || msg.sender == referralsContract,
            "not authorized"
        );
        _;
    }

    constructor(address _hachi) {
        owner = msg.sender;
        HACHI = IERC20(_hachi);

        tierMult[0] = 10; // sin lock: x1
        tierMult[1] = 15; // bronce:   x1.5
        tierMult[2] = 20; // plata:    x2
        tierMult[3] = 30; // oro:      x3
        tierMult[4] = 40; // rubi:     x4
        tierMult[5] = 50; // diamante: x5

        // Top 10 = 50% del pool (base 1000 sobre ese 50%)
        topShares[0] = 150; // #1  -> 15% total
        topShares[1] = 100; // #2  -> 10%
        topShares[2] =  70; // #3  ->  7%
        topShares[3] =  50; // #4  ->  5%
        topShares[4] =  50; // #5  ->  5%
        topShares[5] =  30; // #6  ->  3%
        topShares[6] =  30; // #7  ->  3%
        topShares[7] =  10; // #8  ->  1%
        topShares[8] =   5; // #9  ->  0.5%
        topShares[9] =   5; // #10 ->  0.5%
    }

    // --- CONFIG ----------------------------------------------
    function setContracts(
        address _lock, address _pools,
        address _core, address _refs
    ) external onlyOwner {
        lockContract      = _lock;
        poolsContract     = _pools;
        minerCore         = _core;
        referralsContract = _refs;
    }
    function setTierMult(uint8 tier, uint256 m) external onlyOwner { tierMult[tier] = m; }
    function setTopShares(uint256[10] calldata s) external onlyOwner {
        uint256 sum = 0;
        for (uint256 i = 0; i < 10; i++) sum += s[i];
        require(sum == 500, "Must sum 500");
        for (uint256 i = 0; i < 10; i++) topShares[i] = s[i];
    }
    function transferOwnership(address n) external onlyOwner { owner = n; }

    // --- AGREGAR PUNTOS --------------------------------------
    function addPoints(address user, uint256 basePoints) external onlyAuth {
        if (user == address(0) || basePoints == 0) return;

        uint8 tier = 0;
        if (lockContract != address(0)) {
            try IHachiLock(lockContract).getUserTier(user) returns (uint8 t) { tier = t; } catch {}
        }

        uint256 multiplied = (basePoints * tierMult[tier]) / 10;
        _addToParticipants(user);
        periodPoints[user] += multiplied;
        totalPoints[user]  += multiplied;
        emit PointsAdded(user, basePoints, multiplied);
    }

    function addPointsDirect(address user, uint256 points) external onlyAuth {
        if (user == address(0) || points == 0) return;
        _addToParticipants(user);
        periodPoints[user] += points;
        totalPoints[user]  += points;
        emit PointsAdded(user, points, points);
    }

    // --- FONDEAR POOL DEL PERIODO -----------------------------
    // Owner deposita los 50k fijos + el 10% acumulado del pool4 de HachiPools
    function fundPeriodPool(uint256 fixedAmount) external onlyOwner {
        HACHI.safeTransferFrom(msg.sender, address(this), fixedAmount);
        periodPool += fixedAmount;

        // Sumar el 10% acumulado del pool4 si hay
        if (periodAccrued10 > 0 && poolsContract != address(0)) {
            uint256 accrued = periodAccrued10;
            periodAccrued10 = 0;
            try IHachiPools(poolsContract).payPool4(address(this), accrued) {
                periodPool += accrued;
                emit PoolFunded(fixedAmount, accrued, periodPool);
            } catch {
                emit PoolFunded(fixedAmount, 0, periodPool);
            }
        } else {
            emit PoolFunded(fixedAmount, 0, periodPool);
        }
    }

    // Registrar el 10% acumulado este periodo (llamado por HachiPools)
    function accruePeriod10(uint256 amount) external {
        require(msg.sender == poolsContract || msg.sender == owner, "not pools");
        periodAccrued10 += amount;
    }

    // --- EJECUTAR RANKING ------------------------------------
    uint256 public constant MAX_RANK_PARTICIPANTS = 100;
    uint256 public lastExecutedAt; // timestamp de la ultima ejecucion

    function executePeriodRanking() external onlyOwner nonReentrant {
        // Solo se puede ejecutar una vez cada 15 dias
        require(block.timestamp >= lastExecutedAt + PERIOD, "Period not finished (15d)");

        uint256 periodNum = getPeriodNumber();
        require(!periodHistory[periodNum].executed, "Already executed");
        require(participants.length > 0, "No participants");
        require(periodPool > 0, "Pool empty");

        // Limitar a MAX_RANK_PARTICIPANTS para evitar gas limit
        uint256 n = participants.length > MAX_RANK_PARTICIPANTS
            ? MAX_RANK_PARTICIPANTS
            : participants.length;
        uint256 pool = periodPool;
        periodPool   = 0;

        // Ordenar por puntos desc
        address[] memory sorted = new address[](n);
        uint256[] memory pts    = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            sorted[i] = participants[i];
            pts[i]    = periodPoints[participants[i]];
        }
        for (uint256 i = 1; i < n; i++) {
            address ka = sorted[i]; uint256 kp = pts[i];
            int256 j = int256(i) - 1;
            while (j >= 0 && pts[uint256(j)] < kp) {
                sorted[uint256(j+1)] = sorted[uint256(j)];
                pts[uint256(j+1)]    = pts[uint256(j)];
                j--;
            }
            sorted[uint256(j+1)] = ka;
            pts[uint256(j+1)]    = kp;
        }

        // Top 10 -> 50% del pool
        uint256 topCount = n < 10 ? n : 10;
        uint256 topPool  = pool / 2;
        uint256 topPaid  = 0;

        for (uint256 rank = 0; rank < topCount; rank++) {
            uint256 prize = (topPool * topShares[rank]) / 500;
            if (prize == 0) continue;
            pendingHachi[sorted[rank]]  += prize;
            totalHachiWon[sorted[rank]] += prize;
            topPaid += prize;
            emit PrizePaid(sorted[rank], prize, rank + 1);
        }

        // Resto -> proporcional a puntos
        uint256 restPool = pool - topPaid;
        uint256 restN    = n > topCount ? n - topCount : 0;
        if (restN > 0 && restPool > 0) {
            uint256 restPts = 0;
            for (uint256 i = topCount; i < n; i++) restPts += pts[i];
            if (restPts > 0) {
                for (uint256 i = topCount; i < n; i++) {
                    uint256 share = (restPool * pts[i]) / restPts;
                    if (share == 0) continue;
                    pendingHachi[sorted[i]]  += share;
                    totalHachiWon[sorted[i]] += share;
                    emit PrizePaid(sorted[i], share, i + 1);
                }
            }
        }

        periodHistory[periodNum] = PeriodResult({
            periodNum:    periodNum,
            poolTotal:    pool,
            participants_: n,
            executedAt:   block.timestamp,
            executed:     true
        });

        lastExecutedAt = block.timestamp;
        _resetPeriod();
        emit PeriodExecuted(periodNum, pool, n);
    }

    // --- CLAIM -----------------------------------------------
    function claimPrize() external nonReentrant {
        uint256 amount = pendingHachi[msg.sender];
        require(amount > 0, "Nothing to claim");
        pendingHachi[msg.sender] = 0;
        HACHI.safeTransfer(msg.sender, amount);
        emit PrizeClaimed(msg.sender, amount);
    }

    // --- VISTAS ----------------------------------------------
    // Numero de periodo de 15 dias desde el EPOCH
    function getPeriodNumber() public view returns (uint256) {
        if (block.timestamp < EPOCH) return 1;
        return ((block.timestamp - EPOCH) / PERIOD) + 1;
    }

    // Segundos restantes para poder ejecutar el siguiente reparto
    function timeUntilNextExecution() external view returns (uint256) {
        uint256 next = lastExecutedAt + PERIOD;
        if (block.timestamp >= next) return 0;
        return next - block.timestamp;
    }

    function getCurrentRanking() external view returns (
        address[] memory ranked,
        uint256[] memory points,
        uint256[] memory estimated,
        uint8[]   memory tiers
    ) {
        uint256 n = participants.length;
        ranked    = new address[](n);
        points    = new uint256[](n);
        estimated = new uint256[](n);
        tiers     = new uint8[](n);

        for (uint256 i = 0; i < n; i++) {
            ranked[i] = participants[i];
            points[i] = periodPoints[participants[i]];
            if (lockContract != address(0)) {
                try IHachiLock(lockContract).getUserTier(participants[i]) returns (uint8 t) { tiers[i] = t; } catch {}
            }
        }
        // Sort
        for (uint256 i = 1; i < n; i++) {
            address ka = ranked[i]; uint256 kp = points[i]; uint8 kt = tiers[i];
            int256 j = int256(i) - 1;
            while (j >= 0 && points[uint256(j)] < kp) {
                ranked[uint256(j+1)] = ranked[uint256(j)];
                points[uint256(j+1)] = points[uint256(j)];
                tiers[uint256(j+1)]  = tiers[uint256(j)];
                j--;
            }
            ranked[uint256(j+1)] = ka; points[uint256(j+1)] = kp; tiers[uint256(j+1)] = kt;
        }
        // Estimar premios
        if (periodPool > 0) {
            uint256 top = n < 10 ? n : 10;
            uint256 tp  = periodPool / 2;
            for (uint256 r = 0; r < top; r++) estimated[r] = (tp * topShares[r]) / 500;
            uint256 rp = periodPool - tp; uint256 rPts = 0;
            for (uint256 i = top; i < n; i++) rPts += points[i];
            if (rPts > 0) for (uint256 i = top; i < n; i++) estimated[i] = (rp * points[i]) / rPts;
        }
    }

    function getUserStats(address user) external view returns (
        uint256 period, uint256 total,
        uint256 pending, uint256 won, uint8 tier, uint256 mult
    ) {
        uint8 t = 0;
        if (lockContract != address(0)) {
            try IHachiLock(lockContract).getUserTier(user) returns (uint8 _t) { t = _t; } catch {}
        }
        return (periodPoints[user], totalPoints[user], pendingHachi[user], totalHachiWon[user], t, tierMult[t]);
    }

    // --- INTERNOS --------------------------------------------
    function _addToParticipants(address user) internal {
        if (!isParticipant[user]) {
            participants.push(user);
            isParticipant[user] = true;
        }
    }

    function _resetPeriod() internal {
        for (uint256 i = 0; i < participants.length; i++) {
            periodPoints[participants[i]] = 0;
            isParticipant[participants[i]] = false;
        }
        delete participants;
    }

    // --- TIMELOCK PARA EMERGENCIAS ----------------------------
    uint256 public constant EMERGENCY_DELAY = 48 hours;
    uint256 public emergencyUnlockTime;
    bool    public emergencyRequested;

    event EmergencyRequested(uint256 unlockTime);
    event EmergencyExecuted(address token, uint256 amount);
    event EmergencyCancelled();

    /// @notice Paso 1: el owner solicita la emergencia.
    ///         El retiro queda bloqueado 48h para que los usuarios puedan reaccionar.
    function requestEmergency() external onlyOwner {
        require(!emergencyRequested, "Already requested");
        emergencyUnlockTime  = block.timestamp + EMERGENCY_DELAY;
        emergencyRequested   = true;
        emit EmergencyRequested(emergencyUnlockTime);
    }

    /// @notice Paso 2: ejecutar solo despues de las 48h.
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        require(emergencyRequested, "Not requested");
        require(block.timestamp >= emergencyUnlockTime, "Timelock active");
        emergencyRequested = false;
        IERC20(token).safeTransfer(owner, amount);
        emit EmergencyExecuted(token, amount);
    }

    /// @notice El owner puede cancelar la solicitud de emergencia.
    function cancelEmergency() external onlyOwner {
        require(emergencyRequested, "Nothing to cancel");
        emergencyRequested = false;
        emergencyUnlockTime = 0;
        emit EmergencyCancelled();
    }

}
