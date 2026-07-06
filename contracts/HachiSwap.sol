// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

contract HachiSwap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPermit2Approve public constant PERMIT2 = IPermit2Approve(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IUniversalRouter public constant ROUTER  = IUniversalRouter(0x8ac7bEE993bb44dAb564Ea4bc9EA67Bf9Eb5e743);

    uint8 internal constant V2_SWAP_EXACT_IN = 0x08;
    uint160 internal constant MAX_UINT160 = type(uint160).max;
    uint48  internal constant MAX_UINT48  = type(uint48).max;

    address public immutable HACHI;
    address public immutable WLD;

    address public owner;
    address public worldVerifier;
    mapping(address => bool) public humanVerified;

    uint256 public appFeeBps;
    address public feeCollector;

    event Swapped(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount);
    event UserVerified(address indexed user);
    event ApprovalsSetUp(address token, uint160 amount, uint48 expiration);

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

    function setupApprovals(address token) external onlyOwner {
        require(token == HACHI || token == WLD, "Unsupported token");
        IERC20(token).forceApprove(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(ROUTER), MAX_UINT160, MAX_UINT48);
        emit ApprovalsSetUp(token, MAX_UINT160, MAX_UINT48);
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external nonReentrant onlyHuman returns (uint256 amountOut) {
        require(
            (tokenIn == HACHI && tokenOut == WLD) || (tokenIn == WLD && tokenOut == HACHI),
            "Unsupported pair"
        );
        require(amountIn > 0, "Zero amount");

        PERMIT2.transferFrom(msg.sender, address(this), uint160(amountIn), tokenIn);

        uint256 swapAmount = amountIn;
        uint256 feeAmount = 0;
        if (appFeeBps > 0) {
            feeAmount = (amountIn * appFeeBps) / 10000;
            swapAmount = amountIn - feeAmount;
            IERC20(tokenIn).safeTransfer(feeCollector, feeAmount);
        }

        uint256 balanceBefore = IERC20(tokenOut).balanceOf(msg.sender);

        bytes memory commands = abi.encodePacked(V2_SWAP_EXACT_IN);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(msg.sender, swapAmount, minAmountOut, path, true);

        ROUTER.execute(commands, inputs, deadline);

        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balanceBefore;
        require(amountOut >= minAmountOut, "Slippage: amount out too low");

        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, feeAmount);
    }
}
