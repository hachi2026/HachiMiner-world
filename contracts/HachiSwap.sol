// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  HachiSwap
//  World Chain
//
//  Permite intercambiar HACHI <-> WLD usando la liquidez REAL que
//  ya existe en Uniswap (par V2, confirmado con reservas reales).
//  No crea pools propios — enruta a traves del Universal Router
//  oficial de Uniswap en World Chain.
//
//  Flujo:
//  1. El usuario aprueba a ESTE contrato (approve clasico, igual que
//     el resto de la app) y llama a swap().
//  2. Este contrato ya tiene, desde un setup unico hecho por el
//     owner, permiso via Permit2 para pagarle al Universal Router
//     con su propio balance — el usuario nunca interactua con
//     Permit2 directamente.
//  3. El Universal Router ejecuta el swap V2 real contra el pool de
//     Uniswap y manda el resultado directo a la wallet del usuario.
//
//  Gate onlyHuman: solo humanos verificados con World ID pueden
//  usar el swap.
// ============================================================

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

contract HachiSwap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Direcciones oficiales de Uniswap en World Chain
    IPermit2Approve public constant PERMIT2 = IPermit2Approve(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IUniversalRouter public constant ROUTER  = IUniversalRouter(0x8ac7bEE993bb44dAb564Ea4bc9EA67Bf9Eb5e743);

    // Comando V2_SWAP_EXACT_IN del Universal Router
    uint8 internal constant V2_SWAP_EXACT_IN = 0x08;
    // Maximo valor de uint160 / uint48, para aprobaciones "infinitas" a Permit2
    uint160 internal constant MAX_UINT160 = type(uint160).max;
    uint48  internal constant MAX_UINT48  = type(uint48).max;

    address public immutable HACHI;
    address public immutable WLD;

    address public owner;
    address public worldVerifier;
    mapping(address => bool) public humanVerified;

    // Fee propio de la app sobre cada swap (en basis points, 10000 = 100%)
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
        appFeeBps = 5; // 0.05% de entrada, ajustable despues con setFee()
    }

    // --- CONFIG ---------------------------------------------------
    function transferOwnership(address n) external onlyOwner { owner = n; }
    function setWorldVerifier(address _v) external onlyOwner { worldVerifier = _v; }
    function setFee(uint256 _bps, address _collector) external onlyOwner {
        require(_bps <= 500, "Fee too high (max 5%)");
        appFeeBps = _bps;
        feeCollector = _collector;
    }

    /// @notice Sincronizar verificacion World ID (v4, verificado off-chain
    /// por el backend, via worldVerifier).
    function setHumanVerified(address user) external {
        require(msg.sender == owner || msg.sender == worldVerifier, "not authorized");
        humanVerified[user] = true;
        emit UserVerified(user);
    }

    /// @notice Setup unico (owner): le da permiso a Permit2 sobre el balance
    /// de ESTE contrato, y a su vez le da permiso a Permit2 para que el
    /// Universal Router pueda gastar ese balance. No lo llama el usuario,
    /// es configuracion de infraestructura, se corre una vez por token
    /// (o de nuevo si la aprobacion de Permit2 expira).
    function setupApprovals(address token) external onlyOwner {
        require(token == HACHI || token == WLD, "Unsupported token");
        IERC20(token).forceApprove(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(ROUTER), MAX_UINT160, MAX_UINT48);
        emit ApprovalsSetUp(token, MAX_UINT160, MAX_UINT48);
    }

    // --- SWAP -------------------------------------------------------
    /// @param tokenIn HACHI o WLD
    /// @param tokenOut el otro de los dos
    /// @param amountIn cuanto manda el usuario
    /// @param minAmountOut minimo aceptable de salida (proteccion de slippage)
    /// @param deadline timestamp limite para que la transaccion sea valida
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

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

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
