// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPermit2Transfer {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IHachiSwapStreak {
    function recordSwap(address user, uint256 hachiAmount) external;
}

contract HachiSwap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPermit2Transfer public constant PERMIT2 = IPermit2Transfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address public constant PAIR = 0xfB461C1EcE675568a1561df75a18d65DDBdc5481;

    address public immutable HACHI;
    address public immutable WLD;

    address public owner;
    address public worldVerifier;
    mapping(address => bool) public humanVerified;

    uint256 public appFeeBps;
    address public feeCollector;
    address public streakContract;

    event Swapped(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount);
    event UserVerified(address indexed user);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyHuman() { require(humanVerified[msg.sender], "World ID required"); _; }

    constructor(address _hachi, address _wld) {
        owner = msg.sender;
        HACHI = _hachi;
        WLD   = _wld;
        feeCollector = msg.sender;
        appFeeBps = 5;
    }

    function transferOwnership(address n) external onlyOwner { owner = n; }
    function setWorldVerifier(address _v) external onlyOwner { worldVerifier = _v; }
    function setStreakContract(address _s) external onlyOwner { streakContract = _s; }
    function setFee(uint256 _bps, address _collector) external onlyOwner {
        require(_bps <= 500, "Fee too high (max 5%)");
        appFeeBps = _bps;
        feeCollector = _collector;
    }

    function setHumanVerified(address user) external {
        require(msg.sender == owner || msg.sender == worldVerifier, "not authorized");
        humanVerified[user] = true;
        emit UserVerified(user);
    }

    function getAmountOut(address tokenIn, uint256 amountIn) public view returns (uint256 amountOut) {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(PAIR).getReserves();
        address token0 = IUniswapV2Pair(PAIR).token0();
        (uint256 reserveIn, uint256 reserveOut) = tokenIn == token0
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));
        require(reserveIn > 0 && reserveOut > 0, "Empty pool");

        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * 1000) + amountInWithFee;
        amountOut = numerator / denominator;
    }

    function _receiveAndTakeFee(address tokenIn, uint256 amountIn) internal returns (uint256 swapAmount, uint256 feeAmount) {
        uint256 balBefore = IERC20(tokenIn).balanceOf(address(this));
        PERMIT2.transferFrom(msg.sender, address(this), uint160(amountIn), tokenIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - balBefore;

        swapAmount = received;
        if (appFeeBps > 0) {
            feeAmount = (received * appFeeBps) / 10000;
            swapAmount = received - feeAmount;
            IERC20(tokenIn).safeTransfer(feeCollector, feeAmount);
        }
    }

    function _sendToPair(address tokenIn, uint256 swapAmount) internal returns (uint256 actualToPair) {
        uint256 pairBalBefore = IERC20(tokenIn).balanceOf(PAIR);
        IERC20(tokenIn).safeTransfer(PAIR, swapAmount);
        actualToPair = IERC20(tokenIn).balanceOf(PAIR) - pairBalBefore;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external nonReentrant onlyHuman returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "Expired");
        require(
            (tokenIn == HACHI && tokenOut == WLD) || (tokenIn == WLD && tokenOut == HACHI),
            "Unsupported pair"
        );
        require(amountIn > 0, "Zero amount");

        (uint256 swapAmount, uint256 feeAmount) = _receiveAndTakeFee(tokenIn, amountIn);
        uint256 actualToPair = _sendToPair(tokenIn, swapAmount);

        uint256 expectedOut = getAmountOut(tokenIn, actualToPair);

        address token0 = IUniswapV2Pair(PAIR).token0();
        (uint256 amount0Out, uint256 amount1Out) = tokenIn == token0
            ? (uint256(0), expectedOut)
            : (expectedOut, uint256(0));

        uint256 userBalBefore = IERC20(tokenOut).balanceOf(msg.sender);
        IUniswapV2Pair(PAIR).swap(amount0Out, amount1Out, msg.sender, new bytes(0));
        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - userBalBefore;

        require(amountOut >= minAmountOut, "Slippage: amount out too low");

        if (tokenOut == HACHI && streakContract != address(0)) {
            try IHachiSwapStreak(streakContract).recordSwap(msg.sender, amountOut) {} catch {}
        }

        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, feeAmount);
    }
}
