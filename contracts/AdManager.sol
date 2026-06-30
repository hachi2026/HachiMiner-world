// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============================================================
//  AdManager v2  (Permit2 / World App compatible)
//  World Chain
//
//  CAMBIO v2: el pago del anunciante (WLD en createCampaign)
//  ahora se jala via Permit2 (permit2.transferFrom) para
//  funcionar dentro de World App sin pantalla en blanco. El
//  frontend envia el approve de Permit2 + createCampaign en
//  una sola sendTransaction batch.
//
//  MECANICA:
//  - Anunciante paga en WLD -> 100% al owner/treasury
//  - El sistema calcula HACHI por vista via oracle
//  - Los usuarios verificados con World ID participan
//  - Cada usuario puede participar 1 vez por anuncio por dia
//  - Al participar recibe HACHI inmediatamente
//  - Los HACHI salen del pool de anuncios (fondeado por owner)
//
//  TIPOS DE CAMPANA (vistas x precio):
//  - 500  vistas -> 5  WLD
//  - 1000 vistas -> 10 WLD
//  - 2000 vistas -> 20 WLD
//  - 5000 vistas -> 50 WLD
// ============================================================

interface IHachiRanking {
    function addPoints(address user, uint256 points) external;
}

/// @notice Interfaz minima del HachiMinerCore para acreditar recompensas al
///         acumulador diario (chanchito) en vez de pagar directo. Asi las
///         tareas respetan el minimo de retiro de 500 HACHI.
interface IMinerCore {
    function creditDaily(address user, uint256 amount) external;
}

interface IPriceOracle {
    function wldToHachi(uint256 wldAmount) external view returns (uint256);
}

interface IWorldID {
    function verifyProof(uint256,uint256,uint256,uint256,uint256,uint256[8] calldata) external view;
}

/// @notice Interfaz minima de Permit2 (AllowanceTransfer) de Uniswap
///         Misma direccion en todas las redes EVM, incl. World Chain
interface IAllowanceTransfer {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

contract AdManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20        public immutable HACHI;
    IERC20        public immutable WLD;
    IPriceOracle  public oracle;

    // Permit2 canonico
    IAllowanceTransfer public constant PERMIT2 =
        IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address public owner;
    address public treasury;     // recibe el WLD de los anunciantes
    address public minerCore;
    address public rankingContract;

    // --- CONSTANTES ------------------------------------------
    uint256 public constant PARTICIPATE_COOLDOWN = 24 hours;

    // Tipos de campana: vistas -> precio en WLD
    uint256[4] public CAMPAIGN_VIEWS  = [500,  1000,  2000,  5000];
    uint256[4] public CAMPAIGN_PRICES = [5e18, 10e18, 20e18, 50e18]; // en WLD

    // --- STRUCTS ---------------------------------------------
    // Plataforma: 0=YouTube 1=Telegram 2=Twitter
    enum Platform { YouTube, Telegram, Twitter }

    struct Campaign {
        address  advertiser;
        string   title;
        string   url;
        Platform platform;
        uint256  totalViews;      // vistas contratadas
        uint256  viewsCompleted;  // vistas realizadas
        uint256  wldPaid;         // WLD pagados por el anunciante
        uint256  hachiPerView;    // HACHI por vista (fijado al crear)
        uint256  hachiRemaining;  // HACHI pendientes de distribuir
        uint256  createdAt;
        bool     active;
        bool     completed;
    }

    mapping(uint256 => Campaign) public campaigns;
    uint256 public campaignCount;

    // user -> campaignId -> ultimo timestamp de participacion
    mapping(address => mapping(uint256 => uint256)) public lastParticipation;

    // Pool de HACHI para recompensas de anuncios (fondeado por owner)
    uint256 public hachiRewardPool;

    // Usuarios verificados (sincronizado con HachiMinerCore)
    mapping(address => bool) public humanVerified;

    // Stats
    uint256 public totalHachiDistributed;
    uint256 public totalWldReceived;
    uint256 public totalParticipations;

    // --- EVENTS ----------------------------------------------
    event CampaignCreated(
        uint256 indexed id,
        address indexed advertiser,
        string title,
        Platform platform,
        uint256 totalViews,
        uint256 wldPaid,
        uint256 hachiPerView
    );
    event Participated(
        address indexed user,
        uint256 indexed campaignId,
        uint256 hachiEarned
    );
    event CampaignCompleted(uint256 indexed id);
    event PoolFunded(uint256 amount, uint256 newTotal);
    event UserVerified(address indexed user);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyHuman() { require(humanVerified[msg.sender], "World ID required"); _; }

    constructor(
        address _hachi,
        address _wld,
        address _oracle,
        address _treasury
    ) {
        owner    = msg.sender;
        HACHI    = IERC20(_hachi);
        WLD      = IERC20(_wld);
        oracle   = IPriceOracle(_oracle);
        treasury = _treasury;
    }

    // --- CONFIG ----------------------------------------------
    function setOracle(address _o) external onlyOwner { oracle = IPriceOracle(_o); }
    function setTreasury(address _t) external onlyOwner { treasury = _t; }
    function setMinerCore(address _c) external onlyOwner { minerCore = _c; }
    function setRanking(address _r) external onlyOwner { rankingContract = _r; }
    function transferOwnership(address n) external onlyOwner { owner = n; }

    /// @notice Sincronizar verificacion World ID desde HachiMinerCore
    /// El Core llama esto cuando un usuario se verifica
    function setHumanVerified(address user) external {
        require(msg.sender == minerCore || msg.sender == owner, "not authorized");
        humanVerified[user] = true;
        emit UserVerified(user);
    }

    /// @notice El owner tambien puede verificar directamente (para testing)
    function verifyUser(address user) external onlyOwner {
        humanVerified[user] = true;
        emit UserVerified(user);
    }

    // --- FONDEAR POOL DE HACHI (owner, approve clasico) ------
    function fundHachiPool(uint256 amount) external onlyOwner {
        HACHI.safeTransferFrom(msg.sender, address(this), amount);
        hachiRewardPool += amount;
        emit PoolFunded(amount, hachiRewardPool);
    }

    // --- CREAR CAMPANA (paga WLD via Permit2) ----------------
    /// @notice El anunciante paga WLD y crea su campana
    /// @param campaignType 0=500v/5WLD 1=1000v/10WLD 2=2000v/20WLD 3=5000v/50WLD
    /// @param title        Titulo del anuncio
    /// @param url          URL del contenido (YouTube/Telegram/Twitter)
    /// @param platform     0=YouTube 1=Telegram 2=Twitter
    function createCampaign(
        uint8    campaignType,
        string   calldata title,
        string   calldata url,
        Platform platform
    ) external nonReentrant {
        require(campaignType <= 3, "Invalid campaign type");
        require(bytes(title).length > 0 && bytes(title).length <= 100, "Invalid title");
        require(bytes(url).length > 0 && bytes(url).length <= 200, "Invalid URL");

        uint256 views = CAMPAIGN_VIEWS[campaignType];
        uint256 price = CAMPAIGN_PRICES[campaignType];

        // Calcular HACHI por vista via oracle (snapshot al momento de crear)
        uint256 totalHachi  = oracle.wldToHachi(price);
        require(totalHachi > 0, "Oracle error");
        uint256 hachiPerView = totalHachi / views;
        require(hachiPerView > 0, "HACHI per view too low");

        // Verificar que el pool de HACHI puede cubrir todas las vistas
        require(hachiRewardPool >= totalHachi, "Insufficient HACHI reward pool");

        // Cobrar WLD via Permit2 -> 100% al treasury/owner
        PERMIT2.transferFrom(msg.sender, address(this), uint160(price), address(WLD));
        WLD.safeTransfer(treasury, price);
        totalWldReceived += price;

        // Reservar HACHI del pool
        hachiRewardPool -= totalHachi;

        campaigns[campaignCount] = Campaign({
            advertiser:      msg.sender,
            title:           title,
            url:             url,
            platform:        platform,
            totalViews:      views,
            viewsCompleted:  0,
            wldPaid:         price,
            hachiPerView:    hachiPerView,
            hachiRemaining:  totalHachi,
            createdAt:       block.timestamp,
            active:          true,
            completed:       false
        });

        emit CampaignCreated(
            campaignCount, msg.sender, title,
            platform, views, price, hachiPerView
        );
        campaignCount++;
    }

    // --- PARTICIPAR EN ANUNCIO -------------------------------
    /// @notice Usuario participa en una campana y recibe HACHI
    function participate(uint256 campaignId) external nonReentrant onlyHuman {
        Campaign storage c = campaigns[campaignId];
        require(c.active && !c.completed, "Campaign not active");

        // Cooldown de 24h por campana por usuario
        require(
            block.timestamp >= lastParticipation[msg.sender][campaignId] + PARTICIPATE_COOLDOWN,
            "Already participated today"
        );

        require(c.hachiRemaining >= c.hachiPerView, "Campaign exhausted");

        // Registrar participacion
        lastParticipation[msg.sender][campaignId] = block.timestamp;
        c.viewsCompleted++;
        c.hachiRemaining -= c.hachiPerView;
        totalParticipations++;
        totalHachiDistributed += c.hachiPerView;

        // Pagar HACHI: se acredita al acumulador diario (chanchito) del Core
        // para respetar el minimo de retiro de 500. Si no hay Core configurado,
        // se paga directo a la wallet como fallback.
        if (minerCore != address(0)) {
            HACHI.safeTransfer(minerCore, c.hachiPerView);
            IMinerCore(minerCore).creditDaily(msg.sender, c.hachiPerView);
        } else {
            HACHI.safeTransfer(msg.sender, c.hachiPerView);
            if (rankingContract != address(0))
                try IHachiRanking(rankingContract).addPoints(msg.sender, c.hachiPerView / 1e18) {} catch {}
        }

        emit Participated(msg.sender, campaignId, c.hachiPerView);

        // Verificar si la campana se completo
        if (c.viewsCompleted >= c.totalViews || c.hachiRemaining < c.hachiPerView) {
            c.active    = false;
            c.completed = true;
            // Devolver HACHI sobrante al pool
            if (c.hachiRemaining > 0) {
                hachiRewardPool  += c.hachiRemaining;
                c.hachiRemaining  = 0;
            }
            emit CampaignCompleted(campaignId);
        }
    }

    // --- VISTAS ----------------------------------------------

    /// @notice Lista de campanas activas con su info
    function getActiveCampaigns() external view returns (
        uint256[] memory ids,
        string[]  memory titles,
        uint8[]   memory platforms,
        uint256[] memory viewsLeft,
        uint256[] memory hachiPerView_
    ) {
        // Contar activas
        uint256 count = 0;
        for (uint256 i = 0; i < campaignCount; i++)
            if (campaigns[i].active) count++;

        ids          = new uint256[](count);
        titles       = new string[](count);
        platforms    = new uint8[](count);
        viewsLeft    = new uint256[](count);
        hachiPerView_= new uint256[](count);

        uint256 j = 0;
        for (uint256 i = 0; i < campaignCount; i++) {
            if (!campaigns[i].active) continue;
            Campaign memory c = campaigns[i];
            ids[j]           = i;
            titles[j]        = c.title;
            platforms[j]     = uint8(c.platform);
            viewsLeft[j]     = c.totalViews - c.viewsCompleted;
            hachiPerView_[j] = c.hachiPerView;
            j++;
        }
    }

    /// @notice Verifica si el usuario puede participar en una campana
    function canParticipate(address user, uint256 campaignId) external view returns (
        bool   eligible,
        uint256 cooldownLeft,
        uint256 hachiReward
    ) {
        Campaign memory c = campaigns[campaignId];
        if (!c.active || c.completed) return (false, 0, 0);
        if (!humanVerified[user]) return (false, 0, 0);

        uint256 lastTime = lastParticipation[user][campaignId];
        uint256 nextTime = lastTime + PARTICIPATE_COOLDOWN;

        if (block.timestamp < nextTime) {
            return (false, nextTime - block.timestamp, c.hachiPerView);
        }
        return (true, 0, c.hachiPerView);
    }

    /// @notice Preview de cuanto HACHI recibiria por tipo de campana
    function previewCampaign(uint8 campaignType) external view returns (
        uint256 views,
        uint256 wldPrice,
        uint256 totalHachi,
        uint256 hachiPerView_
    ) {
        require(campaignType <= 3, "Invalid type");
        views    = CAMPAIGN_VIEWS[campaignType];
        wldPrice = CAMPAIGN_PRICES[campaignType];
        try oracle.wldToHachi(wldPrice) returns (uint256 h) {
            totalHachi    = h;
            hachiPerView_ = h / views;
        } catch {
            totalHachi = 0; hachiPerView_ = 0;
        }
    }

    function getStats() external view returns (
        uint256 totalCampaigns,
        uint256 activeCampaigns,
        uint256 hachiPool,
        uint256 hachiDistributed,
        uint256 wldReceived,
        uint256 participations
    ) {
        uint256 active = 0;
        for (uint256 i = 0; i < campaignCount; i++)
            if (campaigns[i].active) active++;
        return (
            campaignCount, active,
            hachiRewardPool, totalHachiDistributed,
            totalWldReceived, totalParticipations
        );
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
