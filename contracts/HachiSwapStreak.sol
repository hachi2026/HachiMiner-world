// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract HachiSwapStreak is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable SUSHI;

    address public owner;
    address public verifier;

    mapping(address => bool) public whitelisted;
    mapping(address => uint8) public currentDay;
    mapping(address => uint256) public lastCreditedAt;

    uint256 public constant CYCLE_COOLDOWN = 20 hours;

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

    event Whitelisted(address indexed user, bool status);
    event DayCredited(address indexed user, uint8 day, uint256 amount);
    event CycleCompleted(address indexed user);
    event CycleReset(address indexed user);
    event StreakBroken(address indexed user);
    event PoolFunded(uint256 amount, uint256 newTotal);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyVerifier() { require(msg.sender == owner || msg.sender == verifier, "not authorized"); _; }

    constructor(address _sushi) {
        owner = msg.sender;
        SUSHI = IERC20(_sushi);
    }

    function transferOwnership(address n) external onlyOwner { owner = n; }
    function setVerifier(address _v) external onlyOwner { verifier = _v; }

    function setWhitelist(address user, bool status) external onlyOwner {
        whitelisted[user] = status;
        emit Whitelisted(user, status);
    }

    function setWhitelistBatch(address[] calldata users, bool status) external onlyOwner {
        for (uint256 i = 0; i < users.length; i++) {
            whitelisted[users[i]] = status;
            emit Whitelisted(users[i], status);
        }
    }

    function setDayAmounts(uint256[7] calldata amounts) external onlyOwner {
        dayAmounts = amounts;
    }

    function fundPool(uint256 amount) external onlyOwner {
        SUSHI.safeTransferFrom(msg.sender, address(this), amount);
        streakSushiPool += amount;
        emit PoolFunded(amount, streakSushiPool);
    }

    function resetCycle(address user) external onlyOwner {
        currentDay[user] = 0;
        emit CycleReset(user);
    }

    uint256 public constant STREAK_BREAK_WINDOW = 48 hours;

    function creditDay(address user) external onlyVerifier nonReentrant {
        require(whitelisted[user], "Not whitelisted");
        require(block.timestamp >= lastCreditedAt[user] + CYCLE_COOLDOWN, "Already credited recently");

        uint8 day = currentDay[user];
        bool wasBroken = false;
        if (day != 0 && block.timestamp > lastCreditedAt[user] + STREAK_BREAK_WINDOW) {
            day = 1;
            wasBroken = true;
        }
        if (day == 0 || day > 7) day = 1;

        uint256 amount = dayAmounts[day - 1];
        require(streakSushiPool >= amount, "Pool empty");

        streakSushiPool -= amount;
        lastCreditedAt[user] = block.timestamp;

        if (wasBroken) emit StreakBroken(user);

        if (day == 7) {
            currentDay[user] = 0;
            emit CycleCompleted(user);
        } else {
            currentDay[user] = day + 1;
        }

        SUSHI.safeTransfer(user, amount);
        emit DayCredited(user, day, amount);
    }

    function getStatus(address user) external view returns (
        bool isWhitelisted, uint8 dayNow, uint256 nextAmount, uint256 secondsUntilNextCredit
    ) {
        isWhitelisted = whitelisted[user];
        uint8 day = currentDay[user];
        if (day != 0 && block.timestamp > lastCreditedAt[user] + STREAK_BREAK_WINDOW) {
            day = 1;
        }
        if (day == 0 || day > 7) day = 1;
        dayNow = day;
        nextAmount = dayAmounts[day - 1];
        uint256 next = lastCreditedAt[user] + CYCLE_COOLDOWN;
        secondsUntilNextCredit = block.timestamp >= next ? 0 : next - block.timestamp;
    }
}
