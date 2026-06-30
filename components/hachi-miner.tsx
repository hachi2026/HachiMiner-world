'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { MiniKit } from '@worldcoin/minikit-js'
import { getIsUserVerified } from '@worldcoin/minikit-js/address-book'
import { createPublicClient, encodeFunctionData, http, parseAbi } from 'viem'
import { useUserOperationReceipt } from '@worldcoin/minikit-react'
import { ethers } from 'ethers'

const worldChain = {
  id: 480,
  name: 'World Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://worldchain-mainnet.g.alchemy.com/public'] } },
} as const

const C = {
  oracle:   '0x0e18Ff0A2b9981D2FF50658aD4960d17c9b7C22b',
  poolWLD:  '0x9F8ccE86271319f36AA25d8390cfC18741719f19',
  lock:     '0xF743772A09f92850deAFcBDfe6610cFfCe326003',
  ranking:  '0xfA503d183cc747cBA75D1a5ba419150f5529eB27',
  core:     '0xE1892183A27389c6a4CACc091F62F9412B7EA6b9',
  adMgr:    '0xC51debcdc888d75EE91293B7E2ADE1C22C944097',
  referral: '0xeD93898021C07797797c783Dd5cd096e1C8644d5',
  hachi:    '0xbE0313f279580FDD1aA1b1b6888407E6504fF19E',
  wld:      '0x2cfc85d8e48f8eab294be644d9e25c3030863003',
  sushi:    '0xab09a728e53d3d6bc438be95eed46da0bbe7fb38',
  // Permit2 canónico de Uniswap (misma dirección en todas las redes EVM, incl. World Chain)
  permit2:  '0x000000000022D473030F116dDEE9F6B43aC78BA3',
}

const RPC = 'https://worldchain-mainnet.g.alchemy.com/public'
const HACHI_BUY_URL = 'https://world.org/mini-app?app_id=app_e5ba7c3061400e361f98ce44d8b1b9c4&path=/token/0xbe0313f279580fdd1aa1b1b6888407e6504ff19e'
const WORLDCHAIN_ID = 480
const MAX_HACHI = 20000
const APP_ID = 'app_faaadf7d4dc1285275a436a8cac18e69'
// Incognito Action de World ID configurada en el Developer Portal.
// DEBE coincidir con el externalNullifierHash con el que se desplegó el contrato.
const ACTION = 'verify-human'

const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)']
// Permit2 (AllowanceTransfer): approve da permiso a un "spender" (nuestro contrato) para mover el token vía Permit2
const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]
const ORACLE = ['function getRates() view returns (uint256,uint256,uint256,bool,bool,uint256)', 'function previewWldLicense(uint256) view returns (uint256,uint256,uint256,uint256,uint256)']
const POOLWLD = ['function getPoolStatus() view returns (uint256,uint256,uint256,uint256,uint256)']
const CORE = [
  'function humanVerified(address) view returns (bool)',
  'function getUserWLDLics(address) view returns (uint256[])',
  'function getUserSushiLics(address) view returns (uint256[])',
  'function wldLics(uint256) view returns (address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)',
  'function pendingWLDHachi(uint256) view returns (uint256)',
  'function monthlyWLDRemaining(address) view returns (uint256,uint256)',
  'function getWLDAvailability() view returns (uint256,uint256)',
  'function getSushiAvailability() view returns (uint256,uint256,uint256,uint256,uint8,uint256,uint256)',
  'function hachiDailyPool() view returns (uint256)',
  'function lastDailySettle(address) view returns (uint256)',
  'function dailyAccrued(address) view returns (uint256)',
  'function pendingDaily(address) view returns (uint256)',
  'function totalDailyClaims() view returns (uint256)',
  'function currentDailyRate() view returns (uint256)',
  'function getSalesStats() view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
  'function getPoolStatus() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
  'function buyLicenseWLD(uint8)',
  'function buyLicenseSushi(uint8)',
  'function claimWLDHachi(uint256)',
  'function withdrawDailyHachi()',
  'function verifyHuman(uint256,uint256,uint256[8])',
  'function startAccrual()',
  'function getHighestActiveWLDType(address) view returns (uint8)',
  'function specialSushiAvailable(address) view returns (bool)',
  'function dailyRate() view returns (uint256)',
  'function dailySushiPurchases(address,uint256,uint8) view returns (uint256)',
  'function lastSpecialSushi(address) view returns (uint256)',
]
const LOCK = [
  'function getPosition(address) view returns (uint256,uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool)',
  'function getUserBatches(address) view returns (uint256[],uint256[],bool[])',
  'function canMine(address) view returns (bool)',
  'function deposit(uint256)', 'function claimAPY()', 'function unstake(uint256)',
  'function totalLocked() view returns (uint256)',
  'function totalUsers() view returns (uint256)',
]
const RANKING = [
  'function getUserStats(address) view returns (uint256,uint256,uint256,uint256,uint8,uint256)',
  'function getCurrentRanking() view returns (address[],uint256[],uint256[],uint8[])',
  'function getPeriodNumber() view returns (uint256)',
  'function timeUntilNextExecution() view returns (uint256)',
  'function lastExecutedAt() view returns (uint256)',
  'function claimPrize()',
  'event PrizePaid(address indexed user, uint256 amount, uint256 rank)',
]
const ADMGR = [
  'function getActiveCampaigns() view returns (uint256[],string[],uint8[],uint256[],uint256[])',
  'function canParticipate(address,uint256) view returns (bool,uint256,uint256)',
  'function previewCampaign(uint8) view returns (uint256,uint256,uint256,uint256)',
  'function participate(uint256)',
  'function createCampaign(uint8,string,string,uint8)',
]
const REFERRAL = [
  'function registerWithReferral(address)',
  'function getReferralInfo(address) view returns (address,uint256,uint256,address[])',
  'function canRegister(address,address) view returns (bool,string)',
  'function currentRefBonus() view returns (uint256)',
  'function currentNewBonus() view returns (uint256)',
]

type Tab = 'home'|'lics'|'lock'|'ranking'|'pools'|'ads'|'refs'
type Lang = 'es'|'en'|'pt'

const TR = {
  es: { connect:'Conectar', verified:'World ID ✓', not_verified:'Sin verificar', daily_claim:'Cobrar 10 HACHI', nav_home:'🏠 Inicio', nav_lics:'📜 Licencias', nav_lock:'🔒 Lock', nav_rank:'🏆 Ranking', nav_pools:'🌊 Pools', nav_ads:'📢 Anuncios', nav_refs:'👥 Referidos', err_connect:'Conecta tu wallet', err_verify:'Verifica tu World ID', err_price:'Ventas pausadas', approving:'Aprobando...', no_lics:'Sin licencias activas', connect_prompt:'Conecta tu wallet para comenzar', access_title:'Acceso restringido', access_desc:'Para licencias SUSHI necesitas 5,000 HACHI lockeados o una licencia WLD activa', day1:'Día 1 — recibís de vuelta', day2:'Día 2 — tu ganancia (24h)' },
  en: { connect:'Connect', verified:'World ID ✓', not_verified:'Not verified', daily_claim:'Claim 10 HACHI', nav_home:'🏠 Home', nav_lics:'📜 Licenses', nav_lock:'🔒 Lock', nav_rank:'🏆 Ranking', nav_pools:'🌊 Pools', nav_ads:'📢 Ads', nav_refs:'👥 Referrals', err_connect:'Connect your wallet', err_verify:'Verify your World ID', err_price:'Sales paused', approving:'Approving...', no_lics:'No active licenses', connect_prompt:'Connect your wallet to start', access_title:'Restricted access', access_desc:'For SUSHI licenses you need 5,000 HACHI locked or an active WLD license', day1:'Day 1 — get back investment', day2:'Day 2 — your profit (24h)' },
  pt: { connect:'Conectar', verified:'World ID ✓', not_verified:'Não verificado', daily_claim:'Cobrar 10 HACHI', nav_home:'🏠 Início', nav_lics:'📜 Licenças', nav_lock:'🔒 Lock', nav_rank:'🏆 Ranking', nav_pools:'🌊 Pools', nav_ads:'📢 Anúncios', nav_refs:'👥 Indicações', err_connect:'Conecte sua carteira', err_verify:'Verifique seu World ID', err_price:'Vendas pausadas', approving:'Aprovando...', no_lics:'Sem licenças ativas', connect_prompt:'Conecte sua carteira para começar', access_title:'Acesso restrito', access_desc:'Para licenças SUSHI você precisa de 5.000 HACHI bloqueados ou uma licença WLD ativa', day1:'Dia 1 — recupere investimento', day2:'Dia 2 — seu lucro (24h)' },
}

const LOGIN = {
  es: {
    tagline: 'Minería de HACHI verificada con World ID en World Chain',
    whatTitle: '¿Qué es HachiMiner?',
    whatDesc: 'HachiMiner es una mini app de World que te permite minar tokens HACHI y operar con licencias WLD y Bocado directamente en World Chain. Compra licencias, bloquea tokens para ganar APY, participa en el ranking y deja que Hachi ahorre HACHI por vos en su alcancía.',
    features: [
      { icon:'📜', title:'Licencias', desc:'Compra tu licencia WLD y obtén beneficios adicionales en Bocados según tu nivel — a mayor nivel, mayor acceso.' },
      { icon:'🔒', title:'Lock & APY', desc:'Bloquea HACHI y gana rendimiento sobre tu posición.' },
      { icon:'🏆', title:'Ranking', desc:'Compite por premios según tu actividad.' },
      { icon:'🐱', title:'Reúne y cobra tus HACHI', desc:'Hachi acumula HACHI por vos automáticamente. Retirá cuando quieras; hay un cooldown de 24h entre retiros.' },
    ],
    stepsTitle: 'Cómo empezar',
    steps: [
      'Conecta tu wallet de World App con un solo toque.',
      'Verifica tu identidad con World ID para desbloquear todo.',
      'Compra licencias o bloquea HACHI y empieza a minar.',
    ],
    cta: 'Conectar wallet',
    ctaWA: 'Iniciar sesión con World App',
    disclaimer: 'Al continuar conectas tu wallet a HachiMiner en World Chain. No custodiamos tus fondos.',
  },
  en: {
    tagline: 'World ID-verified HACHI mining on World Chain',
    whatTitle: 'What is HachiMiner?',
    whatDesc: 'HachiMiner is a World mini app that lets you mine HACHI tokens and trade WLD and Bocado licenses directly on World Chain. Buy licenses, lock tokens to earn APY, climb the ranking, and let Hachi save HACHI for you in his piggy bank.',
    features: [
      { icon:'📜', title:'Licenses', desc:'Buy your WLD license and get extra Bocado benefits based on your tier — higher tier, greater access.' },
      { icon:'🔒', title:'Lock & APY', desc:'Lock HACHI and earn yield on your position.' },
      { icon:'🏆', title:'Ranking', desc:'Compete for prizes based on your activity.' },
      { icon:'🐱', title:'Collect your HACHI', desc:'Hachi accumulates HACHI for you automatically. Withdraw whenever you want; there\'s a 24h cooldown between withdrawals.' },
    ],
    stepsTitle: 'How to start',
    steps: [
      'Connect your World App wallet with a single tap.',
      'Verify your identity with World ID to unlock everything.',
      'Buy licenses or lock HACHI and start mining.',
    ],
    cta: 'Connect wallet',
    ctaWA: 'Sign in with World App',
    disclaimer: 'By continuing you connect your wallet to HachiMiner on World Chain. We never custody your funds.',
  },
  pt: {
    tagline: 'Mineração de HACHI verificada com World ID na World Chain',
    whatTitle: 'O que é o HachiMiner?',
    whatDesc: 'O HachiMiner é um mini app da World que permite minerar tokens HACHI e operar com licenças WLD e Bocado diretamente na World Chain. Compre licenças, bloqueie tokens para ganhar APY, suba no ranking e deixe o Hachi guardar HACHI por você no cofrinho dele.',
    features: [
      { icon:'📜', title:'Licenças', desc:'Compre sua licença WLD e obtenha benefícios extras em Bocados conforme seu nível — quanto maior o nível, maior o acesso.' },
      { icon:'🔒', title:'Lock & APY', desc:'Bloqueie HACHI e ganhe rendimento na sua posição.' },
      { icon:'🏆', title:'Ranking', desc:'Concorra a prêmios conforme sua atividade.' },
      { icon:'🐱', title:'Reúna e resgate seus HACHI', desc:'O Hachi acumula HACHI por você automaticamente. Saque quando quiser; há um cooldown de 24h entre saques.' },
    ],
    stepsTitle: 'Como começar',
    steps: [
      'Conecte sua carteira World App com um toque.',
      'Verifique sua identidade com World ID para desbloquear tudo.',
      'Compre licenças ou bloqueie HACHI e comece a minerar.',
    ],
    cta: 'Conectar carteira',
    ctaWA: 'Entrar com World App',
    disclaimer: 'Ao continuar você conecta sua carteira ao HachiMiner na World Chain. Não custodiamos seus fundos.',
  },
}

const fmt = (n: number) => { if ((!n && n!==0)||isNaN(n)) return '—'; if (n>=1e6) return (n/1e6).toFixed(2)+'M'; if (n>=1e3) return (n/1e3).toFixed(1)+'K'; return Math.round(n).toLocaleString() }
const fmtA = (a: string) => a ? a.slice(0,6)+'...'+a.slice(-4) : '—'
const fe = (v: bigint) => Number(ethers.formatEther(v))
const pe = (v: string|number) => ethers.parseEther(String(v))
const fmtSecs = (s: number) => { if (!s || s <= 0) return '—'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m` }
// nonce alfanumérico de al menos 8 caracteres (requisito de MiniKit v2)
const genNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('')

export default function HachiMiner() {
  const [tab, setTab] = useState<Tab>('home')
  const [licTab, setLicTab] = useState<'wld'|'sushi'>('wld')
  const [lang, setLang] = useState<Lang>('es')
  const [toast, setToast] = useState<{msg:string;color:string}|null>(null)
  const [addr, setAddr] = useState('')
  const [connected, setConnected] = useState(false)
  const [verified, setVerified] = useState(false)
  const [inWA, setInWA] = useState(false)
  const [hachiB, setHachiB] = useState('0')
  const [wldB, setWldB] = useState('0')
  const [sushiB, setSushiB] = useState('0')
  const [wldHachi, setWldHachi] = useState(10000)
  const [hachiSushi, setHachiSushi] = useState(1.5)
  const [oracleSt, setOracleSt] = useState('—')
  const [poolFree, setPoolFree] = useState('—')
  const [licsAvail, setLicsAvail] = useState('—')
  const [priceAlert, setPriceAlert] = useState(false)
  const [piggy, setPiggy] = useState({accrued:0,accrual:100,canWithdraw:false})
  const [selWLD, setSelWLD] = useState(0)
  const [wldPrev, setWldPrev] = useState({base:'—',total:'—',daily:'—',monthly:'—'})
  const [wldLics, setWldLics] = useState<any[]>([])
  const [selSUSHI, setSelSUSHI] = useState(0)
  const [sushiPrev, setSushiPrev] = useState({base:'—',d1:'—',d2:'—',total:'—',dailyLeft:'—'})
  const [sushiAccess, setSushiAccess] = useState(false)
  const [accrualStarted, setAccrualStarted] = useState(true)
  const [lastSettle, setLastSettle] = useState(0)
  const [debugMode] = useState(() => typeof window !== 'undefined' && window.location.search.includes('debug=1'))
  const [wldTierActive, setWldTierActive] = useState<number>(255)
  const [specialAvail, setSpecialAvail] = useState(false)
  const [lastSpecialTs, setLastSpecialTs] = useState(0)
  const [basicBoughtToday, setBasicBoughtToday] = useState(0)
  const [hachiRaw, setHachiRaw] = useState(0)
  const [wldRaw, setWldRaw]     = useState(0)
  const [sushiLics] = useState<any[]>([])
  const [lockData, setLockData] = useState({total:'0',tier:'Sin tier',apy:'0%',pending:'0',unstake:'0',unstakeRaw:BigInt(0),nextClaimIn:'—',nextDepositIn:'—',nextDepositSecs:0})
  const [lockBatches, setLockBatches] = useState<any[]>([])
  const [platformStats, setPlatformStats] = useState({totalLocked:'—',totalUsers:'—'})
  const [depositAmt, setDepositAmt] = useState('')
  const [rankStats, setRankStats] = useState({points:'0',totalHist:'0',pos:'—',reward:'0',earned:'0',nextDist:'—'})
  const [rankList, setRankList] = useState<any[]>([])
  const [lastWinners, setLastWinners] = useState<{addr:string,amount:number,rank:number}[]>([])
  const [refInfo, setRefInfo] = useState({referrer:'',totalRefs:0,earned:'0 HACHI',refBonus:'500',newBonus:'500'})
  const [refFromLink, setRefFromLink] = useState('')
  const [poolsData, setPoolsData] = useState<any>({})
  const [logs, setLogs] = useState<string[]>([])
  const [campaigns, setCampaigns] = useState<any[]>([])
  const [campType, setCampType] = useState(0)
  const [campTitle, setCampTitle] = useState('')
  const [campUrl, setCampUrl] = useState('')
  const [campPlatform, setCampPlatform] = useState(0)
  const [campHPV, setCampHPV] = useState('—')
  const [showVerify, setShowVerify] = useState(false)

  const viemClient = useMemo(() => createPublicClient({
    chain: worldChain as any,
    transport: http(RPC),
  }), [])

  const { poll: pollUserOp } = useUserOperationReceipt({ client: viemClient })

  const log = (m: string) => setLogs(p => [...p.slice(-6), m])
  const t = (k: keyof typeof TR.es) => TR[lang][k] || TR.es[k]
  const loginCopy = LOGIN[lang] || LOGIN.es
  const rpc = () => new ethers.JsonRpcProvider(RPC)
  const toast_ = (msg: string, color='#a78bfa') => { setToast({msg,color}); setTimeout(()=>setToast(null),4000) }

  // 1) Inicializar MiniKit (OBLIGATORIO en v2 antes de cualquier comando)
  // 2) Si estamos dentro de World App, conectar automáticamente
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const init = async () => {
      const refParam = new URLSearchParams(window.location.search).get('ref')
      if (refParam && /^0x[0-9a-fA-F]{40}$/i.test(refParam)) setRefFromLink(refParam)
      try {
        MiniKit.install(APP_ID)
      } catch (e: any) {
        log('install err: ' + (e?.message||'').slice(0,40))
      }
      // isInstalled() = true solo dentro de World App.
      // Reintentamos porque puede dar false en el primer render
      // antes de que install() termine de inicializar.
      let installed = MiniKit.isInstalled()
      for (let i = 0; i < 5 && !installed; i++) {
        await new Promise(r => setTimeout(r, 300))
        installed = MiniKit.isInstalled()
      }
      log('isInstalled: ' + installed)
      setInWA(installed)
    }
    init()
    return () => { if (timer) clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (wldHachi <= 0) return
    const px = [1,3,5,10][selWLD]
    const base = px * wldHachi
    const mult = selWLD === 3 ? 1.35 : 1.30
    const total = Math.round(base * mult)
    const perDay = Math.round(total / 90)
    setWldPrev(p => ({...p, base:fmt(base)+' HACHI', total:fmt(total)+' HACHI', daily:'~'+fmt(perDay)+' HACHI/día'}))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selWLD, wldHachi])

  useEffect(() => {
    if (hachiSushi <= 0) return
    const sushiBase = [500,2000,5000,10000][selSUSHI] * hachiSushi
    const total     = sushiBase * 1.25
    setSushiPrev(p => ({...p, base:Math.round(sushiBase).toLocaleString()+' SUSHI', total:Math.round(total).toLocaleString()+' SUSHI'}))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selSUSHI, hachiSushi])


  // Devuelve la dirección conectada o '' si falla
  const connectMiniKit = async (): Promise<string> => {
    try {
      if (!MiniKit.isInstalled()) {
        log('walletAuth: no estás en World App')
        return ''
      }
      log('intentando walletAuth...')
      const walletAuthResult = await MiniKit.walletAuth({
        nonce: genNonce(),
        statement: 'HachiMiner',
        expirationTime: new Date(Date.now() + 7*24*60*60*1000),
        notBefore: new Date(Date.now() - 60*1000),
      })
      log('walletAuth executedWith: ' + walletAuthResult.executedWith)
      // v2: la dirección viene en walletAuthResult.data.address
      const walletAddr = walletAuthResult.data.address || MiniKit.user?.walletAddress || ''
      if (walletAddr) {
        log('addr: ' + walletAddr.slice(0,10))
        setAddr(walletAddr)
        setConnected(true)
        setInWA(true)
        // NO marcamos verified aquí. El estado real de verificación World ID
        // se lee on-chain en checkVerif (humanVerified). Si lo forzamos a true
        // sin que verifyHuman se haya ejecutado, las compras revierten on-chain
        // ("transacción inválida"/pantalla en blanco) y el usuario pierde gas.
        toast_('Conectado: ' + fmtA(walletAddr), '#3fb950')
        await loadAll(walletAddr)
        return walletAddr
      }
      log('walletAuth sin address')
      return ''
    } catch(e: any) {
      log('walletAuth err: ' + (e?.message||'').slice(0,50))
      return ''
    }
  }

  const connectWallet = useCallback(async () => {
    // Dentro de World App → usar MiniKit
    if (MiniKit.isInstalled()) {
      const a = await connectMiniKit()
      if (a) return
      toast_('No se pudo conectar con World App', '#f85149')
      return
    }
    // Fuera de World App → fallback MetaMask / navegador
    const eth = (window as any).ethereum
    if (!eth) { toast_('Abre esta app dentro de World App', '#f85149'); return }
    try {
      await eth.request({method:'eth_requestAccounts'})
      const chainId = await eth.request({method:'eth_chainId'})
      if (chainId !== '0x1E0') {
        try { await eth.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x1E0'}]}) }
        catch { await eth.request({method:'wallet_addEthereumChain',params:[{chainId:'0x1E0',chainName:'World Chain',rpcUrls:[RPC],nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},blockExplorerUrls:['https://worldscan.org']}]}) }
      }
      const provider = new ethers.BrowserProvider(eth)
      const signer = await provider.getSigner()
      const address = await signer.getAddress()
      setAddr(address); setConnected(true)
      toast_('Conectado: ' + fmtA(address), '#3fb950')
      await loadAll(address)
      setInterval(() => loadAll(address), 30000)
    } catch(e: any) { toast_('Error: ' + (e.message||'').slice(0,50), '#f85149') }
  }, [lang])

  const loadAll = async (address: string) => {
    const p = rpc()
    await Promise.allSettled([loadBal(address,p), loadOracle(address,p), checkVerif(address,p), checkDaily(address,p), loadPools(p), loadLock(p)])
  }

  const loadBal = async (a: string, p: ethers.JsonRpcProvider) => {
    try {
      const [h,w,s] = await Promise.all([
        new ethers.Contract(C.hachi,ERC20,p).balanceOf(a),
        new ethers.Contract(C.wld,ERC20,p).balanceOf(a),
        new ethers.Contract(C.sushi,ERC20,p).balanceOf(a),
      ])
      const hN=fe(h), wN=fe(w)
      setHachiB(fmt(hN)); setWldB(fmt(wN)); setSushiB(fmt(fe(s)))
      setHachiRaw(hN); setWldRaw(wN)
    } catch(e) {}
  }

  const loadOracle = async (a: string, p: ethers.JsonRpcProvider) => {
    try {
      const r = await new ethers.Contract(C.oracle,ORACLE,p).getRates()
      const wh=fe(r[0]),hs=fe(r[1])
      setWldHachi(wh); setHachiSushi(hs); setOracleSt(r[3]?'Manual':'DEX en vivo ✓'); setPriceAlert(wh>MAX_HACHI)
      const ws = await new ethers.Contract(C.poolWLD,POOLWLD,p).getPoolStatus()
      const hf=fe(ws[1]), costPerLic=wh*1.30, lb=costPerLic>0?Math.floor(hf/costPerLic):0
      setPoolFree(fmt(hf)+' HACHI'); setLicsAvail(lb>0?lb+' lics. básicas':'0 (sin fondos)')
    } catch(e) {}
  }

  const checkVerif = async (a: string, _p: ethers.JsonRpcProvider) => {
    try {
      const v = await getIsUserVerified(a)
      setVerified(!!v)
    } catch(e) {}
  }

  const checkDaily = async (a: string, p: ethers.JsonRpcProvider) => {
    try {
      const core = new ethers.Contract(C.core, CORE, p)
      const [pending, rate, settle] = await Promise.all([
        core.pendingDaily(a), core.currentDailyRate(), core.lastDailySettle(a)
      ])
      const pendingN = Number(fe(pending)), rateN = Number(fe(rate)), settleN = Number(settle)
      setLastSettle(settleN)
      setAccrualStarted(settleN > 0)
      const cooldownOk = settleN === 0 || Math.floor(Date.now()/1000) >= settleN + 86400
      setPiggy({accrued:pendingN, accrual:rateN, canWithdraw:pendingN>0 && cooldownOk})
    } catch(e) {}
    let tierNum = 255, canMineOk = false
    try {
      const core = new ethers.Contract(C.core, CORE, p)
      const today = BigInt(Math.floor(Date.now() / 86400000))
      const [sa, tier, specAvail, bought, lastSpec] = await Promise.all([
        core.getSushiAvailability(),
        core.getHighestActiveWLDType(a),
        core.specialSushiAvailable(a),
        core.dailySushiPurchases(a, today, 0),
        core.lastSpecialSushi(a),
      ])
      tierNum = Number(tier)
      setWldTierActive(tierNum)
      setSpecialAvail(Boolean(specAvail))
      setBasicBoughtToday(Number(bought))
      setLastSpecialTs(Number(lastSpec))
    } catch(e: any) { log('checkDaily core err: '+(e?.message||'').slice(0,80)) }
    try {
      const ok = await new ethers.Contract(C.lock, LOCK, p).canMine(a)
      canMineOk = Boolean(ok)
    } catch(e: any) { log('canMine err: '+(e?.message||'').slice(0,80)) }
    setSushiAccess(tierNum !== 255 || canMineOk)
  }

  // Interpreta el finalPayload de MiniKit.commandsAsync.* (v1.11) y lanza un error legible.
  const handleMiniKitResult = (finalPayload: any) => {
    const status = finalPayload?.status
    log('full payload: ' + JSON.stringify(finalPayload))
    log('res status: '+status)
    if (!finalPayload || status === 'error') {
      const code = finalPayload?.error_code || 'error'
      const detail = finalPayload?.details ? ' '+JSON.stringify(finalPayload.details) : ''
      throw new Error(code+detail)
    }
    return finalPayload
  }

  // Envío de transacciones — codificamos calldata con encodeFunctionData de viem y enviamos
  // { address, data } para evitar que MiniKit inspeccione el nombre de la función.
  // Tras recibir el transaction_id de MiniKit, hacemos polling hasta confirmar el minado on-chain.
  const sendTx = async (contractAddr: string, abi: string[], fnName: string, args: any[]) => {
    log('tx: '+fnName+' inWA:'+inWA)
    if (MiniKit.isInstalled()) {
      const data = encodeFunctionData({ abi: parseAbi(abi), functionName: fnName as any, args })
      const txResult = await MiniKit.sendTransaction({
        transactions: [{ to: contractAddr, data }],
        chainId: WORLDCHAIN_ID,
      })
      log('polling receipt: '+txResult.data.userOpHash?.slice(0,12))
      await pollUserOp(txResult.data.userOpHash)
      return txResult.data
    } else {
      const eth = (window as any).ethereum
      if (!eth) throw new Error('No wallet')
      const provider = new ethers.BrowserProvider(eth)
      const signer = await provider.getSigner()
      const contract = new ethers.Contract(contractAddr, abi, signer)
      const tx = await contract[fnName](...args)
      return tx.wait()
    }
  }

  // Envía varias llamadas en UNA sola transacción (batch atómico de World App). Necesario para
  // approve + acción juntos; si se envían por separado muestra pantalla en blanco.
  // Soporta calls con calldata precodificada { to, data } (Permit2 approve) y calls con
  // ABI declarativo { to, abi, fnName, args } (funciones de nuestros contratos).
  // Incluye polling on-chain tras recibir el transaction_id de MiniKit.
  const sendTxMulti = async (calls: ({ to: string; data: `0x${string}` } | { to: string; abi: string[]; fnName: string; args: any[] })[]) => {
    if (MiniKit.isInstalled()) {
      const txs = calls.map((c) => {
        if ('data' in c) return { to: c.to, data: c.data }
        const data = encodeFunctionData({ abi: parseAbi(c.abi), functionName: c.fnName as any, args: c.args })
        return { to: c.to, data }
      })
      const txResult = await MiniKit.sendTransaction({
        transactions: txs,
        chainId: WORLDCHAIN_ID,
      })
      log('polling receipt: '+txResult.data.userOpHash?.slice(0,12))
      await pollUserOp(txResult.data.userOpHash)
      return txResult.data
    } else {
      // MetaMask no soporta batch: enviamos secuencialmente
      for (const c of calls) {
        if ('data' in c) {
          const eth = (window as any).ethereum
          if (!eth) throw new Error('No wallet')
          const provider = new ethers.BrowserProvider(eth)
          const signer = await provider.getSigner()
          const tx = await signer.sendTransaction({ to: c.to, data: c.data })
          await tx.wait()
        } else {
          await sendTx(c.to, c.abi, c.fnName, c.args)
        }
      }
    }
  }

  // Construye los calls de aprobacion Permit2 para un pago (patron AllowanceTransfer ON-CHAIN).
  // IMPORTANTE — contexto World App:
  //  - El error MiniKit `invalid_contract` significa "el contrato no esta permitido en el
  //    Developer Portal". Solo estan whitelisteados nuestros 5 contratos + Permit2, NO los tokens.
  //  - Por eso NO podemos (ni necesitamos) hacer ERC20.approve(PERMIT2): llamaria al contrato
  //    del token (no whitelisteado) y la tx entera falla con invalid_contract.
  //  - Las smart wallets de World App YA tienen el token pre-aprobado a Permit2 automaticamente,
  //    asi que el unico paso necesario es PERMIT2.approve(token, spender, amount, expiration),
  //    que autoriza a NUESTRO contrato a jalar via Permit2.transferFrom. (Esta es la version que
  //    permitio comprar la primera licencia con exito.)
  //  - La expiracion debe ser FUTURA (uint48) pero CORTA: World App rechaza deadlines lejanos
  //    con el error `permit_deadline_too_long`. Usamos 30 minutos, suficiente para firmar y
  //    ejecutar la tx en el mismo flujo.
  const MAX_UINT160 = (BigInt(1) << BigInt(160)) - BigInt(1)
  const PERMIT2_APPROVE_ABI = [{ name: 'approve', type: 'function' as const, inputs: [{name:'token',type:'address'},{name:'spender',type:'address'},{name:'amount',type:'uint160'},{name:'expiration',type:'uint48'}], outputs: [], stateMutability: 'nonpayable' as const }]
  const buildPermit2Approvals = (token: string, spender: string, amount: bigint) => {
    const amt160 = amount > MAX_UINT160 ? MAX_UINT160 : amount
    const data = encodeFunctionData({ abi: PERMIT2_APPROVE_ABI, functionName: 'approve', args: [token as `0x${string}`, spender as `0x${string}`, amt160, 0] })
    return [
      { to: C.permit2, data },
    ]
  }


  const execTx = async (label: string, contractAddr: string, abi: string[], fnName: string, args: any[]) => {
    try {
      log('→ '+fnName); toast_(label+'...', '#d29922')
      await sendTx(contractAddr, abi, fnName, args)
      log('✓ '+fnName); toast_('✓ '+label, '#3fb950')
      await loadAll(addr); return true
    } catch(e: any) {
      const err = e.reason||e.message||'error'
      log('✗ '+err.slice(0,60)); toast_('Error: '+err.slice(0,80), '#f85149'); return false
    }
  }

  const buyWLD = async () => {
    if (!connected) { toast_(t('err_connect'),'#f85149'); return }
    if (wldHachi>MAX_HACHI) { toast_(t('err_price'),'#f85149'); return }
    const wldNeeded = [1,3,5,10][selWLD]
    if (wldRaw < wldNeeded) { toast_(`Sin saldo WLD suficiente (necesitás ${wldNeeded} WLD)`,'#f85149'); return }
    try {
      toast_('Comprando licencia WLD...', '#d29922')
      const amt = [pe(1),pe(3),pe(5),pe(10)][selWLD]
      await sendTxMulti([
        ...buildPermit2Approvals(C.wld, C.core, amt),
        { to: C.core, abi: CORE, fnName: 'buyLicenseWLD', args: [selWLD] },
      ])
      toast_('✓ Licencia WLD comprada', '#3fb950')
      await loadAll(addr)
    } catch(e: any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149') }
  }

  const buySUSHI = async () => {
    if (!connected) { toast_(t('err_connect'),'#f85149'); return }
    const hachiNeeded = [500,2000,5000,10000][selSUSHI]
    if (hachiRaw < hachiNeeded) { toast_(`Sin saldo HACHI. Comprá HACHI: ${HACHI_BUY_URL}`,'#f85149'); return }
    try {
      toast_('Comprando Bocado...', '#d29922')
      const amt = [pe(500),pe(2000),pe(5000),pe(10000)][selSUSHI]
      await sendTxMulti([
        ...buildPermit2Approvals(C.hachi, C.core, amt),
        { to: C.core, abi: CORE, fnName: 'buyLicenseSushi', args: [selSUSHI] },
      ])
      toast_('✓ Bocado comprado', '#3fb950')
      await loadAll(addr)
    } catch(e: any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149') }
  }

  const withdrawDaily = async () => {
    if (piggy.accrued <= 0) { toast_('No hay HACHI acumulado para retirar','#f85149'); return }
    try {
      toast_('Retirando acumulador...', '#d29922')
      await sendTx(C.core, CORE, 'withdrawDailyHachi', [])
      toast_('✓ HACHI retirado a tu wallet', '#3fb950')
      await loadAll(addr)
    } catch(e: any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149') }
  }
  const startAccrualFn = async () => {
    try {
      toast_('Activando acumulador...', '#d29922')
      await sendTx(C.core, CORE, 'startAccrual', [])
      toast_('✓ Acumulador activado', '#3fb950')
      setAccrualStarted(true)
      await loadAll(addr)
    } catch(e: any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149') }
  }
  const claimWLD = (id: bigint) => execTx('Cobrando HACHI', C.core, CORE, 'claimWLDHachi', [id])
  const doDeposit = async () => {
    if (!depositAmt||Number(depositAmt)<=0) { toast_('Ingresa un monto válido','#f85149'); return }
    try {
      toast_('Depositando HACHI...', '#d29922')
      await sendTxMulti([
        ...buildPermit2Approvals(C.hachi, C.lock, pe(depositAmt)),
        { to: C.lock, abi: LOCK, fnName: 'deposit', args: [pe(depositAmt)] },
      ])
      toast_('✓ Depositando HACHI', '#3fb950')
      setDepositAmt('')
      await loadAll(addr)
    } catch(e: any) {
      const err = e.reason||e.message||'error'
      toast_('Error: '+err.slice(0,80), '#f85149')
    }
  }
  const claimAPY = () => execTx('Cobrando APY', C.lock, LOCK, 'claimAPY', [])
  const doUnstake = async () => {
    if (lockData.unstakeRaw <= BigInt(0)) { toast_('No tenés HACHI disponible para retirar todavía','#f85149'); return }
    await execTx('Retirando HACHI del lock', C.lock, LOCK, 'unstake', [lockData.unstakeRaw])
  }
  const claimPrize = () => execTx('Cobrando premio', C.ranking, RANKING, 'claimPrize', [])

  const loadTab = async (v: Tab) => {
    setTab(v); if (!connected) return
    const p = rpc()
    if (v==='lics') loadWLDLics(p)
    if (v==='lock') loadLock(p)
    if (v==='ranking') loadRanking(p)
    if (v==='pools') loadPools(p)
    if (v==='ads') loadAds(p)
    if (v==='refs') loadRefs(p)
  }

  const loadWLDLics = async (p: ethers.JsonRpcProvider) => {
    try {
      const core = new ethers.Contract(C.core,CORE,p)
      const px = [1,3,5,10][selWLD]
      let base=px*wldHachi, total=Math.round(base*1.3), perDay=Math.round(total/90)
      try { const prev=await new ethers.Contract(C.oracle,ORACLE,p).previewWldLicense(pe(px)); base=fe(prev[0]); total=fe(prev[1]); perDay=fe(prev[2]) } catch(e) {}
      const monthly = await core.monthlyWLDRemaining(addr).catch(() => [BigInt(5),BigInt(0)])
      setWldPrev({base:fmt(base)+' HACHI', total:fmt(total)+' HACHI', daily:'~'+fmt(perDay)+' HACHI/día', monthly:Number(monthly[1])+'/5 usadas · quedan '+Number(monthly[0])})
      const ids = await core.getUserWLDLics(addr)
      const lics = await Promise.all(ids.map(async(id:bigint) => ({id, l:await core.wldLics(id), pend:await core.pendingWLDHachi(id)})))
      setWldLics(lics.filter((x:any) => x.l[10]||x.l[11]))
    } catch(e) {}
  }

  const loadLock = async (p: ethers.JsonRpcProvider) => {
    try {
      const lock = new ethers.Contract(C.lock,LOCK,p)
      const pos = await lock.getPosition(addr)
      const depSecs=Number(pos[5])
    setLockData({total:fmt(fe(pos[0]))+' HACHI', tier:['Sin tier','Akira','Zen','Koban','Tayko','Hachi'][pos[3]], apy:pos[4].toString()+'% APY', pending:fe(pos[2]).toFixed(4)+' HACHI', unstake:fmt(fe(pos[1]))+' HACHI', unstakeRaw:pos[1], nextDepositIn:fmtSecs(depSecs), nextDepositSecs:depSecs, nextClaimIn:fmtSecs(Number(pos[6]))})
      const b = await lock.getUserBatches(addr)
      setLockBatches(b[0].map((a:bigint,i:number) => ({amount:fe(a), unlocks:new Date(Number(b[1][i])*1000), ready:b[2][i]})).filter((x:any) => x.amount>0))
    } catch(e) {}
    try {
      const lock = new ethers.Contract(C.lock,LOCK,p)
      const [tl, tu] = await Promise.all([lock.totalLocked(), lock.totalUsers()])
      setPlatformStats({totalLocked:fmt(fe(tl))+' HACHI', totalUsers:tu.toString()})
    } catch(e) {}
  }

  const loadRanking = async (p: ethers.JsonRpcProvider) => {
    const r = new ethers.Contract(C.ranking, RANKING, p)
    let myPts = 0, totalHist = '0', reward = '—', earned = '—', pos = '—', nextDist = '—', lastExecTs = 0
    try {
      const s = await r.getUserStats(addr)
      myPts     = Number(s[0])
      totalHist = fmt(Number(s[1])) + ' pts'
      reward    = fmt(fe(s[2])) + ' HACHI'
      earned    = fmt(fe(s[3])) + ' HACHI'
    } catch(e: any) { log('ranking getUserStats err: '+(e?.message||'').slice(0,60)) }
    try {
      const rk = await r.getCurrentRanking()
      const list = rk[0].map((a:string,i:number) => ({a,pts:Number(rk[1][i])})).filter((e:any) => e.pts>0).sort((a:any,b:any) => b.pts-a.pts)
      const idx = list.findIndex((e:any) => e.a.toLowerCase()===addr.toLowerCase())
      pos = idx>=0 ? '#'+(idx+1) : '—'
      setRankList(list)
    } catch(e: any) { log('ranking getCurrentRanking err: '+(e?.message||'').slice(0,60)) }
    try {
      const [nextT, lastExec] = await Promise.all([r.timeUntilNextExecution(), r.lastExecutedAt()])
      lastExecTs = Number(lastExec)
      const secs = Number(nextT), d=Math.floor(secs/86400), h=Math.floor((secs%86400)/3600)
      const nextDate = secs>0 ? new Date(Date.now()+secs*1000).toLocaleString('es',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : ''
      if (secs > 0)              nextDist = `${d}d ${h}h (${nextDate})`
      else if (lastExecTs === 0) nextDist = 'Primer reparto disponible'
      else                       nextDist = 'Disponible'
    } catch(e: any) { log('ranking timeUntilNext err: '+(e?.message||'').slice(0,60)) }
    try {
      if (lastExecTs > 0) {
        const currentBlock = await p.getBlockNumber()
        const blocksAgo = Math.ceil((Date.now()/1000 - lastExecTs) / 2)
        const est = currentBlock - blocksAgo
        const fromBlock = Math.max(0, est - 40)
        const toBlock   = est + 40
        log(`lastWinners range: from=${fromBlock} to=${toBlock} est=${est} blocksAgo=${blocksAgo}`)
        const logs = await r.queryFilter('PrizePaid', fromBlock, toBlock)
        log(`lastWinners raw logs: ${logs.length}`)
        const winners = (logs as any[])
          .map(l => ({addr: l.args[0], amount: Number(l.args[1])/1e18, rank: Number(l.args[2])}))
          .filter(w => w.rank <= 10)
          .sort((a,b) => a.rank - b.rank)
        log(`lastWinners after filter: ${winners.length}`)
        setLastWinners(winners)
      } else {
        log('lastWinners: lastExecTs=0, skipping')
      }
    } catch(e: any) {
      log('lastWinners err: '+(e?.message||'').slice(0,80))
      try { log('lastWinners err detail: '+JSON.stringify(e).slice(0,120)) } catch {}
    }
    setRankStats({points:fmt(myPts), totalHist, pos, reward, earned, nextDist})
  }

  const loadPools = async (p: ethers.JsonRpcProvider) => {
  try {
  const ws = await new ethers.Contract(C.poolWLD,POOLWLD,p).getPoolStatus()
  const core = new ethers.Contract(C.core,CORE,p)
  // Pool A (ciclos SUSHI). Pool C / perpetuo fue ELIMINADO del contrato (pago unico inmediato),
  // por eso ya no lo mostramos. getPoolStatus aun devuelve poolC=0 por compatibilidad, lo ignoramos.
  let poolA='—',poolAC='—',poolAF='—',sushiAvail='—'
  try {
    const ps=await core.getPoolStatus()
    poolA=fmt(fe(ps[0]))+' SUSHI'; poolAC=fmt(fe(ps[1]))+' SUSHI'; poolAF=fmt(fe(ps[2]))+' SUSHI'
    const sa=await core.getSushiAvailability()
    sushiAvail=sa[1].toString()
  } catch(e:any) { log('poolStatus err: '+(e.message||'').slice(0,40)) }
  const st = await core.getSalesStats()
  // Compute licsAvail locally — do not use the React state variable, which may be stale
  // when loadPools and loadOracle run in parallel (loadAll) or when loadPools runs alone (loadTab).
  let localLicsAvail = '—'
  try {
    const r = await new ethers.Contract(C.oracle,ORACLE,p).getRates()
    const hf=fe(ws[1]), wh=fe(r[0]), costPerLic=wh*1.30
    const n = costPerLic>0 ? Math.floor(hf/costPerLic) : 0
    localLicsAvail = n > 0 ? n + ' lics. básicas' : '0 (sin fondos)'
  } catch(e) {}
  setPoolsData({wldTotal:fmt(fe(ws[0]))+' HACHI', wldComm:fmt(fe(ws[2]))+' HACHI', wldFree:fmt(fe(ws[1]))+' HACHI', wldPaid:fmt(fe(ws[3]))+' HACHI', poolA, poolAC, poolAF, sushiAvail, wldSales:fmt(fe(st[0]))+' WLD', wldLics:st[2].toString(), sushiLics:st[3].toString(), burned:fmt(fe(st[4]))+' HACHI', licsAvail:localLicsAvail})
  } catch(e:any) { log('loadPools err: '+(e.message||'error').slice(0,50)) }
  }

  const loadAds = async (p: ethers.JsonRpcProvider) => {
    try {
      const ad = new ethers.Contract(C.adMgr,ADMGR,p)
      const c = await ad.getActiveCampaigns()
      if (!c[0].length) { setCampaigns([]); return }
      const items = await Promise.all(c[0].map(async(id:bigint,i:number) => {
        let canPart=false,waitH=0,reward:bigint=BigInt(0)
        try { const cp=await ad.canParticipate(addr,id); canPart=cp[0]; waitH=Math.ceil(Number(cp[1])/3600); reward=cp[2] } catch(e) {}
        return {id, title:c[1][i], platform:Number(c[2][i]), views:Number(c[3][i]), reward:reward||c[4][i], canPart, waitH}
      }))
      setCampaigns(items)
      try { const prev=await ad.previewCampaign(campType); setCampHPV(fmt(fe(prev[3]))+' HACHI') } catch(e) {}
    } catch(e) {}
  }

  const participateAd = async (id: bigint) => { await execTx('Sumando a la alcancía',C.adMgr,ADMGR,'participate',[id]); loadAds(rpc()); if(addr) loadAll(addr) }

  const loadRefs = async (p: ethers.JsonRpcProvider) => {
    try {
      const rf = new ethers.Contract(C.referral,REFERRAL,p)
      const [info,refB,newB] = await Promise.all([rf.getReferralInfo(addr), rf.currentRefBonus(), rf.currentNewBonus()])
      setRefInfo({
        referrer: info[0]!=='0x0000000000000000000000000000000000000000'?info[0]:'',
        totalRefs: Number(info[1]),
        earned: fmt(fe(info[2]))+' HACHI',
        refBonus: fmt(fe(refB)),
        newBonus: fmt(fe(newB)),
      })
    } catch(e) {}
  }
  const registerReferral = async () => {
    const ref = refFromLink.trim()
    if (!ethers.isAddress(ref)) { toast_('Link de invitación inválido','#f85149'); return }
    try {
      const rf = new ethers.Contract(C.referral,REFERRAL,rpc())
      const [ok,reason] = await rf.canRegister(addr,ref)
      if (!ok) { toast_(reason||'No podés registrarte','#f85149'); return }
      await execTx('Registrando referido',C.referral,REFERRAL,'registerWithReferral',[ref])
      loadRefs(rpc())
    } catch(e:any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80),'#f85149') }
  }
  const createCampaign = async () => {
    if (!campTitle||!campUrl) { toast_('Completa todos los campos','#f85149'); return }
    try {
      toast_('Creando campaña...', '#d29922')
  const amt = [pe(5),pe(10),pe(20),pe(50)][campType]
  await sendTxMulti([
  ...buildPermit2Approvals(C.wld, C.adMgr, amt),
  { to: C.adMgr, abi: ADMGR, fnName: 'createCampaign', args: [campType,campTitle,campUrl,campPlatform] },
  ])
      toast_('✓ Campaña creada', '#3fb950')
      setCampTitle(''); setCampUrl(''); loadAds(rpc())
    } catch(e: any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149') }
  }

  const wldNames = ['🌱 Básica','⚡ Estándar','💎 Premium','🚀 Elite']
  const wldPrices = ['1 WLD','3 WLD','5 WLD','10 WLD']
  const sushiNames = ['🌱 Bocado','⚡ Bocado Doble','💎 Bocado Grande','🚀 Bocado Real']
  const sushiPrices = ['500 HACHI','2,000 HACHI','5,000 HACHI','10,000 HACHI']

  // PANTALLA DE INICIO DE SESIÓN — se muestra mientras no haya wallet conectada
  if (!connected) {
    return (
      <div style={{minHeight:'100vh',background:'linear-gradient(160deg,#2a1f63 0%,#1d1a52 55%,#2b2c78 100%)',color:'#e6edf3',fontFamily:'Georgia,serif',display:'flex',flexDirection:'column'}}>
        {toast&&<div style={{position:'fixed',top:16,right:16,zIndex:999,padding:'10px 16px',borderRadius:8,background:'#161b22',border:`1px solid ${toast.color}`,color:toast.color,fontSize:13,maxWidth:320}}>{toast.msg}</div>}

        {/* selector de idioma arriba a la derecha */}
        <div style={{display:'flex',justifyContent:'flex-end',gap:4,padding:16}}>
          {(['es','en','pt'] as Lang[]).map(l=><button key={l} onClick={()=>setLang(l)} style={{background:'none',border:`1px solid ${lang===l?'#a78bfa':'#30363d'}`,borderRadius:4,padding:'2px 8px',fontSize:11,cursor:'pointer',color:lang===l?'#e6edf3':'#8b949e'}}>{l.toUpperCase()}</button>)}
        </div>

        <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'8px 20px 40px',maxWidth:480,margin:'0 auto',width:'100%'}}>

          {/* HERO */}
          <div style={{fontSize:56,marginBottom:8,filter:'drop-shadow(0 0 20px rgba(232,121,249,.6))'}}>⛏</div>
          <h1 style={{fontSize:34,fontWeight:700,color:'#e879f9',textShadow:'0 0 18px rgba(232,121,249,.5)',margin:'0 0 8px',textAlign:'center'}}>HachiMiner</h1>
          <p style={{fontSize:15,color:'#c4b5fd',fontStyle:'italic',textAlign:'center',margin:'0 0 28px',lineHeight:1.5,maxWidth:360}}>{loginCopy.tagline}</p>

          {/* QUÉ ES */}
          <div style={{...card,width:'100%'}}>
            <div style={cTitle}>{loginCopy.whatTitle}</div>
            <p style={{fontSize:13,color:'#c9d1d9',lineHeight:1.6,margin:0}}>{loginCopy.whatDesc}</p>
          </div>

          {/* FEATURES */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,width:'100%',marginBottom:12}}>
            {loginCopy.features.map((f,i)=>(
              <div key={i} style={{background:'#1e0840',border:'1px solid #5b21b6',borderRadius:10,padding:14,boxShadow:'0 0 12px rgba(124,58,237,.2)'}}>
                <div style={{fontSize:22,marginBottom:6}}>{f.icon}</div>
                <div style={{fontSize:13,fontWeight:700,color:'#e6edf3',marginBottom:3}}>{f.title}</div>
                <div style={{fontSize:11,color:'#8b949e',lineHeight:1.5}}>{f.desc}</div>
              </div>
            ))}
          </div>

          {/* PASOS */}
          <div style={{...card,width:'100%'}}>
            <div style={cTitle}>{loginCopy.stepsTitle}</div>
            {loginCopy.steps.map((s,i)=>(
              <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'6px 0'}}>
                <div style={{flexShrink:0,width:22,height:22,borderRadius:'50%',background:'#7c3aed',color:'#fff',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 0 10px rgba(124,58,237,.5)'}}>{i+1}</div>
                <div style={{fontSize:13,color:'#c9d1d9',lineHeight:1.5}}>{s}</div>
              </div>
            ))}
          </div>

          {/* CTA */}
          <button onClick={connectWallet} style={{...btnP,marginTop:8,fontSize:15,padding:'14px 16px'}}>
            {inWA ? loginCopy.ctaWA : loginCopy.cta}
          </button>
          <p style={{fontSize:11,color:'#8b949e',textAlign:'center',marginTop:12,lineHeight:1.5}}>{loginCopy.disclaimer}</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{minHeight:'100vh',background:'linear-gradient(160deg,#2a1f63 0%,#1d1a52 55%,#2b2c78 100%)',color:'#e6edf3',fontFamily:'Georgia,serif'}}>
      {toast&&<div style={{position:'fixed',top:16,right:16,zIndex:999,padding:'10px 16px',borderRadius:8,background:'#161b22',border:`1px solid ${toast.color}`,color:toast.color,fontSize:13,maxWidth:320}}>{toast.msg}</div>}

      {/* POPUP VERIFICACION WORLD ID */}
      {showVerify&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:500,display:'flex',alignItems:'center',justifyContent:'center'}}>
          <div style={{background:'#1e0840',border:'1px solid #5b21b6',borderRadius:16,padding:32,maxWidth:360,width:'90%',textAlign:'center'}}>
            <div style={{fontSize:32,marginBottom:12}}>🌍</div>
            <div style={{fontWeight:700,fontSize:18,marginBottom:8}}>Verificar World ID</div>
            <div style={{fontSize:13,color:'#9b96c4',marginBottom:24}}>Tu verificación World ID se detecta automáticamente si tu wallet fue verificada con Orb en World App. No necesitás hacer nada aquí.</div>
            <button onClick={()=>setShowVerify(false)} style={btnGh}>Cerrar</button>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div style={{background:'#211a55',borderBottom:'1px solid #4c3a8f',padding:'8px 14px',position:'sticky',top:0,zIndex:100}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,marginBottom:connected?8:0}}>
          <div style={{fontSize:18,fontWeight:700,color:'#e879f9',textShadow:'0 0 12px rgba(232,121,249,.5)',whiteSpace:'nowrap'}}>⛏ HachiMiner</div>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <div style={{display:'flex',gap:4}}>
              {(['es','en','pt'] as Lang[]).map(l=><button key={l} onClick={()=>setLang(l)} style={{background:'none',border:`1px solid ${lang===l?'#a78bfa':'#3a3470'}`,borderRadius:4,padding:'2px 6px',fontSize:11,cursor:'pointer',color:lang===l?'#e6edf3':'#9b96c4'}}>{l.toUpperCase()}</button>)}
            </div>
            <button onClick={connectWallet} style={{background:'#7c3aed',color:'#fff',border:'none',borderRadius:8,padding:'7px 14px',fontSize:13,fontWeight:600,cursor:'pointer',boxShadow:'0 0 14px rgba(124,58,237,.5)',whiteSpace:'nowrap'}}>{connected?fmtA(addr):t('connect')}</button>
          </div>
        </div>
        {connected&&<div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
          <div style={{display:'flex',gap:16}}>{[['HACHI',hachiB],['WLD',wldB],['SUSHI',sushiB]].map(([l,v])=><div key={l} style={{display:'flex',flexDirection:'column'}}><div style={{fontSize:9,color:'#9b96c4',textTransform:'uppercase',letterSpacing:.5}}>{l}</div><div style={{fontFamily:'monospace',fontSize:13,fontWeight:600}}>{v}</div></div>)}</div>
          <div onClick={()=>!verified&&setShowVerify(true)} style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:'#9b96c4',cursor:'pointer',whiteSpace:'nowrap'}}><div style={{width:7,height:7,borderRadius:'50%',background:verified?'#3fb950':'#6b6494'}}></div><span>{verified?t('verified'):t('not_verified')}</span></div>
        </div>}
      </div>

      {/* NAV */}
      <div style={{background:'#12022a',borderBottom:'1px solid #3b0764',display:'flex',overflowX:'auto',gap:2,padding:'0 12px'}}>
        {(['home','lics','lock','ranking','pools','ads','refs'] as Tab[]).map((v,i)=>{
          const labels=[t('nav_home'),t('nav_lics'),t('nav_lock'),t('nav_rank'),t('nav_pools'),t('nav_ads'),t('nav_refs')]
          return <button key={v} onClick={()=>loadTab(v)} style={{background:'none',border:'none',borderBottom:`2px solid ${tab===v?'#a78bfa':'transparent'}`,color:tab===v?'#a78bfa':'#8b949e',padding:'12px 14px',fontSize:13,cursor:'pointer',whiteSpace:'nowrap',fontFamily:'Georgia,serif',textShadow:tab===v?'0 0 8px #a78bfa':''}}>{labels[i]}</button>
        })}
      </div>

      <div style={{maxWidth:480,margin:'0 auto',padding:16}}>

        {tab==='home'&&<div>
          {priceAlert&&<div style={{background:'rgba(248,113,113,.1)',border:'1px solid rgba(248,113,113,.4)',borderRadius:8,padding:12,marginBottom:12,fontSize:13,color:'#f87171',textAlign:'center'}}>⚠ Ventas WLD pausadas — HACHI devaluado ({fmt(wldHachi)} &gt; {MAX_HACHI.toLocaleString()})</div>}
          <div style={card}><div style={cTitle}>Estado del sistema</div>
            {[['Oracle',oracleSt],['1 WLD =',fmt(wldHachi)+' HACHI'],['1 HACHI =',hachiSushi.toFixed(4)+' SUSHI'],['Pool WLD disponible',poolFree],['Licencias WLD disponibles',licsAvail],['Máximo HACHI/WLD',MAX_HACHI.toLocaleString()]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e'}}>{l}</span><span style={{fontFamily:'monospace',fontWeight:600}}>{v}</span></div>)}
          </div>
          <div style={card}><div style={cTitle}>HACHI</div>
            <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:12}}>
              <img src="/hachi-cat-savings.png" alt="Hachi el gato ahorrando monedas HACHI" width={88} height={88} style={{borderRadius:14,flexShrink:0,objectFit:'cover',boxShadow:'0 0 18px rgba(124,58,237,.35)'}} />
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:8}}>
                  <div style={{fontSize:26,fontWeight:700,fontFamily:'monospace',color:'#fbbf24'}}>{fmt(piggy.accrued)}</div>
                  <div style={{fontSize:13,color:'#8b949e'}}>HACHI ahorrados</div>
                </div>
                {(()=>{
                  const now = Math.floor(Date.now()/1000)
                  const cooldownEnds = lastSettle + 86400
                  const inCooldown = lastSettle > 0 && now < cooldownEnds
                  if (inCooldown) {
                    const s = cooldownEnds - now, h = Math.floor(s/3600), m = Math.floor((s%3600)/60)
                    return <div style={{fontSize:11,color:'#d29922',marginTop:4}}>{`Próximo retiro disponible en ${h}h ${m}m`}</div>
                  }
                  return <div style={{fontSize:11,color:piggy.canWithdraw?'#3fb950':'#8b949e',marginTop:4}}>{piggy.canWithdraw?'✓ Retirá cuando quieras':'Aún no hay HACHI acumulado'}</div>
                })()}
              </div>
            </div>
            <button onClick={withdrawDaily} disabled={!piggy.canWithdraw||!connected} style={{...btnG,width:'100%',padding:'10px 12px',opacity:(!piggy.canWithdraw||!connected)?0.4:1}}>Retirar al wallet</button>
            {!accrualStarted&&connected&&<button onClick={startAccrualFn} style={{...btnP,width:'100%',padding:'10px 12px',marginTop:8}}>Activar acumulador</button>}
            <div style={{fontSize:10,color:'#8b949e',marginTop:8,lineHeight:1.5}}>Hachi ahorra {piggy.accrual} HACHI por día de forma automática (sin gas) más lo que ganás en tareas. Retirá cuando quieras; pagás gas solo al retirar.</div>
          </div>
          <button onClick={()=>window.open(HACHI_BUY_URL,'_blank')} style={{...btnG,width:'100%',marginBottom:12}}>🪙 Comprar HACHI</button>
          {!connected&&<div style={{textAlign:'center',padding:'32px 16px',color:'#8b949e'}}>
            <div style={{fontSize:32,marginBottom:8}}>👋</div>
            <div style={{fontWeight:600,color:'#e6edf3',marginBottom:4}}>Bienvenido a HachiMiner</div>
            <div>{t('connect_prompt')}</div>
            <button onClick={connectWallet} style={{...btnP,marginTop:16,maxWidth:200}}>{t('connect')}</button>
          </div>}
        </div>}

        {tab==='lics'&&<div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:16}}>
            <button onClick={()=>setLicTab('wld')} style={licTab==='wld'?btnP:btnGh}>💠 WLD</button>
            <button onClick={()=>setLicTab('sushi')} style={{...(licTab==='sushi'?{...btnG,background:'transparent'}:btnGh),display:'flex',alignItems:'center',gap:6,justifyContent:'center'}}><img src="/hachi-cat-savings.png" width={20} height={20} style={{borderRadius:4,objectFit:'cover',flexShrink:0}} />Bocado</button>
          </div>
          {licTab==='wld'&&<div>
            <div style={sLabel}>Comprar licencia WLD</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              {wldNames.map((n,i)=><div key={i} onClick={()=>setSelWLD(i)} style={{...lCard,border:`1px solid ${selWLD===i?'#fbbf24':'#5b21b6'}`,background:selWLD===i?'rgba(251,191,36,.08)':'#1e0840',boxShadow:selWLD===i?'0 0 12px rgba(251,191,36,.3)':'none'}}>
                <div style={{fontSize:11,fontWeight:700}}>{n}{i===3&&<span style={{color:'#34d399'}}> +5%</span>}</div>
                <div style={{fontFamily:'monospace',fontSize:18,fontWeight:700,color:'#34d399'}}>{fmt(Math.round([1,3,5,10][i]*wldHachi*(i===3?1.35:1.3)))}</div>
                <div style={{fontSize:10,color:'#8b949e'}}>HACHI · 3 meses · {i===3?'35%':'30%'}</div>
                <div style={{fontSize:12,fontWeight:700,color:'#fbbf24',marginTop:6}}>{wldPrices[i]}</div>
              </div>)}
            </div>
            <div style={pBox}>{[['Tipo',wldNames[selWLD]],['Precio',wldPrices[selWLD]],['HACHI base',wldPrev.base],[selWLD===3?'Total ×1.35 (Elite +5%)':'Total ×1.3',wldPrev.total],['HACHI/día',wldPrev.daily],['Mensual',wldPrev.monthly]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace',fontSize:13}}>{v}</span></div>)}</div>
            <button onClick={buyWLD} disabled={!connected||wldHachi>MAX_HACHI} style={{...btnP,opacity:(!connected||wldHachi>MAX_HACHI)?0.4:1}}>{wldHachi>MAX_HACHI?'⚠ Ventas pausadas':`Comprar · ${wldPrices[selWLD]}`}</button>
            <div style={sLabel}>Licencias WLD activas</div>
            {wldLics.length===0?<div style={empty}><div style={{fontSize:28}}>💠</div><div>{t('no_lics')}</div></div>:wldLics.map(({id,l,pend})=><div key={id.toString()} style={card}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}><strong>{['Básica','Estándar','Premium','Elite'][l[1]]}</strong><div style={{color:l[10]?'#3fb950':'#8b949e'}}>●</div></div>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Pendiente</span><span style={{color:'#3fb950',fontFamily:'monospace'}}>{fmt(fe(pend))} HACHI</span></div>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Vence</span><span style={{fontFamily:'monospace'}}>{new Date(Number(l[7])*1000).toLocaleDateString()}</span></div>
              <button onClick={()=>claimWLD(id)} style={{...btnG,marginTop:8}}>Cobrar HACHI</button>
            </div>)}
          </div>}
          {licTab==='sushi'&&<div>
            {!sushiAccess&&<div style={{background:'rgba(248,113,113,.08)',border:'1px solid rgba(248,113,113,.35)',borderRadius:8,padding:20,textAlign:'center',marginBottom:12}}>
              <div style={{fontSize:28,marginBottom:8}}>🔒</div>
              <div style={{fontWeight:700,color:'#f87171',marginBottom:6}}>{t('access_title')}</div>
              <div style={{fontSize:13,color:'#8b949e'}}>{t('access_desc')}</div>
            </div>}
            {sushiAccess&&<>
              <div style={{...sLabel,display:'flex',alignItems:'center',gap:10}}><img src="/hachi-cat-savings.png" alt="" width={88} height={88} style={{borderRadius:14,flexShrink:0,objectFit:'cover',boxShadow:'0 0 18px rgba(124,58,237,.35)'}} />Convertí tus HACHI en Bocado</div>
              {(()=>{
                const specialIdx = wldTierActive===255?null:wldTierActive===0?0:wldTierActive
                const secsLeft = Math.max(0, lastSpecialTs + 5*86400 - Math.floor(Date.now()/1000))
                const sd=Math.floor(secsLeft/86400), sh=Math.floor((secsLeft%86400)/3600)
                const cards:{idx:number,special:boolean,label:string|null,disabled:boolean}[] = [
                  {idx:0, special:false, label:null, disabled:false},
                  ...(specialIdx!==null?[{idx:specialIdx, special:true, label:specialAvail?'✨ Especial disponible':`⏳ Disponible en ${sd}d ${sh}h`, disabled:!specialAvail}]:[])
                ]
                return(
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
                    {cards.map((c,ci)=><div key={ci} onClick={c.disabled?undefined:()=>setSelSUSHI(c.idx)} style={{...lCard,border:`1px solid ${selSUSHI===c.idx&&!c.disabled?'#fbbf24':'#5b21b6'}`,background:c.disabled?'rgba(30,8,64,.5)':selSUSHI===c.idx?'rgba(251,191,36,.08)':'#1e0840',opacity:c.disabled?.5:1,cursor:c.disabled?'default':'pointer'}}>
                      <div style={{fontSize:11,fontWeight:700}}>{sushiNames[c.idx]}</div>
                      {c.label&&<div style={{fontSize:10,fontWeight:600,color:specialAvail?'#34d399':'#d29922',marginBottom:2}}>{c.label}</div>}
                      <div style={{fontFamily:'monospace',fontSize:18,fontWeight:700,color:'#34d399'}}>{fmt(Math.round([500,2000,5000,10000][c.idx]*hachiSushi*1.25))}</div>
                      <div style={{fontSize:10,color:'#8b949e'}}>SUSHI inmediato ×1.25</div>
                      <div style={{fontSize:12,fontWeight:700,color:'#fbbf24',marginTop:6}}>{sushiPrices[c.idx]}</div>
                    </div>)}
                  </div>
                )
              })()}
              <div style={pBox}>{[['Tipo',sushiNames[selSUSHI]],['Precio',sushiPrices[selSUSHI]],['SUSHI base',sushiPrev.base],['Bonus inmediato','+25%'],['Recibís al instante (×1.25)',sushiPrev.total]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace',fontSize:13}}>{v}</span></div>)}</div>
              <button onClick={buySUSHI} style={btnG}>{`Comprar · ${sushiPrices[selSUSHI]}`}</button>
              {(()=>{
                const tierLabel = wldTierActive===255?'Sin licencia WLD':['Básica','Estándar','Premium','Elite'][wldTierActive]??'—'
                const maxBasic  = wldTierActive===255?1:wldTierActive===0?2:wldTierActive===1?3:wldTierActive===2?4:5
                const specialType = wldTierActive===0?'Básica adicional':wldTierActive===1?'Estándar':wldTierActive===2?'Premium':wldTierActive===3?'Elite':null
                return (
                  <div style={{background:'rgba(124,58,237,.08)',border:'1px solid #5b21b6',borderRadius:8,padding:12,marginTop:12,fontSize:12}}>
                    <div style={{...row,marginBottom:4}}><span style={{color:'#8b949e'}}>WLD activa</span><span style={{fontWeight:700,color:'#fbbf24'}}>{tierLabel}</span></div>
                    <div style={{...row,marginBottom:4}}><span style={{color:'#8b949e'}}>Básicas hoy</span><span style={{fontFamily:'monospace',fontWeight:600}}>{basicBoughtToday} / {maxBasic}</span></div>
                    {specialType&&(()=>{
                      if (specialAvail) return <div style={row}><span style={{color:'#8b949e'}}>Especial (c/5 días)</span><span style={{color:'#3fb950',fontWeight:600}}>{`✓ Disponible · ${specialType}`}</span></div>
                      const secsLeft = Math.max(0, lastSpecialTs + 5*86400 - Math.floor(Date.now()/1000))
                      const sd=Math.floor(secsLeft/86400), sh=Math.floor((secsLeft%86400)/3600)
                      return <div style={row}><span style={{color:'#8b949e'}}>Especial (c/5 días)</span><span style={{color:'#d29922',fontWeight:600}}>{`Disponible en ${sd}d ${sh}h`}</span></div>
                    })()}
                  </div>
                )
              })()}
              <div style={{background:'rgba(52,211,153,.08)',border:'1px solid rgba(52,211,153,.3)',borderRadius:8,padding:12,marginTop:12,fontSize:12,color:'#8b949e',lineHeight:1.5}}>
                <strong style={{color:'#34d399'}}>Intercambio inmediato:</strong> pagás en HACHI y recibís SUSHI (base + 25%) al instante en tu wallet. Sin esperas ni cobros pendientes.
              </div>
            </>}
          </div>}
        </div>}

        {tab==='lock'&&<div>
          <div style={card}><div style={cTitle}>Tu posición</div>
            <div style={{display:'flex',alignItems:'baseline',gap:8,margin:'8px 0 12px'}}>
              <div style={{fontSize:24,fontWeight:700,fontFamily:'monospace',color:'#34d399'}}>{lockData.pending}</div>
              <div style={{fontSize:12,color:'#8b949e'}}>HACHI APY pendiente</div>
            </div>
            {[['Total lockeado',lockData.total],['Tier',lockData.tier],['APY anual',lockData.apy],['Próximo cobro en',lockData.nextClaimIn]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e'}}>{l}</span><span style={{fontFamily:'monospace',fontWeight:600}}>{v}</span></div>)}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
            <button onClick={claimAPY} style={btnG}>Cobrar APY</button>
            <button onClick={doUnstake} style={btnGh}>Retirar HACHI</button>
          </div>
          <div style={sLabel}>Depositar HACHI</div>
          <input value={depositAmt} onChange={e=>setDepositAmt(e.target.value)} type="number" placeholder="Cantidad de HACHI" style={{background:'#12022a',border:'1px solid #5b21b6',borderRadius:8,padding:'10px 12px',fontSize:14,color:'#e6edf3',width:'100%',marginBottom:8,fontFamily:'monospace'}} />
          <div style={{fontSize:11,color:'#d29922',marginBottom:8,lineHeight:1.4}}>⚠ Depositar reinicia el cooldown de 24h para cobrar APY</div>
          <button onClick={doDeposit} style={btnP}>Depositar</button>
          <div style={card}><div style={cTitle}>🌍 Total de la comunidad</div>
            {[['HACHI bloqueado',platformStats.totalLocked],['Usuarios activos',platformStats.totalUsers]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e'}}>{l}</span><span style={{fontFamily:'monospace',fontWeight:600}}>{v}</span></div>)}
          </div>
          <div style={{...card,marginTop:12}}><div style={cTitle}>Niveles del Lock</div>
            <div style={{fontSize:11,color:'#8b949e',marginBottom:10,lineHeight:1.5}}>Con menos de 50,000 HACHI bloqueados (Sin tier) accedés a las licencias Bocado Básicas, pero no generás APY. Desde 50,000 HACHI (Tier 1 — Akira) empezás a ganar rendimiento.</div>
            {[{name:'Akira',min:'50,000',apy:'10%'},{name:'Zen',min:'200,000',apy:'20%'},{name:'Koban',min:'500,000',apy:'30%'},{name:'Tayko',min:'750,000',apy:'40%'},{name:'Hachi',min:'1,000,000',apy:'50%'}].map(({name,min,apy})=>{
              const isCurrent = lockData.tier === name
              return <div key={name} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'7px 6px',borderRadius:6,marginBottom:2,background:isCurrent?'rgba(52,211,153,.08)':'transparent',border:isCurrent?'1px solid rgba(52,211,153,.3)':'1px solid transparent'}}>
                <span style={{fontSize:13,fontWeight:isCurrent?700:400,color:isCurrent?'#34d399':'#8b949e'}}>{isCurrent?'→ ':''}{name}</span>
                <span style={{fontFamily:'monospace',fontSize:11,color:'#8b949e'}}>{min} HACHI</span>
                <span style={{fontFamily:'monospace',fontSize:12,fontWeight:600,color:isCurrent?'#fbbf24':'#6b7280'}}>{apy}</span>
              </div>
            })}
          </div>
          <div style={sLabel}>Mis depósitos</div>
          {lockBatches.length===0?<div style={empty}><div>Sin depósitos aún</div></div>:lockBatches.map((b,i)=><div key={i} style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:'1px solid #3b0764',fontSize:12}}><span style={{fontFamily:'monospace'}}>{fmt(b.amount)} HACHI</span><span style={{color:b.ready?'#3fb950':'#8b949e'}}>{b.ready?'✓ Disponible':'Hasta '+b.unlocks.toLocaleDateString()}</span></div>)}
        </div>}

        {tab==='ranking'&&<div>
          <div style={sLabel}>Ranking (cada 15 días)</div>
          {rankList.length===0?<div style={empty}><div style={{fontSize:28}}>🏆</div><div>Sin participantes aún</div></div>:rankList.map((e,i)=>{
            const isMe=e.a.toLowerCase()===addr.toLowerCase(),medal=i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`
            return <div key={e.a} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',borderRadius:8,marginBottom:4,background:'#1e0840',border:`1px solid ${isMe?'#34d399':'#5b21b6'}`}}>
              <div style={{fontFamily:'monospace',fontSize:13,fontWeight:700,width:28}}>{medal}</div>
              <div style={{fontFamily:'monospace',fontSize:12,flex:1}}>{fmtA(e.a)}{isMe&&<span style={{color:'#34d399'}}> (tú)</span>}</div>
              <div style={{fontFamily:'monospace',fontSize:12,fontWeight:700,color:'#fbbf24'}}>{fmt(e.pts)}</div>
            </div>
          })}
          <div style={card}><div style={cTitle}>Mis estadísticas</div>
            {[['Mis puntos',rankStats.points],['Mi posición',rankStats.pos],['Premio pendiente',rankStats.reward],['Total ganado',rankStats.earned]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e'}}>{l}</span><span style={{fontFamily:'monospace',fontWeight:600}}>{v}</span></div>)}
            <div style={{fontSize:11,color:'#8b949e',marginTop:8}}>Próximo reparto: <span style={{color:'#fbbf24',fontWeight:600}}>{rankStats.nextDist}</span></div>
          </div>
          <button onClick={claimPrize} style={btnGo}>Cobrar premio</button>
          {lastWinners.length>0&&<div style={card}>
            <div style={cTitle}>🏆 Último reparto</div>
            {lastWinners.map(({addr,amount,rank})=>(
              <div key={rank} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid #3b0764'}}>
                <span style={{fontFamily:'monospace',fontWeight:700,width:28,color:'#fbbf24'}}>{rank===1?'🥇':rank===2?'🥈':rank===3?'🥉':`#${rank}`}</span>
                <span style={{fontFamily:'monospace',fontSize:12,flex:1,color:'#c9d1d9'}}>{fmtA(addr)}</span>
                <span style={{fontFamily:'monospace',fontSize:12,fontWeight:600,color:'#34d399'}}>{fmt(amount)} HACHI</span>
              </div>
            ))}
          </div>}
          <div style={card}>
            <div style={cTitle}>¿Cómo se suman puntos?</div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:700,color:'#34d399',marginBottom:4,letterSpacing:.5}}>✓ SUMAN PUNTOS</div>
              {[['💰','Cobrar HACHI de licencia WLD'],['bocado','Comprar Bocado'],['🐱','Retirar de la alcancía'],['📢','Participar en anuncios'],['📈','Cobrar APY del Lock'],['👥','Registrar un referido (vos y tu referido)']].map(([icon,text])=><div key={text} style={{display:'flex',alignItems:'flex-start',gap:6,padding:'4px 0',borderBottom:'1px solid #3b0764'}}><span style={{flexShrink:0,fontSize:13,display:'flex',alignItems:'center'}}>{icon==='bocado'?<img src="/hachi-cat-savings.png" width={16} height={16} style={{borderRadius:3,objectFit:'cover'}} />:icon}</span><span style={{fontSize:12,color:'#c9d1d9',lineHeight:1.4}}>{text}</span></div>)}
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:700,color:'#f87171',marginBottom:4,letterSpacing:.5}}>✗ NO SUMAN PUNTOS</div>
              {['Comprar licencia WLD (los puntos llegan al cobrar el HACHI generado)','Depositar en el Lock (los puntos llegan al cobrar el APY)','Retirar del Lock (unstake)'].map(text=><div key={text} style={{display:'flex',alignItems:'flex-start',gap:6,padding:'4px 0',borderBottom:'1px solid #3b0764'}}><span style={{flexShrink:0,fontSize:12,color:'#8b949e'}}>—</span><span style={{fontSize:12,color:'#8b949e',lineHeight:1.4}}>{text}</span></div>)}
            </div>
            <div style={{fontSize:11,color:'#9b96c4',lineHeight:1.5,paddingTop:4}}>Tu multiplicador de tier actual aumenta todos los puntos que ganés. Mientras más HACHI tengas bloqueado en el Lock, más puntos sumás por cada acción.</div>
          </div>
        </div>}

        {tab==='pools'&&<div>
          <div style={sLabel}>Estado de pools</div>
          <div style={card}><div style={cTitle}>💠 Pool WLD</div>
            {[['Total',poolsData.wldTotal||'—'],['Reservado',poolsData.wldComm||'—'],['Libre',poolsData.wldFree||'—'],['Total pagado',poolsData.wldPaid||'—'],['Licencias disponibles',poolsData.licsAvail||'—']].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace'}}>{v}</span></div>)}
          </div>
          <div style={card}><div style={{...cTitle,display:'flex',alignItems:'center',gap:6}}><img src="/hachi-cat-savings.png" width={20} height={20} style={{borderRadius:4,objectFit:'cover',flexShrink:0}} />Pool A — Bocado</div>
            {[['Libre',poolsData.poolAF||'—'],['Licencias Bocado disponibles',poolsData.sushiAvail||'—']].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace'}}>{v}</span></div>)}
          </div>
          <div style={card}><div style={cTitle}>📊 Estadísticas</div>
            {[['Licencias WLD vendidas',poolsData.wldLics||'—'],['Licencias Bocado vendidas',poolsData.sushiLics||'—']].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace'}}>{v}</span></div>)}
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>🔥 HACHI quemados</span><span style={{fontFamily:'monospace',color:'#f87171',fontWeight:600}}>{poolsData.burned||'—'}</span></div>
          </div>
        </div>}

        {tab==='ads'&&<div>
          <div style={sLabel}>Campañas activas</div>
          {campaigns.length===0?<div style={empty}><div style={{fontSize:28}}>📺</div><div>Sin campañas activas</div></div>:campaigns.map((c:any)=><div key={c.id.toString()} style={{...card,marginBottom:8}}>
            <div style={{fontWeight:600,marginBottom:4}}>{c.title}</div>
            <div style={{display:'flex',gap:12,fontSize:12,color:'#8b949e',marginBottom:8}}><span>{['▶ YouTube','✈ Telegram','𝕏 Twitter'][c.platform]}</span><span>{c.views} vistas</span><span style={{color:'#34d399'}}>{fmt(fe(c.reward))} HACHI/vista</span></div>
            <button onClick={()=>participateAd(c.id)} disabled={!c.canPart||!connected} style={{...btnG,opacity:(!c.canPart||!connected)?0.4:1}}>{c.canPart?`Participar · +${fmt(fe(c.reward))} a la alcancía`:c.waitH>0?`En ${c.waitH}h`:'No disponible'}</button>
          </div>)}
          <div style={sLabel}>Publicar anuncio</div>
          <div style={card}><div style={cTitle}>Nueva campaña</div>
            <select value={campType} onChange={e=>setCampType(Number(e.target.value))} style={{background:'#12022a',border:'1px solid #5b21b6',borderRadius:8,padding:'10px 12px',fontSize:13,color:'#e6edf3',width:'100%',marginBottom:8}}><option value={0}>500 vistas — 5 WLD</option><option value={1}>1,000 vistas — 10 WLD</option><option value={2}>2,000 vistas — 20 WLD</option><option value={3}>5,000 vistas — 50 WLD</option></select>
            <input value={campTitle} onChange={e=>setCampTitle(e.target.value)} placeholder="Título del anuncio" style={{background:'#12022a',border:'1px solid #5b21b6',borderRadius:8,padding:'10px 12px',fontSize:13,color:'#e6edf3',width:'100%',marginBottom:8,fontFamily:'monospace'}} />
            <input value={campUrl} onChange={e=>setCampUrl(e.target.value)} placeholder="URL del contenido" style={{background:'#12022a',border:'1px solid #5b21b6',borderRadius:8,padding:'10px 12px',fontSize:13,color:'#e6edf3',width:'100%',marginBottom:8,fontFamily:'monospace'}} />
            <select value={campPlatform} onChange={e=>setCampPlatform(Number(e.target.value))} style={{background:'#12022a',border:'1px solid #5b21b6',borderRadius:8,padding:'10px 12px',fontSize:13,color:'#e6edf3',width:'100%',marginBottom:8}}><option value={0}>▶ YouTube</option><option value={1}>✈ Telegram</option><option value={2}>𝕏 Twitter/X</option></select>
            <div style={{...pBox,marginBottom:12}}><div style={row}><span style={{color:'#8b949e',fontSize:12}}>Costo</span><span style={{fontFamily:'monospace'}}>{[5,10,20,50][campType]} WLD</span></div><div style={row}><span style={{color:'#8b949e',fontSize:12}}>HACHI por vista</span><span style={{fontFamily:'monospace',color:'#34d399'}}>{campHPV}</span></div></div>
            <button onClick={createCampaign} disabled={!connected||!campTitle||!campUrl} style={{...btnP,opacity:(!connected||!campTitle||!campUrl)?0.4:1}}>Publicar campaña · {[5,10,20,50][campType]} WLD</button>
          </div>
        </div>}

        {tab==='refs'&&<div>
          <div style={card}><div style={cTitle}>Mi código de referido</div>
            <div style={{color:'#8b949e',fontSize:12,marginBottom:8}}>{addr?'✓ Tu código está listo para compartir':'Conecta tu wallet para ver tu código'}</div>
            {(()=>{const link=`https://world.org/mini-app?app_id=app_faaadf7d4dc1285275a436a8cac18e69&path=${encodeURIComponent('/?ref='+addr)}`;return(<button onClick={async()=>{if(navigator.share){try{await navigator.share({title:'HachiMiner',url:link})}catch{await navigator.clipboard.writeText(link);toast_('Link copiado','#3fb950')}}else{await navigator.clipboard.writeText(link);toast_('Link copiado','#3fb950')}}} style={{...btnGh,marginTop:8}}>Compartir mi link de invitación</button>)})()}
            <div style={pBox}>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Mis referidos</span><span style={{fontFamily:'monospace',fontWeight:600}}>{refInfo.totalRefs}</span></div>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>HACHI ganado</span><span style={{color:'#3fb950',fontFamily:'monospace'}}>{refInfo.earned}</span></div>
              <div style={{fontSize:11,color:'#8b949e',marginTop:8,lineHeight:1.5}}>✓ Ya está en tu wallet — se paga automáticamente cuando alguien se registra con tu link, sin necesidad de cobrar.</div>
            </div>
          </div>
          {refInfo.referrer?
            <div style={card}><div style={cTitle}>Ya tenés referidor</div>
              <div style={{fontFamily:'monospace',fontSize:12,wordBreak:'break-all',color:'#a78bfa'}}>{refInfo.referrer}</div>
            </div>
          : refFromLink ?
            <>
              <div style={sLabel}>Registrar referido</div>
              <div style={card}>
                <div style={{fontSize:12,color:'#8b949e',marginBottom:8}}>Te invitó: <span style={{fontFamily:'monospace',color:'#a78bfa',fontWeight:600}}>{fmtA(refFromLink)}</span></div>
                <div style={pBox}><div style={row}><span style={{color:'#8b949e',fontSize:12}}>Recibís</span><span style={{color:'#3fb950',fontFamily:'monospace'}}>{refInfo.newBonus} HACHI</span></div><div style={row}><span style={{color:'#8b949e',fontSize:12}}>Tu referidor recibe</span><span style={{color:'#a78bfa',fontFamily:'monospace'}}>{refInfo.refBonus} HACHI</span></div></div>
                <button onClick={registerReferral} disabled={!connected} style={{...btnP,opacity:connected?1:0.4}}>Registrarme con este referido</button>
              </div>
            </>
          :
            <div style={card}>
              <div style={{fontSize:12,color:'#8b949e',lineHeight:1.6}}>Para registrarte con un referido, necesitás abrir la app a través del link de invitación de alguien.</div>
            </div>
          }
        </div>}

      {debugMode&&logs.length>0&&<div style={{background:'#0f0224',border:'1px solid #f87171',borderRadius:8,padding:10,margin:'8px 0'}}>
        <div style={{fontSize:10,color:'#f87171',marginBottom:4,fontWeight:700}}>DEBUG</div>
        {logs.map((l,i)=><div key={i} style={{fontFamily:'monospace',fontSize:10,color:'#e6edf3',marginBottom:2}}>{l}</div>)}
        <button onClick={()=>setLogs([])} style={{fontSize:10,color:'#8b949e',background:'none',border:'none',cursor:'pointer',marginTop:4}}>Limpiar</button>
      </div>}
      </div>
    </div>
  )
}

const card: React.CSSProperties = {background:'#240a45',border:'1px solid #5b21b6',borderRadius:12,padding:16,marginBottom:12,boxShadow:'0 0 16px rgba(124,58,237,.25)'}
const cTitle: React.CSSProperties = {fontSize:13,color:'#c4b5fd',fontFamily:'Georgia,serif',fontStyle:'italic',marginBottom:12}
const row: React.CSSProperties = {display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:'1px solid #3b0764'}
const sLabel: React.CSSProperties = {fontSize:13,fontWeight:700,fontFamily:'Georgia,serif',color:'#e6edf3',margin:'16px 0 8px',borderBottom:'1px solid #3b0764',paddingBottom:4}
const pBox: React.CSSProperties = {background:'#1e0840',border:'1px solid #5b21b6',borderRadius:8,padding:12,marginBottom:12}
const lCard: React.CSSProperties = {borderRadius:8,padding:12,cursor:'pointer',transition:'border-color .15s'}
const empty: React.CSSProperties = {textAlign:'center',padding:'32px 16px',color:'#8b949e'}
const btnP: React.CSSProperties = {background:'#7c3aed',color:'#fff',border:'1px solid #7c3aed',borderRadius:8,padding:'10px 16px',fontSize:13,fontWeight:600,cursor:'pointer',width:'100%',fontFamily:'Georgia,serif',boxShadow:'0 0 14px rgba(124,58,237,.5)'}
const btnG: React.CSSProperties = {background:'transparent',color:'#34d399',border:'1px solid #34d399',borderRadius:8,padding:'10px 16px',fontSize:13,fontWeight:600,cursor:'pointer',width:'100%',fontFamily:'Georgia,serif'}
const btnGo: React.CSSProperties = {background:'transparent',color:'#fbbf24',border:'1px solid #fbbf24',borderRadius:8,padding:'10px 16px',fontSize:13,fontWeight:600,cursor:'pointer',width:'100%',fontFamily:'Georgia,serif',marginBottom:12}
const btnGh: React.CSSProperties = {background:'transparent',color:'#8b949e',border:'1px solid #30363d',borderRadius:8,padding:'10px 16px',fontSize:13,fontWeight:600,cursor:'pointer',width:'100%',fontFamily:'Georgia,serif'}
