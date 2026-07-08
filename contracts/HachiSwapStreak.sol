// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract HachiSwapStreak is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable SUSHI;

    address public owner;
    address public worldVerifier;
    address public hachiSwap;

    mapping(address => bool) public humanVerified;

    uint256 public constant MIN_SWAPS = 5;
    uint256 public constant MIN_VOLUME = 500 * 1e18;

    mapping(address => mapping(uint256 => uint256)) public dailySwapCount;
    mapping(address => mapping(uint256 => uint256)) public dailyVolume;

    mapping(address => uint256) public totalHachiBought;
    mapping(address => uint256) public periodHachiBought;
    address[] public participants;
    mapping(address => bool) public isParticipant;

    IERC20 public rewardToken;
    uint256 public rewardPool;
    uint256 public constant RANKING_PERIOD = 15 days;
    uint256 public lastRankingExecutedAt;
    uint256 public constant TOP_N = 20;
    uint256[20] public topShares = [
        uint256(1433), 980, 784, 669, 592, 535, 492, 457, 428, 404,
        384, 366, 350, 336, 323, 312, 302, 293, 284, 276
    ];

    uint256 public constant CYCLE_COOLDOWN = 20 hours;
    uint256 public constant STREAK_BREAK_WINDOW = 48 hours;
    mapping(address => uint8) public currentDay;
    mapping(address => uint256) public lastCreditedAt;

    uint256[7] public dayAmounts = [
        uint256(1000 * 1e18),
        uint256(1200 * 1e18),
        uint256(1500 * 1e18),
        uint256(1600 * 1e18),
        uint256(1800 * 1e18),
        uint256(2000 * 1e18),
        uint256(10000 * 1e18)
    ];

    uint256 public streakSushiPool;

    event UserVerified(address indexed user);
    event PoolFunded(uint256 amount, uint256 newTotal);
    event DayCredited(address indexed user, uint8 day, uint256 amount);
    event CycleCompleted(address indexed user);
    event StreakBroken(address indexed user);
    event RewardTokenSet(address token);
    event RewardPoolFunded(uint256 amount, uint256 newTotal);
    event SwapRankingExecuted(uint256 pool, uint256 participantsCount);
    event SwapRankingPrizePaid(address indexed user, uint256 amount, uint256 rank);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyHuman() { require(humanVerified[msg.sender], "World ID required"); _; }
    modifier onlyHachiSwap() { require(msg.sender == hachiSwap, "not authorized"); _; }

    constructor(address _sushi) {
        owner = msg.sender;
        SUSHI = IERC20(_sushi);
    }

    function transferOwnership(address n) external onlyOwner { owner = n; }
    function setWorldVerifier(address _v) external onlyOwner { worldVerifier = _v; }
    function setHachiSwap(address _s) external onlyOwner { hachiSwap = _s; }
    function setDayAmounts(uint256[7] calldata amounts) external onlyOwner { dayAmounts = amounts; }

    function setRewardToken(address _t) external onlyOwner {
        rewardToken = IERC20(_t);
        emit RewardTokenSet(_t);
    }

    function setTopShares(uint256[20] calldata s) external onlyOwner {
        uint256 sum = 0;
        for (uint256 i = 0; i < 20; i++) sum += s[i];
        require(sum == 10000, "Must sum 10000");
        topShares = s;
    }

    function fundRewardPool(uint256 amount) external onlyOwner {
        require(address(rewardToken) != address(0), "Set reward token first");
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        rewardPool += amount;
        emit RewardPoolFunded(amount, rewardPool);
    }

    function setHumanVerified(address user) external {
        require(msg.sender == owner || msg.sender == worldVerifier, "not authorized");
        humanVerified[user] = true;
        emit UserVerified(user);
    }

    function fundPool(uint256 amount) external onlyOwner {
        SUSHI.safeTransferFrom(msg.sender, address(this), amount);
        streakSushiPool += amount;
        emit PoolFunded(amount, streakSushiPool);
    }

    function _today() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function recordSwap(address user, uint256 hachiAmount) external onlyHachiSwap {
        uint256 day = _today();
        dailySwapCount[user][day] += 1;
        dailyVolume[user][day] += hachiAmount;

        totalHachiBought[user] += hachiAmount;
        periodHachiBought[user] += hachiAmount;
        if (!isParticipant[user]) {
            participants.push(user);
            isParticipant[user] = true;
        }
    }

    function getTodayProgress(address user) external view returns (
        uint256 swaps, uint256 volume, bool missionDone, uint8 dayNow, uint256 nextAmount, bool canClaimNow
    ) {
        uint256 day = _today();
        swaps = dailySwapCount[user][day];
        volume = dailyVolume[user][day];
        missionDone = swaps >= MIN_SWAPS && volume >= MIN_VOLUME;

        uint8 d = currentDay[user];
        if (d != 0 && block.timestamp > lastCreditedAt[user] + STREAK_BREAK_WINDOW) d = 1;
        if (d == 0 || d > 7) d = 1;
        dayNow = d;
        nextAmount = dayAmounts[d - 1];
        canClaimNow = missionDone && block.timestamp >= lastCreditedAt[user] + CYCLE_COOLDOWN;
    }

    function getRanking() external view returns (address[] memory addrs, uint256[] memory amounts) {
        uint256 n = participants.length;
        addrs = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            addrs[i] = participants[i];
            amounts[i] = periodHachiBought[participants[i]];
        }
        for (uint256 i = 1; i < n; i++) {
            address ka = addrs[i]; uint256 va = amounts[i];
            int256 j = int256(i) - 1;
            while (j >= 0 && amounts[uint256(j)] < va) {
                addrs[uint256(j+1)] = addrs[uint256(j)];
                amounts[uint256(j+1)] = amounts[uint256(j)];
                j--;
            }
            addrs[uint256(j+1)] = ka;
            amounts[uint256(j+1)] = va;
        }
    }

    function timeUntilNextRanking() external view returns (uint256) {
        uint256 next = lastRankingExecutedAt + RANKING_PERIOD;
        if (block.timestamp >= next) return 0;
        return next - block.timestamp;
    }

    function executeSwapRanking() external onlyOwner nonReentrant {
        require(block.timestamp >= lastRankingExecutedAt + RANKING_PERIOD, "Period not finished");
        require(address(rewardToken) != address(0), "No reward token set");
        require(rewardPool > 0, "Pool empty");
        uint256 n = participants.length;
        require(n > 0, "No participants");

        address[] memory sorted = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            sorted[i] = participants[i];
            amounts[i] = periodHachiBought[participants[i]];
        }
        for (uint256 i = 1; i < n; i++) {
            address ka = sorted[i]; uint256 va = amounts[i];
            int256 j = int256(i) - 1;
            while (j >= 0 && amounts[uint256(j)] < va) {
                sorted[uint256(j+1)] = sorted[uint256(j)];
                amounts[uint256(j+1)] = amounts[uint256(j)];
                j--;
            }
            sorted[uint256(j+1)] = ka;
            amounts[uint256(j+1)] = va;
        }

        uint256 pool = rewardPool;
        rewardPool = 0;
        uint256 top = n < TOP_N ? n : TOP_N;
        for (uint256 rank = 0; rank < top; rank++) {
            uint256 prize = (pool * topShares[rank]) / 10000;
            if (prize == 0) continue;
            rewardToken.safeTransfer(sorted[rank], prize);
            emit SwapRankingPrizePaid(sorted[rank], prize, rank + 1);
        }

        for (uint256 i = 0; i < n; i++) {
            periodHachiBought[participants[i]] = 0;
            isParticipant[participants[i]] = false;
        }
        delete participants;

        lastRankingExecutedAt = block.timestamp;
        emit SwapRankingExecuted(pool, n);
    }

    function claimStreakBonus() external nonReentrant onlyHuman {
        uint256 today = _today();
        require(dailySwapCount[msg.sender][today] >= MIN_SWAPS, "No cumpliste los 5 swaps de hoy");
        require(dailyVolume[msg.sender][today] >= MIN_VOLUME, "No cumpliste el volumen de hoy");
        require(block.timestamp >= lastCreditedAt[msg.sender] + CYCLE_COOLDOWN, "Ya reclamaste hoy");

        uint8 day = currentDay[msg.sender];
        bool wasBroken = false;
        if (day != 0 && block.timestamp > lastCreditedAt[msg.sender] + STREAK_BREAK_WINDOW) {
            day = 1;
            wasBroken = true;
        }
        if (day == 0 || day > 7) day = 1;

        uint256 amount = dayAmounts[day - 1];
        require(streakSushiPool >= amount, "Pool empty");

        streakSushiPool -= amount;
        lastCreditedAt[msg.sender] = block.timestamp;

        if (wasBroken) emit StreakBroken(msg.sender);

        if (day == 7) {
            currentDay[msg.sender] = 0;
            emit CycleCompleted(msg.sender);
        } else {
            currentDay[msg.sender] = day + 1;
        }

        SUSHI.safeTransfer(msg.sender, amount);
        emit DayCredited(msg.sender, day, amount);
    }
}
