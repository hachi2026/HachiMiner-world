// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  HachiVipHolders
//  World Chain
//
//  Exclusivo para holders de Lock con 250,000+ HACHI lockeados.
//  Cambian el HACHI que van generando por APY (calculado en vivo
//  desde el propio contrato de Lock) por Drachma o SUSHI, con un
//  bono segun su nivel. El HACHI pagado financia licencias WLD
//  (va directo a PoolWLD).
//
//  Niveles (segun HACHI total lockeado):
//    250,000 - 499,999:  5% de bono
//    500,000 - 749,999:  8% de bono
//    750,000 - 999,999: 10% de bono
//    1,000,000+:         12% de bono
//
//  Se acumula por segundo (usando el HACHI/seg real de tu Lock),
//  con un tope de 4 semanas. Podes usarlo cuando quieras, sin
//  perder nada mientras no lo uses (topeado, no se pierde).
//  Elegis Drachma o SUSHI; si ese pool no tiene fondos, usa el
//  otro automaticamente.
// ============================================================

interface IHachiLockView {
    function positions(address user) external view returns (
        uint256 totalAmount, uint256 apyPerSec, uint256 lastClaimTime,
        uint256 lastDepositTime, uint256 lastUnstakeTime, uint256 accruedHachi,
        uint8 tier, bool active
    );
}

interface IPriceOracleView {
    function wldToHachi(uint256 wldAmount) external view returns (uint256);
    function wldToSushi(uint256 wldAmount) external view returns (uint256);
}

interface IUniswapV3PoolMini {
    function slot0() external view returns (
        uint160 sqrtPriceX96, int24 tick,
        uint16 observationIndex, uint16 observationCardinality,
        uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked
    );
    function token0() external view returns (address);
}

interface IPoolWLDView {
    function deposit(uint256 amount) external;
}

interface IPermit2Transfer {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

contract HachiVipHolders is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant Q96 = 79228162514264337593543950336;
    uint256 public constant CAP_SECONDS = 4 weeks;
    IPermit2Transfer public constant PERMIT2 = IPermit2Transfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address public immutable HACHI;
    address public immutable WLD;
    address public immutable DRACHMA;
    address public immutable SUSHI;

    address public lockContract;
    address public priceOracle;
    address public poolWLDDrachma;
    address public poolWLD;

    address public owner;

    // Umbral minimo y bono por nivel (0=250k,1=500k,2=750k,3=1M)
    uint256[4] public tierMinAmount = [
        uint256(250_000 * 1e18), 500_000 * 1e18, 750_000 * 1e18, 1_000_000 * 1e18
    ];
    uint256[4] public tierBonusBps = [500, 800, 1000, 1200]; // 5%,8%,10%,12%

    mapping(address => uint256) public lastActionTime; // 0 = nunca uso

    uint256 public drachmaPool;
    uint256 public sushiPool;

    event Exchanged(address indexed user, uint256 hachiPaid, uint8 tokenOut, uint256 amountOut);
    event PoolFunded(string token, uint256 amount, uint256 newTotal);
    event EmergencyRequested(uint256 unlockTime);
    event EmergencyExecuted(address token, uint256 amount);
    event EmergencyCancelled();

    uint256 public emergencyUnlockTime;

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(
        address _hachi, address _wld, address _drachma, address _sushi,
        address _lockContract, address _priceOracle, address _poolWLDDrachma, address _poolWLD
    ) {
        owner = msg.sender;
        HACHI = _hachi;
        WLD = _wld;
        DRACHMA = _drachma;
        SUSHI = _sushi;
        lockContract = _lockContract;
        priceOracle = _priceOracle;
        poolWLDDrachma = _poolWLDDrachma;
        poolWLD = _poolWLD;
    }

    // --- CONFIG ---------------------------------------------------
    function transferOwnership(address n) external onlyOwner { owner = n; }
    function setLockContract(address _l) external onlyOwner { lockContract = _l; }
    function setPriceOracle(address _p) external onlyOwner { priceOracle = _p; }
    function setPoolWLDDrachma(address _p) external onlyOwner { poolWLDDrachma = _p; }
    function setPoolWLD(address _p) external onlyOwner { poolWLD = _p; }

    function setTierMinAmount(uint256[4] calldata amounts) external onlyOwner { tierMinAmount = amounts; }
    function setTierBonusBps(uint256[4] calldata bps) external onlyOwner { tierBonusBps = bps; }

    function fundDrachmaPool(uint256 amount) external onlyOwner {
        IERC20(DRACHMA).safeTransferFrom(msg.sender, address(this), amount);
        drachmaPool += amount;
        emit PoolFunded("DRACHMA", amount, drachmaPool);
    }

    function fundSushiPool(uint256 amount) external onlyOwner {
        IERC20(SUSHI).safeTransferFrom(msg.sender, address(this), amount);
        sushiPool += amount;
        emit PoolFunded("SUSHI", amount, sushiPool);
    }

    // --- NIVEL Y GENERACION DEL USUARIO -----------------------------
    /// @notice Nivel del usuario (0-3), o 255 si no califica (menos de 250,000 lockeados o Lock inactivo).
    function getVipLevel(address user) public view returns (uint8) {
        (uint256 totalAmount,,,,,, , bool active) = IHachiLockView(lockContract).positions(user);
        if (!active) return 255;
        for (uint8 i = 4; i > 0; i--) {
            if (totalAmount >= tierMinAmount[i-1]) return i-1;
        }
        return 255;
    }

    /// @notice Cuanto HACHI tiene pendiente para cambiar ahora mismo (topeado a 4 semanas).
    function pendingHachi(address user) public view returns (uint256) {
        (, uint256 apyPerSec,,,,, , bool active) = IHachiLockView(lockContract).positions(user);
        if (!active) return 0;
        uint256 last = lastActionTime[user];
        uint256 effectiveLast = last == 0 ? block.timestamp - CAP_SECONDS : last;
        uint256 elapsed = block.timestamp - effectiveLast;
        uint256 capped = elapsed > CAP_SECONDS ? CAP_SECONDS : elapsed;
        return apyPerSec * capped;
    }

    // --- PRECIOS (en vivo) ------------------------------------------
    function _hachiToWld(uint256 hachiAmount) internal view returns (uint256) {
        uint256 hachiPerWld = IPriceOracleView(priceOracle).wldToHachi(1e18);
        require(hachiPerWld > 0, "precio invalido");
        return (hachiAmount * 1e18) / hachiPerWld;
    }

    function _wldToDrachma(uint256 wldAmount) internal view returns (uint256) {
        (uint160 sqrtPX96,,,,,,) = IUniswapV3PoolMini(poolWLDDrachma).slot0();
        require(sqrtPX96 > 0, "Pool V3 vacio");
        address t0 = IUniswapV3PoolMini(poolWLDDrachma).token0();
        uint256 sqrtScaled = (uint256(sqrtPX96) * 1e9) / Q96;
        uint256 price = sqrtScaled * sqrtScaled;
        if (WLD != t0) {
            require(price > 0, "precio invalido");
            price = 1e36 / price;
        }
        return (wldAmount * price) / 1e18;
    }

    /// @notice Preview: cuanto Drachma y cuanto SUSHI (con bono) equivaldria el HACHI pendiente.
    function previewExchange(address user) external view returns (uint256 hachiAmount, uint256 drachmaOut, uint256 sushiOut) {
        hachiAmount = pendingHachi(user);
        uint8 level = getVipLevel(user);
        if (hachiAmount == 0 || level == 255) return (hachiAmount, 0, 0);
        uint256 bonusBps = tierBonusBps[level];
        uint256 wldEquiv = _hachiToWld(hachiAmount);
        uint256 wldWithBonus = (wldEquiv * (10000 + bonusBps)) / 10000;
        drachmaOut = _wldToDrachma(wldWithBonus);
        sushiOut = IPriceOracleView(priceOracle).wldToSushi(wldWithBonus);
    }

    // --- CAMBIAR (exchange) -----------------------------------------
    /// @param preferredToken 0 = Drachma, 1 = SUSHI
    function exchange(uint8 preferredToken, uint256 minOut) external nonReentrant returns (uint8 tokenUsed, uint256 amountOut) {
        require(preferredToken <= 1, "token invalido");
        uint8 level = getVipLevel(msg.sender);
        require(level != 255, "No calificas (minimo 250,000 HACHI lockeados)");

        uint256 hachiAmount = pendingHachi(msg.sender);
        require(hachiAmount > 0, "Nada acumulado todavia");

        uint256 bonusBps = tierBonusBps[level];
        uint256 wldEquiv = _hachiToWld(hachiAmount);
        uint256 wldWithBonus = (wldEquiv * (10000 + bonusBps)) / 10000;

        uint256 drachmaOut = _wldToDrachma(wldWithBonus);
        uint256 sushiOut = IPriceOracleView(priceOracle).wldToSushi(wldWithBonus);

        if (preferredToken == 0 && drachmaPool >= drachmaOut) {
            tokenUsed = 0; amountOut = drachmaOut;
        } else if (preferredToken == 1 && sushiPool >= sushiOut) {
            tokenUsed = 1; amountOut = sushiOut;
        } else if (drachmaPool >= drachmaOut) {
            tokenUsed = 0; amountOut = drachmaOut;
        } else if (sushiPool >= sushiOut) {
            tokenUsed = 1; amountOut = sushiOut;
        } else {
            revert("Sin fondos disponibles en ningun pool");
        }

        require(amountOut >= minOut, "Slippage: recibirias menos de lo esperado");

        // el usuario paga el HACHI generado; va directo al owner, quien lo
        // destina a financiar licencias WLD (deposito manual a PoolWLD)
        PERMIT2.transferFrom(msg.sender, owner, uint160(hachiAmount), HACHI);

        lastActionTime[msg.sender] = block.timestamp;

        if (tokenUsed == 0) {
            drachmaPool -= amountOut;
            IERC20(DRACHMA).safeTransfer(msg.sender, amountOut);
        } else {
            sushiPool -= amountOut;
            IERC20(SUSHI).safeTransfer(msg.sender, amountOut);
        }

        emit Exchanged(msg.sender, hachiAmount, tokenUsed, amountOut);
    }

    // --- EMERGENCIA (timelock de 48hs) -----------------------------
    function requestEmergency() external onlyOwner {
        emergencyUnlockTime = block.timestamp + 48 hours;
        emit EmergencyRequested(emergencyUnlockTime);
    }

    function cancelEmergency() external onlyOwner {
        emergencyUnlockTime = 0;
        emit EmergencyCancelled();
    }

    function emergencyWithdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        require(emergencyUnlockTime > 0 && block.timestamp >= emergencyUnlockTime, "Timelock no cumplido");
        emergencyUnlockTime = 0;
        IERC20(token).safeTransfer(owner, amount);
        emit EmergencyExecuted(token, amount);
    }
}
