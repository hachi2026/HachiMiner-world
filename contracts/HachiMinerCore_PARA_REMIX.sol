// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  HachiMinerCore v6  (Permit2 / World App compatible)
//  World Chain
//
//  CAMBIO v7: HACHI diario ahora es un acumulador (chanchito)
//  LAZY por tiempo: se suma de forma ficticia segun el tiempo
//  (100 HACHI/dia) SIN transacciones diarias ni gas. El gas se
//  paga una sola vez al retirar (withdrawDailyHachi), y solo si
//  el saldo >= minimo (500). Halving UNICO a 1M de retiros
//  (100->50 y 500->250). El minimo aplica tambien a claimWLDHachi.
//  Las tareas del AdManager acreditan via creditDaily. SUSHI es
//  intercambio inmediato.
//
//  v6: pagos del usuario (WLD/HACHI) via Permit2 para World App.
// ============================================================

interface IWorldID {
    function verifyProof(uint256,uint256,uint256,uint256,uint256,uint256[8] calldata) external view;
}
interface IPriceOracle {
    function wldToHachi(uint256) external view returns (uint256);
    function hachiToSushi(uint256) external view returns (uint256);
    function wldToSushi(uint256) external view returns (uint256);
    function hachiPerView(uint256, uint256) external view returns (uint256);
    function saveLastPrices() external;
}
interface IHachiLock {
    function canMine(address) external view returns (bool);
    function getUserTier(address) external view returns (uint8);
    function fundAPYPool(uint256) external;
}
interface IHachiRanking {
    function addPoints(address, uint256) external;
    function depositPool4(uint256) external;
}
interface IAdManager {
    function setHumanVerified(address user) external;
}
interface IReferralManager {
    function setHumanVerified(address user) external;
}
interface IHachiPoolWLD {
    function canSellLicense(uint256) external view returns (bool);
    function commitHachi(uint256) external returns (bool);
    function payHachi(address, uint256) external;
    function releaseCommitment(uint256) external;
    function receiveFromLicenses(uint256) external;
    function freeBalance() external view returns (uint256);
    function getPoolStatus() external view returns (uint256, uint256, uint256, uint256, uint256);
}

/// @notice Interfaz minima de Permit2 (AllowanceTransfer) de Uniswap
///         Misma direccion en todas las redes EVM, incl. World Chain
interface IAllowanceTransfer {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

contract HachiMinerCore is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable HACHI;
    IERC20 public immutable WLD;
    IERC20 public immutable SUSHI;

    // Permit2 canonico
    IAllowanceTransfer public constant PERMIT2 =
        IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    IPriceOracle  public oracle;
    IHachiLock    public lockContract;
    IHachiRanking public ranking;
    IHachiPoolWLD public poolWLD;

    address public owner;
    address public wldTreasury;
    IAdManager       public adManager;
    IReferralManager public referralManager;

    IWorldID public immutable worldId;
    uint256  public immutable externalNullifierHash;
    uint256  public constant  GROUP_ID = 1;
    mapping(uint256 => bool)  public nullifierUsed;
    mapping(address => bool)  public humanVerified;

    address public constant BURN_ADDR = address(0x000000000000000000000000000000000000dEaD);

    uint256 public constant LIC_WLD_MULT       = 130; // 30% base (BASIC/STD/PREM)
    uint256 public constant LIC_WLD_MULT_ELITE = 135; // 35% para ELITE (10 WLD)
    uint256 public constant LIC_WLD_DURATION = 90 days;
    uint256 public constant LIC_WLD_BASIC    = 1  * 1e18;
    uint256 public constant LIC_WLD_STD      = 3  * 1e18;
    uint256 public constant LIC_WLD_PREM     = 5  * 1e18;
    uint256 public constant LIC_WLD_ELITE    = 10 * 1e18;
    uint256 public constant MAX_WLD_LICS_PER_MONTH = 5;

    uint256 public constant LIC_SUSHI_BASIC  = 500    * 1e18;
    uint256 public constant LIC_SUSHI_STD    = 2_000  * 1e18;
    uint256 public constant LIC_SUSHI_PREM   = 5_000  * 1e18;
    uint256 public constant LIC_SUSHI_ELITE  = 10_000 * 1e18;
    uint256 public constant LIC_SUSHI_MULT   = 125; // pago unico inmediato: base + 25%
    uint256 public constant LIC_WLD_PRICE    = 5     * 1e18;

    uint256 public constant S_WLD_POOL  = 50;
    uint256 public constant S_APY_POOL  = 30;
    uint256 public constant S_RANKING   = 10;
    uint256 public constant S_BURN      = 10;

    uint256 public poolA_sushi;
    uint256 public poolC_sushi;
    uint256 public poolA_committed;
    uint256 public poolC_committed;

    struct LicenseWLD {
        address owner_;
        uint8   wldType;
        uint256 wldPrice;
        uint256 hachiTotal;
        uint256 hachiPerSec;
        uint256 hachiClaimed;
        uint256 startTime;
        uint256 endTime;
        uint256 lastHachiClaim;
        uint256 hachiCommitted;
        bool    active;
        bool    matured;
    }

    struct LicenseSushi {
        address owner_;
        uint8   licType;
        uint256 hachiPrice;
        uint256 sushiBase;
        uint256 sushiTotal;     // base + 25%, entregado al instante
        uint256 startTime;
        bool    active;
    }

    mapping(uint256 => LicenseWLD)   public wldLics;
    mapping(uint256 => LicenseSushi) public sushiLics;
    mapping(address => uint256[])    public userWLDLics;
    mapping(address => uint256[])    public userSushiLics;
    uint256 public wldLicId;
    uint256 public sushiLicId;

    mapping(address => mapping(uint256 => uint256)) public monthlyWLDPurchases;
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) public dailySushiPurchases;
    mapping(address => uint256) public lastSpecialSushi;

    uint256 public totalHachiBurned;
    uint256 public totalWldToOwner;
    uint256 public totalWldSales;
    uint256 public totalSushiSales;
    uint256 public totalLicensesWLD;
    uint256 public totalLicensesSushi;
    uint256 public totalHachiToAPY;
    uint256 public totalHachiToWLDPool;

    event HumanVerified(address indexed user);
    event WLDLicBought(address indexed user, uint256 id, uint256 hachiTotal, uint8 licType, uint256 wldPrice);
    event SushiLicBought(address indexed user, uint256 id, uint256 sushiTotal, uint8 licType, uint256 hachiPrice);
    event HachiClaimed(address indexed user, uint256 licId, uint256 amount);
    event CycleClaimed(address indexed user, uint256 licId, uint256 amount);
    event PerpClaimed(address indexed user, uint256 licId, uint256 amount);
    event PoolFunded(uint8 pool, uint256 amount, uint256 newTotal);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(
        address _hachi, address _wld, address _sushi,
        address _oracle, address _lock, address _ranking,
        address _poolWLD, address _wldTreasury,
        address _worldId, uint256 _extNull
    ) {
        owner                 = msg.sender;
        HACHI                 = IERC20(_hachi);
        WLD                   = IERC20(_wld);
        SUSHI                 = IERC20(_sushi);
        oracle                = IPriceOracle(_oracle);
        lockContract          = IHachiLock(_lock);
        ranking               = IHachiRanking(_ranking);
        poolWLD               = IHachiPoolWLD(_poolWLD);
        wldTreasury           = _wldTreasury;
        worldId               = IWorldID(_worldId);
        externalNullifierHash = _extNull;
    }

    function setOracle(address a) external onlyOwner { oracle = IPriceOracle(a); }
    function setLock(address a) external onlyOwner { lockContract = IHachiLock(a); }
    function setRanking(address a) external onlyOwner { ranking = IHachiRanking(a); }
    function setPoolWLD(address a) external onlyOwner { poolWLD = IHachiPoolWLD(a); }
    function setWldTreasury(address a) external onlyOwner { wldTreasury = a; }
    function setAdManager(address a) external onlyOwner { adManager = IAdManager(a); }
    function setReferralManager(address a) external onlyOwner { referralManager = IReferralManager(a); }
    function transferOwnership(address n) external onlyOwner { owner = n; }

    // Owner fondea pools con approve clasico (no via World App)
    function fundPoolA(uint256 amount) external onlyOwner {
        SUSHI.safeTransferFrom(msg.sender, address(this), amount);
        poolA_sushi += amount;
        emit PoolFunded(1, amount, poolA_sushi);
    }

    function fundPoolC(uint256 amount) external onlyOwner {
        SUSHI.safeTransferFrom(msg.sender, address(this), amount);
        poolC_sushi += amount;
        emit PoolFunded(3, amount, poolC_sushi);
    }

    // --- WORLD ID (opcional - para registro on-chain) ---------
    function verifyHuman(uint256 root, uint256 nullHash, uint256[8] calldata proof) external {
        require(!humanVerified[msg.sender], "Already verified");
        require(!nullifierUsed[nullHash], "Nullifier used");
        worldId.verifyProof(
            root, GROUP_ID,
            uint256(keccak256(abi.encodePacked(msg.sender))) >> 8,
            nullHash, externalNullifierHash, proof
        );
        nullifierUsed[nullHash] = true;
        humanVerified[msg.sender] = true;
        // Arranca el reloj del acumulador diario (chanchito) al verificarse
        if (lastDailySettle[msg.sender] == 0) lastDailySettle[msg.sender] = block.timestamp;
        if (address(adManager) != address(0))
            try adManager.setHumanVerified(msg.sender) {} catch {}
        if (address(referralManager) != address(0))
            try referralManager.setHumanVerified(msg.sender) {} catch {}
        emit HumanVerified(msg.sender);
    }

    // --- COMPRAR LICENCIA WLD (paga WLD via Permit2) ----------
    function buyLicenseWLD(uint8 licType) external nonReentrant {
        require(licType <= 3, "Invalid license type");

        uint256 currentMonth = block.timestamp / 30 days;
        require(
            monthlyWLDPurchases[msg.sender][currentMonth] < MAX_WLD_LICS_PER_MONTH,
            "Max 5 WLD licenses per month"
        );

        uint256 wldPrice;
        if      (licType == 0) wldPrice = LIC_WLD_BASIC;
        else if (licType == 1) wldPrice = LIC_WLD_STD;
        else if (licType == 2) wldPrice = LIC_WLD_PREM;
        else                   wldPrice = LIC_WLD_ELITE;

        uint256 hachiBase  = oracle.wldToHachi(wldPrice);
        require(hachiBase > 0, "Oracle error");
        uint256 hachiTotal = (hachiBase * _wldMultiplier(wldPrice)) / 100;

        require(poolWLD.canSellLicense(hachiTotal), "Pool WLD insufficient");

        // Jala WLD del usuario via Permit2 y reenvia al treasury
        PERMIT2.transferFrom(msg.sender, address(this), uint160(wldPrice), address(WLD));
        WLD.safeTransfer(wldTreasury, wldPrice);
        totalWldToOwner += wldPrice;

        bool ok = poolWLD.commitHachi(hachiTotal);
        require(ok, "HACHI commit failed");

        monthlyWLDPurchases[msg.sender][currentMonth]++;

        uint256 start = block.timestamp;
        wldLics[wldLicId] = LicenseWLD({
            owner_:         msg.sender,
            wldType:        licType,
            wldPrice:       wldPrice,
            hachiTotal:     hachiTotal,
            hachiPerSec:    hachiTotal / LIC_WLD_DURATION,
            hachiClaimed:   0,
            startTime:      start,
            endTime:        start + LIC_WLD_DURATION,
            lastHachiClaim: start,
            hachiCommitted: hachiTotal,
            active:         true,
            matured:        false
        });

        userWLDLics[msg.sender].push(wldLicId);
        totalWldSales    += wldPrice;
        totalLicensesWLD++;
        emit WLDLicBought(msg.sender, wldLicId, hachiTotal, licType, wldPrice);
        wldLicId++;

        try oracle.saveLastPrices() {} catch {}
    }

    // --- COMPRAR LICENCIA SUSHI (paga HACHI via Permit2) ------
    function buyLicenseSushi(uint8 licType) external nonReentrant {
        require(licType <= 3, "Invalid license type");

        bool hasLock = address(lockContract) != address(0) && lockContract.canMine(msg.sender);
        uint8 wldTier = getHighestActiveWLDType(msg.sender);
        bool hasWLD   = wldTier != type(uint8).max;

        require(hasLock || hasWLD, "Need 5000 HACHI locked OR active WLD license");

        uint256 today = block.timestamp / 1 days;

        if (licType == 0) {
            uint256 dailyLimit = _maxBasicSushiPerDay(wldTier);
            uint256 bought     = dailySushiPurchases[msg.sender][today][0];
            if (bought < dailyLimit) {
                // compra diaria normal
            } else {
                // basica adicional: solo WLD tipo 0 + cooldown 5 dias
                require(wldTier == 0, "Daily basic limit reached");
                require(specialSushiAvailable(msg.sender), "Special cooldown: 5 days required");
                lastSpecialSushi[msg.sender] = block.timestamp;
            }
        } else {
            // SUSHI Estandar/Premium/Elite: requiere WLD >= licType + cooldown 5 dias
            require(hasWLD && wldTier >= licType, "WLD license of same level or higher required");
            require(specialSushiAvailable(msg.sender), "Special cooldown: 5 days required");
            lastSpecialSushi[msg.sender] = block.timestamp;
        }

        uint256 hachiPrice = _getSushiPrice(licType);
        _validateAndCreateSushiLic(licType, hachiPrice, today);
        try oracle.saveLastPrices() {} catch {}
    }

    function _validateAndCreateSushiLic(uint8 licType, uint256 hachiPrice, uint256 today) internal {
        // Intercambio inmediato: paga HACHI y recibe SUSHI (base + 25%) al instante.
        uint256 sushiBase  = oracle.hachiToSushi(hachiPrice);
        require(sushiBase > 0, "Oracle error");
        uint256 sushiTotal = (sushiBase * LIC_SUSHI_MULT) / 100; // base + 25%
        require(poolA_sushi >= poolA_committed + sushiTotal, "Pool A insufficient");
        // Jala HACHI del usuario via Permit2
        PERMIT2.transferFrom(msg.sender, address(this), uint160(hachiPrice), address(HACHI));
        _distributeHachi(hachiPrice);
        dailySushiPurchases[msg.sender][today][licType]++;
        // Entrega inmediata del SUSHI
        require(SUSHI.balanceOf(address(this)) >= sushiTotal, "SUSHI balance low");
        poolA_sushi -= sushiTotal;
        SUSHI.safeTransfer(msg.sender, sushiTotal);
        if (address(ranking) != address(0))
            try ranking.addPoints(msg.sender, sushiTotal / 1e18) {} catch {}
        _createSushiLic(licType, hachiPrice, sushiBase, sushiTotal);
        totalSushiSales    += hachiPrice;
        totalLicensesSushi++;
        emit SushiLicBought(msg.sender, sushiLicId, sushiTotal, licType, hachiPrice);
        emit CycleClaimed(msg.sender, sushiLicId, sushiTotal);
        sushiLicId++;
    }

    function _getSushiPrice(uint8 licType) internal pure returns (uint256) {
        if (licType == 0) return LIC_SUSHI_BASIC;
        if (licType == 1) return LIC_SUSHI_STD;
        if (licType == 2) return LIC_SUSHI_PREM;
        return LIC_SUSHI_ELITE;
    }

    function _maxBasicSushiPerDay(uint8 wldTier) internal pure returns (uint256) {
        if (wldTier == type(uint8).max) return 1; // sin licencia WLD
        if (wldTier == 0)               return 2; // WLD Basica
        if (wldTier == 1)               return 3; // WLD Estandar
        if (wldTier == 2)               return 4; // WLD Premium
        return 5;                                  // WLD Elite
    }

    function _createSushiLic(
        uint8 licType, uint256 hachiPrice,
        uint256 sushiBase, uint256 sushiTotal
    ) internal {
        sushiLics[sushiLicId] = LicenseSushi({
            owner_:           msg.sender,
            licType:          licType,
            hachiPrice:       hachiPrice,
            sushiBase:        sushiBase,
            sushiTotal:       sushiTotal,
            startTime:        block.timestamp,
            active:           true
        });
        userSushiLics[msg.sender].push(sushiLicId);
    }

    // SUSHI ahora es intercambio inmediato: el SUSHI se entrega en buyLicenseSushi,
    // no hay claims Day1/Day2 ni perpetuo. Mantenemos un getter de pendientes = 0
    // por compatibilidad con el frontend antiguo.
    function pendingSushi(uint256) external pure returns (uint256) { return 0; }

    // --- HACHI DIARIO: ACUMULADOR (CHANCHITO) LAZY POR TIEMPO -
    // El HACHI se acumula de forma ficticia segun el tiempo transcurrido,
    // NO requiere transacciones diarias (gas) por parte del usuario.
    // El gas se paga UNA sola vez, al retirar (withdrawDailyHachi).
    uint256 public dailyRate                  = 50 * 1e18;    // 50 HACHI por dia (ajustable por owner)
    uint256 public constant HALVING_THRESHOLD = 1_000_000;    // un solo halving a 1M de retiros
    uint256 public constant BASE_MIN_WITHDRAW = 500 * 1e18;   // minimo para retirar (250 tras halving)

    mapping(address => uint256) public lastDailySettle;  // timestamp del ultimo materializado / inicio del reloj
    mapping(address => uint256) public dailyAccrued;     // extra acreditado por tareas/referidos (creditDaily)
    uint256 public hachiDailyPool;
    uint256 public totalDailyClaims;                     // contador global de retiros (para el halving)

    event DailyWithdrawn(address indexed user, uint256 amount, uint256 claimNumber);
    event DailyCredited(address indexed user, uint256 amount, uint256 pending);

    // Halving UNICO: antes de 1M retiros = valor completo; despues = mitad permanente.
    function _halved(uint256 v) internal view returns (uint256) {
        return totalDailyClaims >= HALVING_THRESHOLD ? v / 2 : v;
    }
    function currentDailyRate()   public view returns (uint256) { return dailyRate; }
    function setDailyRate(uint256 newRate) external { require(msg.sender == owner, "not owner"); dailyRate = newRate; }
    function currentMinWithdraw() public view returns (uint256) { return _halved(BASE_MIN_WITHDRAW); }

    // Acumulacion ficticia por tiempo desde el ultimo settle (no consume gas)
    function _timeAccrued(address u) internal view returns (uint256) {
        uint256 last = lastDailySettle[u];
        if (last == 0 || block.timestamp <= last) return 0;
        return (currentDailyRate() * (block.timestamp - last)) / 1 days;
    }

    // Saldo total disponible del chanchito (tiempo + extras de tareas)
    function pendingDaily(address u) public view returns (uint256) {
        return dailyAccrued[u] + _timeAccrued(u);
    }

    // Compat: el frontend antiguo leia esto
    function currentDailyAccrual() external view returns (uint256) { return currentDailyRate(); }

    // Inicia/arranca el reloj de acumulacion si aun no esta corriendo
    function _ensureAccrualStarted(address u) internal {
        if (lastDailySettle[u] == 0) lastDailySettle[u] = block.timestamp;
    }

    function startAccrual() external {
        _ensureAccrualStarted(msg.sender);
    }

    // Retiro del chanchito: el usuario decide cuando, pero el saldo debe ser >= minimo.
    // Es la UNICA transaccion con gas del flujo diario.
    function withdrawDailyHachi() external nonReentrant {
        require(block.timestamp >= lastDailySettle[msg.sender] + 24 hours, "Daily claim cooldown: 24 hours");
        uint256 amount = pendingDaily(msg.sender);
        require(amount > 0, "Nothing to withdraw");
        require(hachiDailyPool >= amount, "Daily pool empty");
        dailyAccrued[msg.sender]    = 0;
        lastDailySettle[msg.sender] = block.timestamp;
        hachiDailyPool -= amount;
        totalDailyClaims++;
        HACHI.safeTransfer(msg.sender, amount);
        if (address(ranking) != address(0))
            try ranking.addPoints(msg.sender, amount / 1e18) {} catch {}
        emit DailyWithdrawn(msg.sender, amount, totalDailyClaims);
    }

    function fundDailyPool(uint256 amount) external onlyOwner {
        HACHI.safeTransferFrom(msg.sender, address(this), amount);
        hachiDailyPool += amount;
    }

    // El AdManager (u owner) acredita las recompensas de tareas al acumulador
    // del usuario en vez de pagar directo. Asi las tareas tambien respetan el
    // minimo de retiro de 500 HACHI (chanchito). El HACHI ya debe estar en este
    // contrato (el AdManager lo transfiere antes de llamar a creditDaily).
    function creditDaily(address user, uint256 amount) external {
        require(msg.sender == address(adManager) || msg.sender == owner, "not authorized");
        require(amount > 0, "zero amount");
        _ensureAccrualStarted(user);
        dailyAccrued[user] += amount;
        hachiDailyPool     += amount; // respaldo para el futuro retiro
        if (address(ranking) != address(0))
            try ranking.addPoints(user, amount / 1e18) {} catch {}
        emit DailyCredited(user, amount, pendingDaily(user));
    }

    // --- CLAIM WLD HACHI --------------------------------------
    function claimWLDHachi(uint256 id) external nonReentrant {
        LicenseWLD storage l = wldLics[id];
        require(l.owner_ == msg.sender, "Not yours");
        require(l.active || l.matured, "Inactive");
        if (l.active && block.timestamp >= l.endTime) _matureWLD(id);
        uint256 now_ = block.timestamp;
        uint256 to = now_ < l.endTime ? now_ : l.endTime;
        uint256 earned = (to - l.lastHachiClaim) * l.hachiPerSec;
        uint256 rem = l.hachiTotal > l.hachiClaimed ? l.hachiTotal - l.hachiClaimed : 0;
        if (earned > rem) earned = rem;
        require(earned > 0, "Nothing to claim");
        l.hachiClaimed  += earned;
        l.lastHachiClaim = now_;
        poolWLD.payHachi(msg.sender, earned);
        if (address(ranking) != address(0))
            try ranking.addPoints(msg.sender, earned / 1e18) {} catch {}
        emit HachiClaimed(msg.sender, id, earned);
    }

    // --- VISTAS -----------------------------------------------
    function getWLDAvailability() external view returns (uint256 wldHachiPool, uint256 wldLicsAvailable) {
        uint256 hachiPerLic = _estimateHachiPerWLDLic();
        wldHachiPool     = _poolWLDBalance();
        wldLicsAvailable = hachiPerLic > 0 ? _poolWLDFree() / hachiPerLic : 0;
    }

    function getSushiAvailability() external view returns (
        uint256 poolA_free, uint256 sushiLicsAvailable, uint256 poolC_free,
        uint256 perpLicsAvailable, uint8 userTier, uint256 userActiveSushi, uint256 userMaxSushi
    ) {
        poolA_free = poolA_sushi > poolA_committed ? poolA_sushi - poolA_committed : 0;
        sushiLicsAvailable = _estimateSushiPerLic() > 0 ? poolA_free / _estimateSushiPerLic() : 0;
        // Pool C / perpetuo eliminados: SUSHI ahora es pago unico inmediato
        poolC_free = 0;
        perpLicsAvailable = 0;
        userTier = _getTier(msg.sender);
        userActiveSushi = _countActiveSushi(msg.sender);
        userMaxSushi = _maxBasicSushiPerDay(getHighestActiveWLDType(msg.sender));
    }

    function monthlyWLDRemaining(address user) external view returns (uint256 remaining, uint256 used) {
        uint256 currentMonth = block.timestamp / 30 days;
        used = monthlyWLDPurchases[user][currentMonth];
        remaining = used < MAX_WLD_LICS_PER_MONTH ? MAX_WLD_LICS_PER_MONTH - used : 0;
    }

    function previewWldLicense(uint256 wldAmount) external view returns (
        uint256 hachiBase, uint256 hachiTotal, uint256 hachiPerDay, uint256 wldPriceOut, bool poolCovers
    ) {
        wldPriceOut = wldAmount;
        try oracle.wldToHachi(wldAmount) returns (uint256 base) {
            hachiBase   = base;
            hachiTotal  = (base * _wldMultiplier(wldAmount)) / 100;
            hachiPerDay = hachiTotal / 90;
            poolCovers  = hachiTotal > 0 && poolWLD.canSellLicense(hachiTotal);
        } catch {
            hachiBase = 0; hachiTotal = 0; hachiPerDay = 0; poolCovers = false;
        }
    }

    function pendingWLDHachi(uint256 id) external view returns (uint256) {
        LicenseWLD memory l = wldLics[id];
        if (!l.active && !l.matured) return 0;
        uint256 to = block.timestamp < l.endTime ? block.timestamp : l.endTime;
        uint256 earned = (to - l.lastHachiClaim) * l.hachiPerSec;
        uint256 rem = l.hachiTotal > l.hachiClaimed ? l.hachiTotal - l.hachiClaimed : 0;
        return earned > rem ? rem : earned;
    }

    function getSalesStats() external view returns (
        uint256 wldSales, uint256 sushiSales, uint256 licsWLD,
        uint256 licsSushi, uint256 hachiBurned, uint256 wldToOwner
    ) {
        return (totalWldSales, totalSushiSales, totalLicensesWLD, totalLicensesSushi, totalHachiBurned, totalWldToOwner);
    }

    function getPoolStatus() external view returns (
        uint256 poolA, uint256 poolA_comm, uint256 poolA_free_,
        uint256 poolC, uint256 poolC_comm, uint256 poolC_free_,
        uint256 sushiPerLic, uint256 perpPerLic
    ) {
        return (
            poolA_sushi, poolA_committed,
            poolA_sushi > poolA_committed ? poolA_sushi - poolA_committed : 0,
            poolC_sushi, poolC_committed,
            poolC_sushi > poolC_committed ? poolC_sushi - poolC_committed : 0,
            _estimateSushiPerLic(), 0
        );
    }

    function getUserWLDLics(address u) external view returns (uint256[] memory) { return userWLDLics[u]; }
    function getUserSushiLics(address u) external view returns (uint256[] memory) { return userSushiLics[u]; }

    function getHighestActiveWLDType(address user) public view returns (uint8) {
        uint256[] memory ids = userWLDLics[user];
        uint8 highest = type(uint8).max;
        for (uint256 i = 0; i < ids.length; i++) {
            LicenseWLD storage lic = wldLics[ids[i]];
            if (lic.active && (highest == type(uint8).max || lic.wldType > highest)) {
                highest = lic.wldType;
                if (highest == 3) break;
            }
        }
        return highest;
    }

    function specialSushiAvailable(address user) public view returns (bool) {
        return block.timestamp >= lastSpecialSushi[user] + 5 days;
    }

    // --- INTERNOS --------------------------------------------
    function _distributeHachi(uint256 amount) internal {
        uint256 toWLD     = (amount * S_WLD_POOL) / 100;
        uint256 toAPY     = (amount * S_APY_POOL) / 100;
        uint256 toRanking = (amount * S_RANKING)  / 100;
        uint256 toBurn    = amount - toWLD - toAPY - toRanking;
        HACHI.safeTransfer(BURN_ADDR, toBurn);
        totalHachiBurned += toBurn;
        if (address(poolWLD) != address(0) && toWLD > 0) {
            HACHI.approve(address(poolWLD), toWLD);
            try poolWLD.receiveFromLicenses(toWLD) { totalHachiToWLDPool += toWLD; }
            catch { HACHI.safeTransfer(owner, toWLD); }
        }
        if (address(lockContract) != address(0) && toAPY > 0) {
            HACHI.approve(address(lockContract), toAPY);
            try lockContract.fundAPYPool(toAPY) { totalHachiToAPY += toAPY; }
            catch { HACHI.safeTransfer(owner, toAPY); }
        }
        if (address(ranking) != address(0) && toRanking > 0) {
            HACHI.approve(address(ranking), toRanking);
            try ranking.depositPool4(toRanking) {}
            catch { HACHI.safeTransfer(owner, toRanking); }
        }
    }

    function _matureWLD(uint256 id) internal {
        LicenseWLD storage l = wldLics[id];
        if (l.matured) return;
        uint256 unclaimed = l.hachiTotal > l.hachiClaimed ? l.hachiTotal - l.hachiClaimed : 0;
        if (unclaimed > 0) poolWLD.releaseCommitment(unclaimed);
        l.active = false; l.matured = true;
    }

    // ELITE (10 WLD) gana 35%; el resto 30%
    function _wldMultiplier(uint256 wldPrice) internal pure returns (uint256) {
        return wldPrice >= LIC_WLD_ELITE ? LIC_WLD_MULT_ELITE : LIC_WLD_MULT;
    }

    function _hasActiveWLDLicense(address user) internal view returns (bool) {
        uint256[] memory ids = userWLDLics[user];
        for (uint256 i = 0; i < ids.length; i++)
            if (wldLics[ids[i]].active) return true;
        return false;
    }

    function _getTier(address user) internal view returns (uint8) {
        if (address(lockContract) == address(0)) return 0;
        try lockContract.getUserTier(user) returns (uint8 t) { return t; } catch { return 0; }
    }

    function _countActiveSushi(address user) internal view returns (uint256 count) {
        for (uint256 i = 0; i < userSushiLics[user].length; i++)
            if (sushiLics[userSushiLics[user][i]].active) count++;
    }

    function _estimateHachiPerWLDLic() internal view returns (uint256) {
        try oracle.wldToHachi(LIC_WLD_PRICE) returns (uint256 base) { return (base * LIC_WLD_MULT) / 100; }
        catch { return 65_000 * 1e18; }
    }

    function _estimateSushiPerLic() internal view returns (uint256) {
        try oracle.hachiToSushi(LIC_SUSHI_BASIC) returns (uint256 base) { return (base * LIC_SUSHI_MULT) / 100; }
        catch { return 2_000 * 1e18; }
    }

    function _poolWLDBalance() internal view returns (uint256) {
        if (address(poolWLD) == address(0)) return 0;
        return HACHI.balanceOf(address(poolWLD));
    }

    function _poolWLDFree() internal view returns (uint256) {
        if (address(poolWLD) == address(0)) return 0;
        try poolWLD.freeBalance() returns (uint256 free) { return free; } catch { return 0; }
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
