// trigger redeploy: recuperado saldo de Netlify
// trigger redeploy: HACHI_RANKING_ADDRESS agregada en Netlify
// trigger redeploy: env vars actualizadas en Netlify
'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { IDKitRequestWidget, orbLegacy, type RpContext } from '@worldcoin/idkit'
import { MiniKit } from '@worldcoin/minikit-js'
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
  ranking:  '0x763e6885efCE911488f497b2a0513e3DB727C141',
  dailyRewards: '0x93D8E4b2F6c4728F5D2B875b76469974c3152999',
  core:     '0xE1892183A27389c6a4CACc091F62F9412B7EA6b9',
  referral: '0x854e2bE2bBD0b9B1761ac5cAcc5c08D9069A5982',
  hachi:    '0xbE0313f279580FDD1aA1b1b6888407E6504fF19E',
  wld:      '0x2cfc85d8e48f8eab294be644d9e25c3030863003',
  sushi:    '0xab09a728e53d3d6bc438be95eed46da0bbe7fb38',
  drachma:  '0xEdE54d9c024ee80C85ec0a75eD2d8774c7Fbac9B',
  // Permit2 canónico de Uniswap (misma dirección en todas las redes EVM, incl. World Chain)
  permit2:  '0x000000000022D473030F116dDEE9F6B43aC78BA3',
}

function isVotingOpen(): boolean {
  const now = new Date()
  const gmt4 = new Date(now.getTime() - 4 * 3600 * 1000)
  const day = gmt4.getUTCDay() // 0=Dom,1=Lun,...,4=Jue,5=Vie,6=Sab
  const hour = gmt4.getUTCHours()
  if (day === 4 && hour >= 20) return true // jueves desde las 20:00
  if (day === 5 || day === 6) return true // viernes y sábado, todo el día
  if (day === 0 && hour < 20) return true // domingo hasta las 19:59
  return false
}

function secondsUntilNextVoting(): number {
  const now = new Date()
  const gmt4Now = new Date(now.getTime() - 4 * 3600 * 1000)
  const day = gmt4Now.getUTCDay()
  let daysUntilThursday = (4 - day + 7) % 7
  const target = new Date(Date.UTC(
    gmt4Now.getUTCFullYear(), gmt4Now.getUTCMonth(), gmt4Now.getUTCDate() + daysUntilThursday,
    20, 0, 0
  ))
  let diff = (target.getTime() - gmt4Now.getTime()) / 1000
  if (diff <= 0) diff += 7 * 86400
  return Math.floor(diff)
}

const RPC = 'https://worldchain-mainnet.g.alchemy.com/public'
const HACHI_BUY_URL = 'https://world.org/mini-app?app_id=app_e5ba7c3061400e361f98ce44d8b1b9c4&path=/token/0xbe0313f279580fdd1aa1b1b6888407e6504ff19e'
const WORLDCHAIN_ID = 480
const MAX_HACHI = 20000
const APP_ID = 'app_ba8d66235ecf4bc9e341fff3768d9058'
// Incognito Action de World ID configurada en el Developer Portal.
// DEBE coincidir con el externalNullifierHash con el que se desplegó el contrato.
const ACTION = 'verify-human'

const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)']
const HACHI_WLD_PAIR = '0xfB461C1EcE675568a1561df75a18d65DDBdc5481'
const SWAP_MAINTENANCE_MODE = false // poner en false cuando esté listo para todos
const SHOW_TOP_NAV = false // poner en true para volver a mostrar la barra de pestañas de arriba
const SHOW_LANG_BUTTONS = false // poner en true cuando estén traducidas todas las pantallas
const HACHI_SWAP_ADDR = '0x1EfCb70A4AE0dfa7D2242a43573A6B103776DC73'
const DRACHMA_MINER_ADDR_OLD = '0x19d23871C64F29e22F31AcC094A255e5B1aAD577'
const DRACHMA_MINER_ADDR_NEW = '0xF34a0C6F3C55Bb3b8E489E0c66779331FFc72eA4'
const WLD_MINER_ADDR_OLD = '0x35C82EC1C5414b228eF39b65fAC545409fc92d75'
const WLD_MINER_ADDR_NEW = '0x2C191913eBdA9b2bb61E3d00Ca5d35b6991F4B9A'
const VIP_HOLDERS_ADDR = '0x75eD38D459c30656128dF6c9825edfB1A50623af'
const VIP_HOLDERS_ABI = [
  'function getVipLevel(address) view returns (uint8)',
  'function pendingHachi(address) view returns (uint256)',
  'function previewExchange(address) view returns (uint256,uint256,uint256)',
  'function exchange(uint8,uint256) returns (uint8,uint256)',
  'function tierMinAmount(uint256) view returns (uint256)',
  'function tierBonusBps(uint256) view returns (uint256)',
  'function drachmaPool() view returns (uint256)',
  'function sushiPool() view returns (uint256)',
]
const WLD_MINER_ABI = [
  'function getUserTier(address) view returns (uint8)',
  'function maxInvestableWld(address) view returns (uint256)',
  'function previewMine(uint256,uint8) view returns (uint256,uint256)',
  'function mineWld(uint256,uint8,uint256,uint256) returns (uint256)',
  'function claimRewards(uint256)',
  'function activeMineId(address) view returns (uint256)',
  'function mines(uint256) view returns (address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)',
  'function pendingRewards(uint256) view returns (uint256,uint256)',
  'function hachiPool() view returns (uint256)',
  'function drachmaPool() view returns (uint256)',
  'function hachiCommitted() view returns (uint256)',
  'function drachmaCommitted() view returns (uint256)',
  'function variants(uint256) view returns (uint256 duration, uint256 returnBps)',
  'function mineId() view returns (uint256)',
]
const DRACHMA_MINER_ABI = [
  'function getUserTier(address) view returns (uint8)',
  'function costInHachi(uint8) view returns (uint256)',
  'function discountBps() view returns (uint256)',
  'function tierDrachmaAmounts(uint256) view returns (uint256)',
  'function mineDrachma(uint8,uint256) returns (uint256)',
  'function claimDrachma(uint256)',
  'function activeMineId(address) view returns (uint256)',
  'function mines(uint256) view returns (address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)',
  'function pendingDrachma(uint256) view returns (uint256)',
  'function drachmaPool() view returns (uint256)',
  'function drachmaCommitted() view returns (uint256)',
  'function mineDuration() view returns (uint256)',
  'function mineId() view returns (uint256)',
]
const WEEKLY_BONUS_ADDR = '0x67ECFC02B852FDd9D55D0cBF8866cE6ff74126dF'
const WEEKLY_BONUS_ABI = [
  'function getDailyRate(address) view returns (uint256)',
  'function previewClaim(address) view returns (uint256)',
  'function claimBonus()',
  'function lastActionTime(address) view returns (uint256)',
  'function sushiPool() view returns (uint256)',
  'function cycleDuration() view returns (uint256)',
]
const STREAK_ADDR = '0x92c6E4fF2A3D667e3dAf311af594c6246Ce6E807'
const STREAK_ABI = ['function getTodayProgress(address) view returns (uint256,uint256,bool,uint8,uint256,bool)', 'function claimStreakBonus()', 'function getRanking() view returns (address[],uint256[])', 'function timeUntilNextRanking() view returns (uint256)', 'function lastCreditedAt(address) view returns (uint256)', 'function streakSushiPool() view returns (uint256)', 'function lastRankingExecutedAt() view returns (uint256)', 'event DayCredited(address indexed user, uint8 day, uint256 amount)', 'event CycleCompleted(address indexed user)', 'event SwapRankingPrizePaid(address indexed user, uint256 amount, uint256 rank)']
const PAIR_ABI = ['function getReserves() view returns (uint112,uint112,uint32)']
const HACHISWAP_ABI = ['function swap(address,address,uint256,uint256,uint256) returns (uint256)', 'event Swapped(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount)']
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
  'function wldLicId() view returns (uint256)',
  'function sushiLics(uint256) view returns (address,uint8,uint256,uint256,uint256,uint256,bool)',
  'function specialSushiAvailable(address) view returns (bool)',
  'function lastSpecialSushi(address) view returns (uint256)',
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
const DAILY_REWARDS = [
  'function claim()',
  'function previewClaim(address) view returns (uint256,uint256,bool,uint256)',
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
const REFERRAL = [
  'function registerWithReferral(address)',
  'function getReferralInfo(address) view returns (address,uint256,uint256,address[])',
  'function canRegister(address,address) view returns (bool,string)',
  'function currentRefBonus() view returns (uint256)',
  'function currentNewBonus() view returns (uint256)',
]

type Tab = 'home'|'lics'|'lock'|'ranking'|'pools'|'swap'|'refs'|'estado'|'drachmaminer'|'weeklybonus'|'voting'|'wldminer'|'mineria'|'centrohachi'
type Lang = 'es'|'en'|'pt'
const detectLang = (): Lang => {
  if (typeof navigator === 'undefined') return 'es'
  const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]
  for (const l of langs) {
    const code = (l || '').toLowerCase().slice(0, 2)
    if (code === 'en') return 'en'
    if (code === 'pt') return 'pt'
    if (code === 'es') return 'es'
  }
  return 'es'
}

const TR = {
  es: { connect:'Conectar', verified:'World ID ✓', not_verified:'Sin verificar', daily_claim:'Cobrar 10 HACHI', nav_home:'🏠 Inicio', nav_lics:'📜 Licencias', nav_lock:'🔒 Lock', nav_rank:'🏆 Ranking', nav_pools:'🌊 Pools', nav_swap:'🔄 Swap', nav_refs:'👥 Referidos', nav_estado:'📊 Mi Estado', err_connect:'Conecta tu wallet', err_verify:'Verifica tu World ID', err_price:'Ventas pausadas', approving:'Aprobando...', no_lics:'Sin licencias activas', connect_prompt:'Conecta tu wallet para comenzar', access_title:'Acceso restringido', access_desc:'Para licencias SUSHI necesitas 5,000 HACHI lockeados o una licencia WLD activa', day1:'Día 1 — recibís de vuelta', day2:'Día 2 — tu ganancia (24h)' },
  en: { connect:'Connect', verified:'World ID ✓', not_verified:'Not verified', daily_claim:'Claim 10 HACHI', nav_home:'🏠 Home', nav_lics:'📜 Licenses', nav_lock:'🔒 Lock', nav_rank:'🏆 Ranking', nav_pools:'🌊 Pools', nav_swap:'🔄 Swap', nav_refs:'👥 Referrals', nav_estado:'📊 My Status', err_connect:'Connect your wallet', err_verify:'Verify your World ID', err_price:'Sales paused', approving:'Approving...', no_lics:'No active licenses', connect_prompt:'Connect your wallet to start', access_title:'Restricted access', access_desc:'For SUSHI licenses you need 5,000 HACHI locked or an active WLD license', day1:'Day 1 — get back investment', day2:'Day 2 — your profit (24h)' },
  pt: { connect:'Conectar', verified:'World ID ✓', not_verified:'Não verificado', daily_claim:'Cobrar 10 HACHI', nav_home:'🏠 Início', nav_lics:'📜 Licenças', nav_lock:'🔒 Lock', nav_rank:'🏆 Ranking', nav_pools:'🌊 Pools', nav_swap:'🔄 Swap', nav_refs:'👥 Indicações', nav_estado:'📊 Meu Status', err_connect:'Conecte sua carteira', err_verify:'Verifique seu World ID', err_price:'Vendas pausadas', approving:'Aprovando...', no_lics:'Sem licenças ativas', connect_prompt:'Conecte sua carteira para começar', access_title:'Acesso restrito', access_desc:'Para licenças SUSHI você precisa de 5.000 HACHI bloqueados ou uma licença WLD ativa', day1:'Dia 1 — recupere investimento', day2:'Dia 2 — seu lucro (24h)' },
}

const LOGIN = {
  es: {
    tagline: 'Minería de HACHI verificada con World ID en World Chain',
    whatTitle: '¿Qué es HachiMiner?',
    whatDesc: 'HachiMiner es una mini app de World que te permite minar tokens HACHI y operar con licencias WLD y Bocado directamente en World Chain. Compra licencias, bloquea tokens para ganar APY, intercambiá HACHI y WLD con el Swap, sumá puntos en el ranking, y reclamá tu HACHI y Drachma acumulados cada 24hs.',
    features: [
      { icon:'📜', title:'Licencias', desc:'Compra tu licencia WLD y obtén beneficios adicionales en Bocados según tu nivel — a mayor nivel, mayor acceso.' },
      { icon:'🔒', title:'Lock & APY', desc:'Bloquea HACHI y gana rendimiento sobre tu posición.' },
      { icon:'🏆', title:'Ranking', desc:'Compite por premios según tu actividad.' },
      { icon:'🐱', title:'Reúne y cobra tus HACHI', desc:'Hachi te prepara una recompensa lista para reclamar cada 24hs, según tu actividad (lock y licencias). Un solo toque, sin esperas largas.' },
      { icon:'🔄', title:'Swap HACHI ↔ WLD', desc:'Intercambiá HACHI y WLD directo en la app, con la liquidez real de Uniswap.' },
      { icon:'🪙', iconImg:'https://assets.geckoterminal.com/0gp3m01cu8d61jd4n9nmhkvn5auh', title:'Drachma Miner', desc:'Minerá Drachma pagando HACHI, según tu nivel de licencia o Lock.' },
      { icon:'🎁', title:'Reward', desc:'Un regalo sorpresa cada semana según tus licencias WLD activas.' },
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
    whatDesc: 'HachiMiner is a World mini app that lets you mine HACHI tokens and trade WLD and Bocado licenses directly on World Chain. Buy licenses, lock tokens to earn APY, swap HACHI and WLD, climb the ranking, and claim your accumulated HACHI and Drachma every 24 hours.',
    features: [
      { icon:'📜', title:'Licenses', desc:'Buy your WLD license and get extra Bocado benefits based on your tier — higher tier, greater access.' },
      { icon:'🔒', title:'Lock & APY', desc:'Lock HACHI and earn yield on your position.' },
      { icon:'🏆', title:'Ranking', desc:'Compete for prizes based on your activity.' },
      { icon:'🐱', title:'Collect your HACHI', desc:'Hachi gets a reward ready for you to claim every 24h, based on your activity (lock and licenses). One tap, no long waits.' },
      { icon:'🔄', title:'Swap HACHI ↔ WLD', desc:'Exchange HACHI and WLD directly in the app, using real Uniswap liquidity.' },
      { icon:'🪙', iconImg:'https://assets.geckoterminal.com/0gp3m01cu8d61jd4n9nmhkvn5auh', title:'Drachma Miner', desc:'Mine Drachma by paying HACHI, based on your license or Lock tier.' },
      { icon:'📅', title:'Weekly Bonus', desc:'Earn SUSHI every week based on your active WLD licenses.' },
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
    whatDesc: 'O HachiMiner é um mini app da World que permite minerar tokens HACHI e operar com licenças WLD e Bocado diretamente na World Chain. Compre licenças, bloqueie tokens para ganhar APY, troque HACHI e WLD com o Swap, suba no ranking, e resgate seu HACHI e Drachma acumulados a cada 24 horas.',
    features: [
      { icon:'📜', title:'Licenças', desc:'Compre sua licença WLD e obtenha benefícios extras em Bocados conforme seu nível — quanto maior o nível, maior o acesso.' },
      { icon:'🔒', title:'Lock & APY', desc:'Bloqueie HACHI e ganhe rendimento na sua posição.' },
      { icon:'🏆', title:'Ranking', desc:'Concorra a prêmios conforme sua atividade.' },
      { icon:'🐱', title:'Reúna e resgate seus HACHI', desc:'Hachi prepara uma recompensa pronta para você resgatar a cada 24h, de acordo com sua atividade (lock e licenças). Um toque só, sem esperas longas.' },
      { icon:'🔄', title:'Swap HACHI ↔ WLD', desc:'Troque HACHI e WLD direto no app, com a liquidez real da Uniswap.' },
      { icon:'🪙', iconImg:'https://assets.geckoterminal.com/0gp3m01cu8d61jd4n9nmhkvn5auh', title:'Drachma Miner', desc:'Minere Drachma pagando HACHI, conforme seu nível de licença ou Lock.' },
      { icon:'📅', title:'Bônus Semanal', desc:'Ganhe SUSHI toda semana conforme suas licenças WLD ativas.' },
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
const fmtPrecise = (n: number): string => {
  if (!n && n !== 0) return '—'
  if (n === 0) return '0.00'
  const decimals = n >= 1 ? 4 : n >= 0.01 ? 6 : 8
  const s = n.toFixed(decimals)
  return s.includes('.') ? s.replace(/0+$/,'').replace(/\.$/,'') : s
}
const fmtA = (a: string) => a ? a.slice(0,6)+'...'+a.slice(-4) : '—'
const fe = (v: bigint) => Number(ethers.formatEther(v))
const pe = (v: string|number) => ethers.parseEther(String(v))
const fmtSecs = (s: number) => { if (!s || s <= 0) return '—'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m` }
// nonce alfanumérico de al menos 8 caracteres (requisito de MiniKit v2)
const genNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('')

export default function HachiMiner() {
  const [tab, setTab] = useState<Tab>('home')
  const [licTab, setLicTab] = useState<'wld'|'sushi'>('wld')
  const [lang, setLang] = useState<Lang>(() => detectLang())
  const [toast, setToast] = useState<{msg:string;color:string}|null>(null)
  const [addr, setAddr] = useState('')
  const [username, setUsername] = useState('')
  const [usernameCache, setUsernameCache] = useState<Record<string,string>>({})
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
  const [licsAvailNum, setLicsAvailNum] = useState(0)
  const [priceAlert, setPriceAlert] = useState(false)
  const [piggy, setPiggy] = useState({accrued:0,bonus:0,canWithdraw:false,secondsUntilNext:0})
  const [activeLicCount, setActiveLicCount] = useState(0)
  const [swapDir, setSwapDir] = useState<'h2w'|'w2h'>('w2h')
  const [swapIn, setSwapIn] = useState('')
  const [swapQuote, setSwapQuote] = useState('0')
  const [swapLoading, setSwapLoading] = useState(false)
  const [swapHistory, setSwapHistory] = useState<any[]>([])
  const [streakStatus, setStreakStatus] = useState({swaps:0, volume:0, missionDone:false, day:1, nextAmount:0, canClaimNow:false, lastCreditedAt:0, poolFree:0})
  const [streakHistory, setStreakHistory] = useState<any[]>([])
  const [claimingStreak, setClaimingStreak] = useState(false)
  const [swapRanking, setSwapRanking] = useState<{addr:string, amount:number}[]>([])
  const [swapRankingNextIn, setSwapRankingNextIn] = useState(0)
  const [swapLastWinners, setSwapLastWinners] = useState<{addr:string,amount:number,rank:number}[]>([])
  const [swapLastExecDate, setSwapLastExecDate] = useState('')
  const [swapHistoryExpanded, setSwapHistoryExpanded] = useState(false)
  const [selWLD, setSelWLD] = useState(0)
  const [showBuyWLD, setShowBuyWLD] = useState(false)
  const [drachmaMiner, setDrachmaMiner] = useState({tier:255, amounts:[0,0,0,0], costs:[0,0,0,0], activeMineId:0, active:false, drachmaTotal:0, drachmaClaimed:0, pending:0, endTime:0, poolFree:0, durationDays:15, loaded:false, contractAddr:'0xF34a0C6F3C55Bb3b8E489E0c66779331FFc72eA4', isNewContract:true, discountBps:1500})
  const [drachmaActiveCount, setDrachmaActiveCount] = useState({real:0, total:0})
  const [selDrachmaTier, setSelDrachmaTier] = useState(0)
  const [poolsExtra, setPoolsExtra] = useState({apyPool:0, totalLocked:0, lockUsers:0, dailyHachiPool:0, dailyBonusPool:0, streakPool:0, rankingPeriodPool:0, drachmaMinerFree:0, weeklyBonusPool:0, wldMinerHachiFree:0, wldMinerDrachmaFree:0, drachmaMinerFreeNew:0, wldMinerHachiFreeNew:0, wldMinerDrachmaFreeNew:0})
  const [wldMiner, setWldMiner] = useState({tier:255, cap:0, activeMineId:0, active:false, variant:0, hachiTotal:0, hachiClaimed:0, drachmaTotal:0, drachmaClaimed:0, pendingHachi:0, pendingDrachma:0, endTime:0, poolFreeHachi:0, poolFreeDrachma:0, loaded:false, contractAddr:'0x2C191913eBdA9b2bb61E3d00Ca5d35b6991F4B9A', isNewContract:true})
  const [wldActiveCount, setWldActiveCount] = useState({real:0, total:0})
  const [wldLicActiveCount, setWldLicActiveCount] = useState({real:0, total:0})
  const [wldMinerVariants, setWldMinerVariants] = useState([{days:30,pct:30},{days:15,pct:12},{days:7,pct:5}])
  const [wldMinerHistory, setWldMinerHistory] = useState<{contrato:string, id:number, wldPaid:number, hachiTotal:number, drachmaTotal:number, done:boolean}[]>([])
  const [showWldHistory, setShowWldHistory] = useState(false)
  const [selWldAmount, setSelWldAmount] = useState('')
  const [selWldVariant, setSelWldVariant] = useState(0)
  const [wldMinerPreview, setWldMinerPreview] = useState({hachi:0, drachma:0})
  const [showInfoWldMiner, setShowInfoWldMiner] = useState(false)
  const [miningWld, setMiningWld] = useState(false)
  const [claimingWldMiner, setClaimingWldMiner] = useState(false)
  const [weeklyBonus, setWeeklyBonus] = useState({dailyRate:0, pending:0, everClaimed:false, poolFree:0, secondsUntilNext:0})
  const [claimingWeekly, setClaimingWeekly] = useState(false)
  const [showInfoDrachma, setShowInfoDrachma] = useState(false)
  const [showInfoWeekly, setShowInfoWeekly] = useState(false)
  const [giftOpened, setGiftOpened] = useState(false)
  const [showInfoSwap, setShowInfoSwap] = useState(false)
  const [showInfoLics, setShowInfoLics] = useState(false)
  const [wldPrev, setWldPrev] = useState({base:'—',total:'—',daily:'—',monthly:'—'})
  const [wldLics, setWldLics] = useState<any[]>([])
  const [wldLicsLoadedAt, setWldLicsLoadedAt] = useState(Date.now())
  const [wldLicsLoaded, setWldLicsLoaded] = useState(false)
  const [liveTick, setLiveTick] = useState(Date.now())
  const [selSUSHI, setSelSUSHI] = useState(0)
  const [sushiQty, setSushiQty] = useState(1)
  const [sushiPrev, setSushiPrev] = useState({base:'—',d1:'—',d2:'—',total:'—',dailyLeft:'—'})
  const [sushiAccess, setSushiAccess] = useState(false)
  const [accrualStarted, setAccrualStarted] = useState(true)
  const [lastSettle, setLastSettle] = useState(0)
  const [debugMode] = useState(() => typeof window !== 'undefined' && window.location.search.includes('debug=1'))
  const [wldTierActive, setWldTierActive] = useState<number>(255)
  const [wldTierLoaded, setWldTierLoaded] = useState(false)
  const [specialAvail, setSpecialAvail] = useState(false)
  const [lastSpecialTs, setLastSpecialTs] = useState(0)
  const [basicBoughtToday, setBasicBoughtToday] = useState(0)
  const [hachiRaw, setHachiRaw] = useState(0)
  const [wldRaw, setWldRaw]     = useState(0)
  const [sushiLics] = useState<any[]>([])
  const [myStatus, setMyStatus] = useState({bocadoCount:0, specialAvail:true, lastSpecial:0, loading:false})
  const [lockData, setLockData] = useState({total:'0',tier:'Sin tier',apy:'0%',pending:'0',unstake:'0',unstakeRaw:BigInt(0),nextClaimIn:'—',nextDepositIn:'—',nextDepositSecs:0})
  const [vipData, setVipData] = useState({level:255, pendingHachi:0, drachmaOut:0, sushiOut:0, drachmaPoolFree:0, sushiPoolFree:0, loaded:false})
  const [vipPreferredToken, setVipPreferredToken] = useState(0)
  const [showInfoVip, setShowInfoVip] = useState(false)
  const [drachmaMinerHistory, setDrachmaMinerHistory] = useState<{contrato:string, id:number, hachiPaid:number, drachmaTotal:number, done:boolean}[]>([])
  const [showDrachmaHistory, setShowDrachmaHistory] = useState(false)
  const [showDeposits, setShowDeposits] = useState(false)
  const [showInfoTiers, setShowInfoTiers] = useState(false)
  const [exchangingVip, setExchangingVip] = useState(false)
  const [lockBatches, setLockBatches] = useState<any[]>([])
  const [platformStats, setPlatformStats] = useState({totalLocked:'—',totalUsers:'—'})
  const [depositAmt, setDepositAmt] = useState('')
  const [rankStats, setRankStats] = useState({points:'0',totalHist:'0',pos:'—',reward:'0',earned:'0',nextDist:'—',rewardRaw:0})
  const [rankList, setRankList] = useState<any[]>([])
  const [lastWinners, setLastWinners] = useState<{addr:string,amount:number,rank:number}[]>([])
  const [lastExecDate, setLastExecDate] = useState('')
  const [refInfo, setRefInfo] = useState({referrer:'',totalRefs:0,earned:'0 HACHI',refBonus:'500',newBonus:'500'})
  const [refFromLink, setRefFromLink] = useState('')
  const [poolsData, setPoolsData] = useState<any>({})
  const [logs, setLogs] = useState<string[]>([])
  const [showVerify, setShowVerify] = useState(false)
  const [verifyingBackend, setVerifyingBackend] = useState(false)
  const [rpContext, setRpContext] = useState<RpContext | null>(null)
  const [rpLoading, setRpLoading] = useState(false)
  const justVerifiedRef = useRef(false)
  const userVerifCounter = useRef(1)

  const viemClient = useMemo(() => createPublicClient({
    chain: worldChain as any,
    transport: http(RPC),
  }), [])

  const { poll: pollUserOp } = useUserOperationReceipt({ client: viemClient })

  const log = (m: string) => setLogs(p => [...p.slice(-6), m])
  const t = (k: keyof typeof TR.es) => TR[lang][k] || TR.es[k]
  const loginCopy = LOGIN[lang] || LOGIN.es
  const rpc = () => new ethers.JsonRpcProvider(RPC)
  const toast_ = (msg: string, color='#a78bfa') => { if (msg.includes('__VERIFY_OPENED__')) return; setToast({msg,color}); setTimeout(()=>setToast(null),4000) }

  // 1) Inicializar MiniKit (OBLIGATORIO en v2 antes de cualquier comando)
  // 2) Si estamos dentro de World App, conectar automáticamente
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const init = async () => {
      const refParam = new URLSearchParams(window.location.search).get('ref')
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

      // Resolver el link de invitación DESPUÉS de confirmar MiniKit,
      // porque si viene como username hace falta resolverlo a address.
      if (refParam) {
        if (refParam.startsWith('u:')) {
          if (installed) {
            try {
              const u = await MiniKit.getUserByUsername(refParam.slice(2))
              if (u?.walletAddress) setRefFromLink(u.walletAddress)
            } catch (e) {}
          }
        } else {
          const raw = refParam.startsWith('a:') ? refParam.slice(2) : refParam
          if (/^0x[0-9a-fA-F]{40}$/i.test(raw)) setRefFromLink(raw)
        }
      }
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
    setWldPrev(p => ({...p, base:fmt(base)+' HACHI', total:fmt(total)+' HACHI', daily:fmt(perDay)+' HACHI/día'}))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selWLD, wldHachi])

  useEffect(() => {
    if (hachiSushi <= 0) return
    const sushiBase = [500,2000,5000,10000][selSUSHI] * hachiSushi
    const total     = sushiBase * 1.25
    setSushiPrev(p => ({...p, base:Math.round(sushiBase).toLocaleString()+' SUSHI', total:Math.round(total).toLocaleString()+' SUSHI'}))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selSUSHI, hachiSushi])


  const nameFor = (a: string): string => {
    if (!a) return '—'
    if (addr && a.toLowerCase() === addr.toLowerCase() && username) return username
    const cached = usernameCache[a.toLowerCase()]
    return cached || '···'
  }

  const resolveUsernames = useCallback(async (addresses: string[]) => {
    if (!MiniKit.isInstalled()) return
    const pending = Array.from(new Set(
      addresses.filter(a => a && !usernameCache[a.toLowerCase()]).map(a => a.toLowerCase())
    ))
    if (pending.length === 0) return
    const results = await Promise.allSettled(pending.map(a => MiniKit.getUserByAddress(a)))
    setUsernameCache(prev => {
      const next = {...prev}
      results.forEach((r, i) => {
        const found = r.status === 'fulfilled' ? r.value?.username : null
        if (found) {
          next[pending[i]] = found
        } else if (!next[pending[i]]) {
          next[pending[i]] = 'UserVerif ' + userVerifCounter.current++
        }
      })
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usernameCache])

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
        expirationTime: new Date(Date.now() + 60*1000),
        notBefore: new Date(Date.now() - 60*1000),
      })
      log('walletAuth executedWith: ' + walletAuthResult.executedWith)
      // v2: la dirección viene en walletAuthResult.data.address
      const walletAddr = walletAuthResult.data.address || MiniKit.user?.walletAddress || ''
      if (walletAddr) {
        log('addr: ' + walletAddr.slice(0,10))
        setAddr(walletAddr)
        setUsername(MiniKit.user?.username || '')
        resolveUsernames([walletAddr])
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
    await Promise.allSettled([loadBal(address,p), loadOracle(address,p), checkVerif(address,p), checkDaily(address,p), loadPools(p), loadLock(p), loadActiveLicCount(address,p)])
  }

  const loadBal = async (a: string, p: ethers.JsonRpcProvider) => {
    try {
      const [h,w,s] = await Promise.all([
        new ethers.Contract(C.hachi,ERC20,p).balanceOf(a),
        new ethers.Contract(C.wld,ERC20,p).balanceOf(a),
        new ethers.Contract(C.sushi,ERC20,p).balanceOf(a),
      ])
      const hN=fe(h), wN=fe(w)
      setHachiB(hN.toFixed(2)); setWldB(wN.toFixed(2)); setSushiB(fe(s).toFixed(2))
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
      setPoolFree(fmt(hf)+' HACHI'); setLicsAvail(lb>0?lb+' lics. básicas':'0'); setLicsAvailNum(lb)
    } catch(e) {}
  }

  const handleGetRpSignature = async (): Promise<RpContext | null> => {
    try {
      const res = await fetch('/api/rp-signature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify-human' }),
      })
      if (!res.ok) return null
      const { sig, nonce, created_at, expires_at } = await res.json()
      return { rp_id: 'rp_ef869d909ad99c43', signature: sig, nonce, created_at, expires_at }
    } catch { return null }
  }

  const handleOpenVerify = async () => {
    setRpLoading(true)
    const ctx = await handleGetRpSignature()
    setRpLoading(false)
    if (!ctx) { toast_('Error al generar la firma. Reintentá.', '#f85149'); return }
    setRpContext(ctx)
    setShowVerify(true)
  }

  const checkVerif = async (a: string, p: ethers.JsonRpcProvider) => {
    // A propósito: NO seteamos verified=true acá aunque el backend diga que
    // esta wallet ya se verificó antes. Se pide la verificación de World ID
    // SIEMPRE que alguien reingresa a la app, sin excepción, aunque genere
    // fricción — decisión de producto explícita, no un bug.
    try {
      const res = await fetch('/api/verify-status?address=' + a)
      const data = await res.json()
      if (data.verified) {
        fetch('/api/resync-verification?address=' + a).catch(() => {})
      }
    } catch(e) {}
  }

  const checkDaily = async (a: string, p: ethers.JsonRpcProvider) => {
    try {
      const dr = new ethers.Contract(C.dailyRewards, DAILY_REWARDS, p)
      const [hachiAmount, bonusAmount, canClaimNow, secondsUntilNext] = await dr.previewClaim(a)
      setPiggy({
        accrued: Number(fe(hachiAmount)),
        bonus: Number(fe(bonusAmount)),
        canWithdraw: Boolean(canClaimNow),
        secondsUntilNext: Number(secondsUntilNext),
      })
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
      setWldTierLoaded(true)
    } catch(e: any) { log('checkDaily core err: '+(e?.message||'').slice(0,80)) }
    try {
      const ok = await new ethers.Contract(C.lock, LOCK, p).canMine(a)
      canMineOk = Boolean(ok)
    } catch(e: any) { log('canMine err: '+(e?.message||'').slice(0,80)) }
    setSushiAccess(tierNum !== 255 || canMineOk)
  }

  const loadActiveLicCount = async (a: string, p: ethers.JsonRpcProvider) => {
    try {
      const core = new ethers.Contract(C.core, CORE, p)
      const ids: bigint[] = await core.getUserWLDLics(a)
      const now = Math.floor(Date.now()/1000)
      const results = await Promise.all(ids.map((id:bigint) => core.wldLics(id)))
      const count = results.filter((l:any) => l[10] && Number(l[7]) > now).length
      setActiveLicCount(count)
    } catch(e) {}
  }

  const loadSwapQuote = async (amountStr: string, dir: 'h2w'|'w2h') => {
    if (!amountStr || Number(amountStr) <= 0) { setSwapQuote('0'); return }
    try {
      const p = rpc()
      const pair = new ethers.Contract(HACHI_WLD_PAIR, PAIR_ABI, p)
      const [r0, r1] = await pair.getReserves()
      // token0 = WLD (0x2cfc...), token1 = HACHI (0xbE03...) por orden numérico de dirección
      const amountInWei = pe(amountStr)
      const adjBps = BigInt(200)
      const afterAdj = dir === 'h2w' ? amountInWei * (BigInt(10000) - adjBps) / BigInt(10000) : amountInWei
      const reserveIn  = dir === 'h2w' ? r1 : r0
      const reserveOut = dir === 'h2w' ? r0 : r1
      const amountInWithFee = afterAdj * BigInt(9970)
      const numerator = amountInWithFee * reserveOut
      const denominator = reserveIn * BigInt(10000) + amountInWithFee
      let out = numerator / denominator
      if (dir === 'w2h') out = out * (BigInt(10000) - adjBps) / BigInt(10000)
      setSwapQuote(fe(out).toFixed(6))
    } catch(e) { setSwapQuote('0') }
  }

  const loadSwapHistory = async (p: ethers.JsonRpcProvider) => {
    try {
      const sw = new ethers.Contract(HACHI_SWAP_ADDR, HACHISWAP_ABI, p)
      const filter = sw.filters.Swapped(addr)
      const currentBlock = await p.getBlockNumber()
      const CHUNK = 100, MAX_CHUNKS = 450, BATCH = 15
      let allEvents: any[] = []
      let to = currentBlock
      outer:
      for (let batchStart = 0; batchStart < MAX_CHUNKS && to >= 0; batchStart += BATCH) {
        const ranges: [number, number][] = []
        let cursor = to
        for (let j = 0; j < BATCH && cursor >= 0; j++) {
          const from = Math.max(0, cursor - CHUNK + 1)
          ranges.push([from, cursor])
          cursor = from - 1
        }
        const results = await Promise.all(ranges.map(([from, rTo]) => sw.queryFilter(filter, from, rTo).catch(() => [])))
        for (const evs of results) allEvents = allEvents.concat(evs)
        to = cursor
        if (allEvents.length >= 20) break outer
      }
      allEvents.sort((a:any,b:any) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      const history = allEvents.slice(-20).reverse().map((e:any) => ({
        hash: e.transactionHash,
        tokenIn: e.args.tokenIn,
        tokenOut: e.args.tokenOut,
        amountIn: e.args.amountIn,
        amountOut: e.args.amountOut,
      }))
      setSwapHistory(history)
    } catch(e:any) { log('swap history err: ' + (e?.message||'').slice(0,150)) }
  }

  const loadStreakStatus = async (p: ethers.JsonRpcProvider) => {
    try {
      const streak = new ethers.Contract(STREAK_ADDR, STREAK_ABI, p)
      const [swaps, volume, missionDone, dayNow, nextAmount, canClaimNow] = await streak.getTodayProgress(addr)
      const lastCredited = await streak.lastCreditedAt(addr).catch(() => BigInt(0))
      const poolFree = await streak.streakSushiPool().catch(() => BigInt(0))
      setStreakStatus({swaps: Number(swaps), volume: fe(volume), missionDone, day: Number(dayNow), nextAmount: fe(nextAmount), canClaimNow, lastCreditedAt: Number(lastCredited), poolFree: fe(poolFree)})
    } catch(e) {}
  }

  const claimStreak = async () => {
    setClaimingStreak(true)
    try {
      toast_('Reclamando bono de racha...', '#d29922')
      await sendTx(STREAK_ADDR, STREAK_ABI, 'claimStreakBonus', [])
      toast_('✓ Bono de racha reclamado', '#3fb950')
      loadStreakStatus(rpc())
      loadStreakHistory(rpc())
    } catch(e: any) {
      toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149')
    } finally {
      setClaimingStreak(false)
    }
  }

  const loadStreakHistory = async (p: ethers.JsonRpcProvider) => {
    try {
      const streak = new ethers.Contract(STREAK_ADDR, STREAK_ABI, p)
      const currentBlock = await p.getBlockNumber()
      const CHUNK = 100, MAX_CHUNKS = 450
      let allEvents: any[] = []
      let to = currentBlock
      for (let i = 0; i < MAX_CHUNKS && to >= 0; i++) {
        const from = Math.max(0, to - CHUNK + 1)
        try {
          const evs = await streak.queryFilter(streak.filters.DayCredited(addr), from, to)
          allEvents = allEvents.concat(evs)
        } catch(e) {}
        to = from - 1
        if (allEvents.length >= 10) break
      }
      allEvents.sort((a:any,b:any) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      const history = allEvents.slice(-10).reverse().map((e:any) => ({ hash: e.transactionHash, day: Number(e.args.day), amount: fe(e.args.amount) }))
      setStreakHistory(history)
    } catch(e) {}
  }

  const loadSwapRanking = async (p: ethers.JsonRpcProvider) => {
    try {
      const streak = new ethers.Contract(STREAK_ADDR, STREAK_ABI, p)
      const [addrs, amounts] = await streak.getRanking()
      const list = addrs.map((a:string, i:number) => ({ addr: a, amount: fe(amounts[i]) }))
        .sort((a:any,b:any) => b.amount - a.amount)
        .slice(0, 20)
      setSwapRanking(list)
      resolveUsernames(list.map((r:any) => r.addr))
      const nextIn = await streak.timeUntilNextRanking()
      setSwapRankingNextIn(Number(nextIn))
      const lastExecTs = Number(await streak.lastRankingExecutedAt())
      if (lastExecTs > 0) {
        try {
          const currentBlock = await p.getBlockNumber()
          const blocksAgo = Math.ceil((Date.now()/1000 - lastExecTs) / 2)
          const est = currentBlock - blocksAgo
          const fromBlock = Math.max(0, est - 40)
          const toBlock = est + 40
          const logs = await streak.queryFilter('SwapRankingPrizePaid', fromBlock, toBlock)
          const winners = (logs as any[])
            .map(l => ({addr: l.args[0], amount: fe(l.args[1]), rank: Number(l.args[2])}))
            .sort((a,b) => a.rank - b.rank)
          setSwapLastWinners(winners)
          setSwapLastExecDate(new Date(lastExecTs*1000).toLocaleDateString('es',{day:'numeric',month:'long',year:'numeric'}))
          resolveUsernames(winners.map(w => w.addr))
        } catch(e) {}
      }
    } catch(e) {}
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
    if (!verified) { await handleOpenVerify(); throw new Error('__VERIFY_OPENED__') }
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
    if (!verified) { await handleOpenVerify(); throw new Error('__VERIFY_OPENED__') }
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
    const hachiNeeded = [500,2000,5000,10000][selSUSHI] * sushiQty
    if (hachiRaw < hachiNeeded) { toast_(`Sin saldo HACHI. Comprá HACHI: ${HACHI_BUY_URL}`,'#f85149'); return }
    const amtUnit = [pe(500),pe(2000),pe(5000),pe(10000)][selSUSHI]
    try {
      for (let i = 0; i < sushiQty; i++) {
        toast_(sushiQty>1?`Comprando Bocado ${i+1} de ${sushiQty}...`:'Comprando Bocado...', '#d29922')
        await sendTxMulti([
          ...buildPermit2Approvals(C.hachi, C.core, amtUnit),
          { to: C.core, abi: CORE, fnName: 'buyLicenseSushi', args: [selSUSHI] },
        ])
      }
      toast_(sushiQty>1?`✓ ${sushiQty} Bocados comprados`:'✓ Bocado comprado', '#3fb950')
      setSushiQty(1)
      await loadAll(addr)
    } catch(e: any) {
      const msg = (e.reason||e.message||'').toLowerCase()
      if (msg.includes('pool a insufficient')) toast_('⏳ Sin fondos en el pool ahora mismo — probá más tarde', '#f85149')
      else toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149')
    }
  }

  const withdrawDaily = async () => {
    if (!piggy.canWithdraw) { toast_('Todavía no podés reclamar','#f85149'); return }
    try {
      toast_('Reclamando recompensa diaria...', '#d29922')
      await sendTx(C.dailyRewards, DAILY_REWARDS, 'claim', [])
      toast_('✓ Recompensa reclamada', '#3fb950')
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
  const claimWLD = async (id: bigint) => {
    const ok = await execTx('Cobrando HACHI', C.core, CORE, 'claimWLDHachi', [id])
    if (ok) loadWLDLics(rpc())
  }
  const claimAllWLD = async () => {
    if (wldLics.length === 0) return
    try {
      toast_('Cobrando todas las licencias...', '#d29922')
      const calls = wldLics.map(({id}) => ({ to: C.core, abi: CORE, fnName: 'claimWLDHachi', args: [id] }))
      await sendTxMulti(calls)
      toast_('✓ Todo cobrado', '#3fb950')
      await loadAll(addr)
      loadWLDLics(rpc())
    } catch(e: any) {
      toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149')
    }
  }
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
    if (v==='lics') { loadWLDLics(p); loadWldLicActiveCount(p) }
    if (v==='lock') { loadLock(p); loadVipHolders(p) }
    if (v==='ranking') loadRanking(p)
    if (v==='estado') { loadMyStatus(p); loadWLDLics(p); loadLock(p); loadRanking(p); loadStreakStatus(p) }
    if (v==='drachmaminer') { loadDrachmaMiner(p); loadDrachmaActiveCount(p); loadDrachmaMinerHistory(p) }
    if (v==='wldminer') { loadWldMiner(p); loadWldActiveCount(p); loadWldMinerHistory(p) }
    if (v==='weeklybonus') { loadWeeklyBonus(p) }
    if (v==='centrohachi') { loadWLDLics(p); loadDrachmaMiner(p); loadWldMiner(p); loadWeeklyBonus(p); loadVipHolders(p); loadLock(p); checkDaily(addr, p) }
    if (v==='pools') { loadPools(p); loadPoolsExtra(p); loadVipHolders(p) }
    if (v==='refs') loadRefs(p)
    if (v==='swap') { loadSwapHistory(p); loadStreakStatus(p); loadStreakHistory(p); loadSwapRanking(p) }
  }

  const loadWLDLics = async (p: ethers.JsonRpcProvider) => {
    try {
      const core = new ethers.Contract(C.core,CORE,p)
      const px = [1,3,5,10][selWLD]
      let base=px*wldHachi, total=Math.round(base*1.3), perDay=Math.round(total/90)
      try { const prev=await new ethers.Contract(C.oracle,ORACLE,p).previewWldLicense(pe(px)); base=fe(prev[0]); total=fe(prev[1]); perDay=fe(prev[2]) } catch(e) {}
      const monthly = await core.monthlyWLDRemaining(addr).catch(() => [BigInt(5),BigInt(0)])
      setWldPrev({base:fmt(base)+' HACHI', total:fmt(total)+' HACHI', daily:fmt(perDay)+' HACHI/día', monthly:Number(monthly[0])+' disponibles'})
      const ids = await core.getUserWLDLics(addr)
      const lics = await Promise.all(ids.map(async(id:bigint) => ({id, l:await core.wldLics(id), pend:await core.pendingWLDHachi(id)})))
      setWldLics(lics.filter((x:any) => x.l[10]||x.l[11]))
      setWldLicsLoadedAt(Date.now())
      setWldLicsLoaded(true)
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
    let rewardRaw = 0
    try {
      const s = await r.getUserStats(addr)
      myPts     = Number(s[0])
      totalHist = fmt(Number(s[1])) + ' pts'
      rewardRaw = fe(s[2])
      reward    = fmt(rewardRaw) + ' HACHI'
      earned    = fmt(fe(s[3])) + ' HACHI'
    } catch(e: any) { log('ranking getUserStats err: '+(e?.message||'').slice(0,60)) }
    try {
      const rk = await r.getCurrentRanking()
      const list = rk[0].map((a:string,i:number) => ({a,pts:Number(rk[1][i])})).filter((e:any) => e.pts>0).sort((a:any,b:any) => b.pts-a.pts)
      const idx = list.findIndex((e:any) => e.a.toLowerCase()===addr.toLowerCase())
      pos = idx>=0 ? '#'+(idx+1) : '—'
      setRankList(list)
      resolveUsernames(list.map((e:any) => e.a))
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
          .sort((a,b) => a.rank - b.rank)
        log(`lastWinners after filter: ${winners.length}`)
        setLastWinners(winners)
        setLastExecDate(new Date(lastExecTs*1000).toLocaleDateString('es',{day:'numeric',month:'long',year:'numeric'}))
        resolveUsernames(winners.map(w => w.addr))
      } else {
        log('lastWinners: lastExecTs=0, skipping')
      }
    } catch(e: any) {
      log('lastWinners err: '+(e?.message||'').slice(0,80))
      try { log('lastWinners err detail: '+JSON.stringify(e).slice(0,120)) } catch {}
    }
    setRankStats({points:fmt(myPts), totalHist, pos, reward, earned, nextDist, rewardRaw})
  }

  const loadMyStatus = async (p: ethers.JsonRpcProvider) => {
    setMyStatus(prev => ({...prev, loading: true}))
    try {
      const core = new ethers.Contract(C.core, CORE, p)
      const [sushiIds, specialAvail, lastSpecial] = await Promise.all([
        core.getUserSushiLics(addr),
        core.specialSushiAvailable(addr),
        core.lastSpecialSushi(addr),
      ])
      setMyStatus({bocadoCount: sushiIds.length, specialAvail, lastSpecial: Number(lastSpecial), loading: false})
    } catch(e) {
      setMyStatus(prev => ({...prev, loading: false}))
    }
  }

  const withRetry = async <T,>(fn: () => Promise<T>, retries = 3, delayMs = 700): Promise<T> => {
    let lastErr: any
    for (let i = 0; i < retries; i++) {
      try { return await fn() }
      catch (e) { lastErr = e; if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1))) }
    }
    throw lastErr
  }

  const loadDrachmaActiveCount = async (p: ethers.JsonRpcProvider) => {
    try {
      await withRetry(async () => {
        const dm = new ethers.Contract(DRACHMA_MINER_ADDR_OLD, DRACHMA_MINER_ABI, p)
        const total = Number(await dm.mineId())
        const nowSecs = Math.floor(Date.now()/1000)
        let real = 0
        const BATCH = 8
        for (let i = 1; i <= total; i += BATCH) {
          const ids = []
          for (let j = i; j < Math.min(i+BATCH, total+1); j++) ids.push(j)
          const results = await Promise.all(ids.map(id => dm.mines(id)))
          for (const m of results) {
            const active = m[9]
            const drachmaTotal = fe(m[3])
            const drachmaClaimed = fe(m[4])
            const endTime = Number(m[7])
            const restante = drachmaTotal - drachmaClaimed
            if (active && (nowSecs < endTime || restante > 0.01)) real++
          }
        }
        setDrachmaActiveCount({real, total})
      })
    } catch(e:any) { log('drachma count err: '+(e?.message||'').slice(0,80)) }
  }

  const loadDrachmaMinerHistory = async (p: ethers.JsonRpcProvider) => {
    try {
      const dmOld = new ethers.Contract(DRACHMA_MINER_ADDR_OLD, DRACHMA_MINER_ABI, p)
      const dmNew = new ethers.Contract(DRACHMA_MINER_ADDR_NEW, DRACHMA_MINER_ABI, p)
      const [oldId, newId] = await Promise.all([dmOld.activeMineId(addr), dmNew.activeMineId(addr)])
      const history: {contrato:string, id:number, hachiPaid:number, drachmaTotal:number, done:boolean}[] = []
      if (Number(oldId) > 0) {
        const m = await dmOld.mines(oldId)
        const hachiPaid = fe(m[2])
        const drachmaTotal = fe(m[3]), drachmaClaimed = fe(m[4])
        const done = (drachmaTotal - drachmaClaimed) <= 0.01
        history.push({contrato:'Anterior', id:Number(oldId), hachiPaid, drachmaTotal, done})
      }
      if (Number(newId) > 0) {
        const m = await dmNew.mines(newId)
        const hachiPaid = fe(m[2])
        const drachmaTotal = fe(m[3]), drachmaClaimed = fe(m[4])
        const done = (drachmaTotal - drachmaClaimed) <= 0.01
        history.push({contrato:'Actual', id:Number(newId), hachiPaid, drachmaTotal, done})
      }
      setDrachmaMinerHistory(history)
    } catch(e:any) { log('drachma history err: '+(e?.message||'').slice(0,80)) }
  }

  const loadDrachmaMiner = async (p: ethers.JsonRpcProvider) => {
    try {
      await withRetry(async () => {
        const dmOld = new ethers.Contract(DRACHMA_MINER_ADDR_OLD, DRACHMA_MINER_ABI, p)

        // 1. ¿El usuario tiene algo REAL (no solo polvo) en el contrato viejo?
        const oldActiveId = await dmOld.activeMineId(addr)
        let useOld = false
        let oldMineInfo: any = null
        if (Number(oldActiveId) > 0) {
          const [m, pending] = await Promise.all([dmOld.mines(oldActiveId), dmOld.pendingDrachma(oldActiveId)])
          const activeFlag = m[9]
          const drachmaTotal = fe(m[3]), drachmaClaimed = fe(m[4])
          const restante = drachmaTotal - drachmaClaimed
          const nowSecs = Math.floor(Date.now()/1000)
          const endTimeOld = Number(m[7])
          if (activeFlag && (nowSecs < endTimeOld || restante > 0.01)) {
            useOld = true
            oldMineInfo = {active: activeFlag, drachmaTotal, drachmaClaimed, pending: fe(pending), endTime: endTimeOld}
          }
        }

        // 2. Si NUNCA minó en el viejo (activeMineId=0), chequear si el viejo tiene pool suficiente.
        // Si ya minó ahí alguna vez (aunque solo le quede polvo), el contrato viejo lo va a
        // rechazar para siempre por su propio chequeo interno de "1 mina activa" — así que
        // en ese caso SIEMPRE usamos el nuevo, sin importar el pool del viejo.
        if (!useOld && Number(oldActiveId) === 0) {
          const [oldPool, oldCommitted]: [bigint, bigint] = await Promise.all([dmOld.drachmaPool(), dmOld.drachmaCommitted()])
          useOld = fe(oldPool - oldCommitted) > 500
        }

        const dmAddr = useOld ? DRACHMA_MINER_ADDR_OLD : DRACHMA_MINER_ADDR_NEW
        const dm = useOld ? dmOld : new ethers.Contract(DRACHMA_MINER_ADDR_NEW, DRACHMA_MINER_ABI, p)

        const [tier, activeId, durationSecs, discountBpsRaw] = await Promise.all([dm.getUserTier(addr), dm.activeMineId(addr), dm.mineDuration(), dm.discountBps().catch(() => BigInt(1500))])
        const amounts = await Promise.all([0,1,2,3].map(i => dm.tierDrachmaAmounts(i)))
        const costs = await Promise.all([0,1,2,3].map(i => dm.costInHachi(i).catch(() => BigInt(0))))

        let mineInfo = oldMineInfo || {active:false, drachmaTotal:0, drachmaClaimed:0, pending:0, endTime:0}
        if (!oldMineInfo && Number(activeId) > 0) {
          const [m, pending] = await Promise.all([dm.mines(activeId), dm.pendingDrachma(activeId)])
          mineInfo = {active: m[9], drachmaTotal: fe(m[3]), drachmaClaimed: fe(m[4]), pending: fe(pending), endTime: Number(m[7])}
        }

        const [dPool, dCommitted]: [bigint, bigint] = await Promise.all([dm.drachmaPool(), dm.drachmaCommitted()])
        setDrachmaMiner({
          tier: Number(tier),
          amounts: amounts.map(fe),
          costs: costs.map(fe),
          activeMineId: useOld ? Number(oldActiveId) : Number(activeId),
          poolFree: fe(dPool - dCommitted),
          durationDays: Math.round(Number(durationSecs) / 86400),
          loaded: true,
          contractAddr: dmAddr,
          isNewContract: !useOld,
          discountBps: Number(discountBpsRaw),
          ...mineInfo,
        })
      })
    } catch(e:any) { log('drachma miner err: '+(e?.message||'').slice(0,80)) }
  }

  const loadWldLicActiveCount = async (p: ethers.JsonRpcProvider) => {
    try {
      await withRetry(async () => {
        const core = new ethers.Contract(C.core, CORE, p)
        const total = Number(await core.wldLicId())
        const nowSecs = Math.floor(Date.now()/1000)
        let real = 0
        const BATCH = 8
        for (let i = 0; i < total; i += BATCH) {
          const ids = []
          for (let j = i; j < Math.min(i+BATCH, total); j++) ids.push(j)
          const results = await Promise.all(ids.map(id => core.wldLics(id)))
          for (const l of results) {
            const active = l[10]
            const hachiTotal = fe(l[3])
            const hachiClaimed = fe(l[5])
            const endTime = Number(l[7])
            const restante = hachiTotal - hachiClaimed
            if (active && (nowSecs < endTime || restante > 0.01)) real++
          }
        }
        setWldLicActiveCount({real, total})
      })
    } catch(e:any) { log('wld lic count err: '+(e?.message||'').slice(0,80)) }
  }

  const loadWldActiveCount = async (p: ethers.JsonRpcProvider) => {
    try {
      await withRetry(async () => {
        const wm = new ethers.Contract(WLD_MINER_ADDR_OLD, WLD_MINER_ABI, p)
        const total = Number(await wm.mineId())
        const nowSecs = Math.floor(Date.now()/1000)
        let real = 0
        const BATCH = 8
        for (let i = 1; i <= total; i += BATCH) {
          const ids = []
          for (let j = i; j < Math.min(i+BATCH, total+1); j++) ids.push(j)
          const results = await Promise.all(ids.map(id => wm.mines(id)))
          for (const m of results) {
            const active = m[10]
            const hachiTotal = fe(m[3])
            const hachiClaimed = fe(m[4])
            const drachmaTotal = fe(m[5])
            const drachmaClaimed = fe(m[6])
            const endTime = Number(m[8])
            const restanteHachi = hachiTotal - hachiClaimed
            const restanteDrachma = drachmaTotal - drachmaClaimed
            if (active && (nowSecs < endTime || restanteHachi > 0.01 || restanteDrachma > 0.01)) real++
          }
        }
        setWldActiveCount({real, total})
      })
    } catch(e:any) { log('wld count err: '+(e?.message||'').slice(0,80)) }
  }

  const loadWldMinerHistory = async (p: ethers.JsonRpcProvider) => {
    try {
      const wmOld = new ethers.Contract(WLD_MINER_ADDR_OLD, WLD_MINER_ABI, p)
      const wmNew = new ethers.Contract(WLD_MINER_ADDR_NEW, WLD_MINER_ABI, p)
      const [oldId, newId] = await Promise.all([wmOld.activeMineId(addr), wmNew.activeMineId(addr)])
      const history: {contrato:string, id:number, wldPaid:number, hachiTotal:number, drachmaTotal:number, done:boolean}[] = []
      if (Number(oldId) > 0) {
        const m = await wmOld.mines(oldId)
        const wldPaid = fe(m[2])
        const hachiTotal = fe(m[3]), hachiClaimed = fe(m[4])
        const drachmaTotal = fe(m[5]), drachmaClaimed = fe(m[6])
        const done = (hachiTotal - hachiClaimed <= 0.01) && (drachmaTotal - drachmaClaimed <= 0.01)
        history.push({contrato:'Anterior', id:Number(oldId), wldPaid, hachiTotal, drachmaTotal, done})
      }
      if (Number(newId) > 0) {
        const m = await wmNew.mines(newId)
        const wldPaid = fe(m[2])
        const hachiTotal = fe(m[3]), hachiClaimed = fe(m[4])
        const drachmaTotal = fe(m[5]), drachmaClaimed = fe(m[6])
        const done = (hachiTotal - hachiClaimed <= 0.01) && (drachmaTotal - drachmaClaimed <= 0.01)
        history.push({contrato:'Actual', id:Number(newId), wldPaid, hachiTotal, drachmaTotal, done})
      }
      setWldMinerHistory(history)
    } catch(e:any) { log('wld history err: '+(e?.message||'').slice(0,80)) }
  }

  const loadWldMiner = async (p: ethers.JsonRpcProvider) => {
    try {
      await withRetry(async () => {
        const wmOld = new ethers.Contract(WLD_MINER_ADDR_OLD, WLD_MINER_ABI, p)

        // 1. ¿El usuario tiene algo REAL (no solo polvo) en el contrato viejo?
        const oldActiveId = await wmOld.activeMineId(addr)
        let useOld = false
        let oldMineInfo: any = null
        if (Number(oldActiveId) > 0) {
          const [m, pending] = await Promise.all([wmOld.mines(oldActiveId), wmOld.pendingRewards(oldActiveId)])
          const activeFlag = m[10]
          const hachiTotal = fe(m[3]), hachiClaimed = fe(m[4])
          const drachmaTotal = fe(m[5]), drachmaClaimed = fe(m[6])
          const restanteHachi = hachiTotal - hachiClaimed
          const restanteDrachma = drachmaTotal - drachmaClaimed
          const nowSecs = Math.floor(Date.now()/1000)
          const endTimeOld = Number(m[8])
          if (activeFlag && (nowSecs < endTimeOld || restanteHachi > 0.01 || restanteDrachma > 0.01)) {
            useOld = true
            oldMineInfo = {
              active: activeFlag, variant: Number(m[1]),
              hachiTotal, hachiClaimed, drachmaTotal, drachmaClaimed,
              pendingHachi: fe(pending[0]), pendingDrachma: fe(pending[1]),
              endTime: endTimeOld,
            }
          }
        }

        // 2. Si NUNCA minó en el viejo (activeMineId=0), chequear si el viejo tiene pool suficiente.
        // Si ya minó ahí alguna vez (aunque solo le quede polvo), el contrato viejo lo va a
        // rechazar para siempre por su propio chequeo interno de "1 mina activa" — así que
        // en ese caso SIEMPRE usamos el nuevo, sin importar el pool del viejo.
        if (!useOld && Number(oldActiveId) === 0) {
          const [oldHPool, oldHCommitted, oldDPool, oldDCommitted]: [bigint, bigint, bigint, bigint] = await Promise.all([
            wmOld.hachiPool(), wmOld.hachiCommitted(), wmOld.drachmaPool(), wmOld.drachmaCommitted(),
          ])
          useOld = fe(oldHPool - oldHCommitted) > 1000 && fe(oldDPool - oldDCommitted) > 10
        }

        const wmAddr = useOld ? WLD_MINER_ADDR_OLD : WLD_MINER_ADDR_NEW
        const wm = useOld ? wmOld : new ethers.Contract(WLD_MINER_ADDR_NEW, WLD_MINER_ABI, p)

        const variantsData = await Promise.all([0,1,2].map(i => wm.variants(i)))
        setWldMinerVariants(variantsData.map((v: any) => ({ days: Math.round(Number(v[0])/86400), pct: Number(v[1])/100 })))
        const [tier, cap, activeId, hPool, hCommitted, dPool, dCommitted]: [bigint, bigint, bigint, bigint, bigint, bigint, bigint] = await Promise.all([
          wm.getUserTier(addr), wm.maxInvestableWld(addr), wm.activeMineId(addr),
          wm.hachiPool(), wm.hachiCommitted(), wm.drachmaPool(), wm.drachmaCommitted(),
        ])
        let mineInfo = oldMineInfo || {active:false, variant:0, hachiTotal:0, hachiClaimed:0, drachmaTotal:0, drachmaClaimed:0, pendingHachi:0, pendingDrachma:0, endTime:0}
        if (!oldMineInfo && Number(activeId) > 0) {
          const [m, pending] = await Promise.all([wm.mines(activeId), wm.pendingRewards(activeId)])
          mineInfo = {
            active: m[10], variant: Number(m[1]),
            hachiTotal: fe(m[3]), hachiClaimed: fe(m[4]),
            drachmaTotal: fe(m[5]), drachmaClaimed: fe(m[6]),
            pendingHachi: fe(pending[0]), pendingDrachma: fe(pending[1]),
            endTime: Number(m[8]),
          }
        }
        setWldMiner({
          tier: Number(tier), cap: fe(cap), activeMineId: useOld ? Number(oldActiveId) : Number(activeId),
          poolFreeHachi: fe(hPool - hCommitted), poolFreeDrachma: fe(dPool - dCommitted),
          loaded: true,
          contractAddr: wmAddr,
          isNewContract: !useOld,
          ...mineInfo,
        })
      })
    } catch(e:any) { log('wld miner err: '+(e?.message||'').slice(0,80)) }
  }

  const loadVipHolders = async (p: ethers.JsonRpcProvider) => {
    try {
      await withRetry(async () => {
        const vh = new ethers.Contract(VIP_HOLDERS_ADDR, VIP_HOLDERS_ABI, p)
        const [level, preview, dPool, sPool] = await Promise.all([
          vh.getVipLevel(addr), vh.previewExchange(addr), vh.drachmaPool(), vh.sushiPool(),
        ])
        setVipData({
          level: Number(level),
          pendingHachi: fe(preview[0]),
          drachmaOut: fe(preview[1]),
          sushiOut: fe(preview[2]),
          drachmaPoolFree: fe(dPool),
          sushiPoolFree: fe(sPool),
          loaded: true,
        })
      })
    } catch(e:any) { log('vip holders err: '+(e?.message||'').slice(0,80)) }
  }

  const exchangeVipAction = async () => {
    if (!connected) { toast_(t('err_connect'),'#f85149'); return }
    setExchangingVip(true)
    try {
      toast_('Cambiando...', '#d29922')
      const vh = new ethers.Contract(VIP_HOLDERS_ADDR, VIP_HOLDERS_ABI, rpc())
      const [hachiAmount, drachmaOut, sushiOut] = await vh.previewExchange(addr)
      const expectedOut = vipPreferredToken === 0 ? drachmaOut : sushiOut
      const minOut = (expectedOut * BigInt(95)) / BigInt(100)
      const hachiWithBuffer = (hachiAmount * BigInt(102)) / BigInt(100)
      await sendTxMulti([
        ...buildPermit2Approvals(C.hachi, VIP_HOLDERS_ADDR, hachiWithBuffer),
        { to: VIP_HOLDERS_ADDR, abi: VIP_HOLDERS_ABI, fnName: 'exchange', args: [vipPreferredToken, minOut] },
      ])
      toast_('✓ Cambio realizado', '#3fb950')
      loadVipHolders(rpc())
      loadBal(addr, rpc())
    } catch(e: any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149') }
    finally { setExchangingVip(false) }
  }

  const loadPoolsExtra = async (p: ethers.JsonRpcProvider) => {
    try {
      const lockAbi = ['function apyPool() view returns (uint256)', 'function totalLocked() view returns (uint256)', 'function totalUsers() view returns (uint256)']
      const dailyAbi = ['function hachiPool() view returns (uint256)', 'function bonusPool() view returns (uint256)']
      const streakAbi = ['function streakSushiPool() view returns (uint256)']
      const rankingAbi = ['function periodPool() view returns (uint256)']
      const dmAbi = ['function drachmaPool() view returns (uint256)', 'function drachmaCommitted() view returns (uint256)']
      const wbAbi = ['function sushiPool() view returns (uint256)']
      const wmAbi = ['function hachiPool() view returns (uint256)', 'function hachiCommitted() view returns (uint256)', 'function drachmaPool() view returns (uint256)', 'function drachmaCommitted() view returns (uint256)']

      const lockC = new ethers.Contract(C.lock, lockAbi, p)
      const dailyC = new ethers.Contract(C.dailyRewards, dailyAbi, p)
      const streakC = new ethers.Contract(STREAK_ADDR, streakAbi, p)
      const rankingC = new ethers.Contract(C.ranking, rankingAbi, p)
      const dmC = new ethers.Contract(DRACHMA_MINER_ADDR_OLD, dmAbi, p)
      const dmCNew = new ethers.Contract(DRACHMA_MINER_ADDR_NEW, dmAbi, p)
      const wbC = new ethers.Contract(WEEKLY_BONUS_ADDR, wbAbi, p)
      const wmC = new ethers.Contract(WLD_MINER_ADDR_OLD, wmAbi, p)
      const wmCNew = new ethers.Contract(WLD_MINER_ADDR_NEW, wmAbi, p)

      const [apyPool, totalLocked, lockUsers, dailyHachiPool, dailyBonusPool, streakPool, rankingPeriodPool, dmPool, dmCommitted, dmPoolNew, dmCommittedNew, wbPool, wmHachiPool, wmHachiCommitted, wmDrachmaPool, wmDrachmaCommitted, wmHachiPoolNew, wmHachiCommittedNew, wmDrachmaPoolNew, wmDrachmaCommittedNew]: [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint] = await Promise.all([
        lockC.apyPool(), lockC.totalLocked(), lockC.totalUsers(),
        dailyC.hachiPool(), dailyC.bonusPool(),
        streakC.streakSushiPool(),
        rankingC.periodPool(),
        dmC.drachmaPool(), dmC.drachmaCommitted(),
        dmCNew.drachmaPool(), dmCNew.drachmaCommitted(),
        wbC.sushiPool(),
        wmC.hachiPool(), wmC.hachiCommitted(), wmC.drachmaPool(), wmC.drachmaCommitted(),
        wmCNew.hachiPool(), wmCNew.hachiCommitted(), wmCNew.drachmaPool(), wmCNew.drachmaCommitted(),
      ])

      setPoolsExtra({
        apyPool: fe(apyPool), totalLocked: fe(totalLocked), lockUsers: Number(lockUsers),
        dailyHachiPool: fe(dailyHachiPool), dailyBonusPool: fe(dailyBonusPool),
        streakPool: fe(streakPool),
        rankingPeriodPool: fe(rankingPeriodPool),
        drachmaMinerFree: fe(dmPool - dmCommitted),
        drachmaMinerFreeNew: fe(dmPoolNew - dmCommittedNew),
        weeklyBonusPool: fe(wbPool),
        wldMinerHachiFree: fe(wmHachiPool - wmHachiCommitted),
        wldMinerDrachmaFree: fe(wmDrachmaPool - wmDrachmaCommitted),
        wldMinerHachiFreeNew: fe(wmHachiPoolNew - wmHachiCommittedNew),
        wldMinerDrachmaFreeNew: fe(wmDrachmaPoolNew - wmDrachmaCommittedNew),
      })
    } catch(e:any) { log('pools extra err: '+(e?.message||'').slice(0,80)) }
  }

  const previewWldMine = async (variantOverride?: number) => {
    const wldAmount = parseFloat(selWldAmount)
    const variant = variantOverride !== undefined ? variantOverride : selWldVariant
    if (!wldAmount || wldAmount <= 0) { setWldMinerPreview({hachi:0, drachma:0}); return }
    try {
      const wm = new ethers.Contract(wldMiner.contractAddr, WLD_MINER_ABI, rpc())
      const [hachiTotal, drachmaTotal] = await wm.previewMine(pe(wldAmount), variant)
      setWldMinerPreview({hachi: fe(hachiTotal), drachma: fe(drachmaTotal)})
    } catch(e) { setWldMinerPreview({hachi:0, drachma:0}) }
  }

  const mineWldAction = async () => {
    if (!connected) { toast_(t('err_connect'),'#f85149'); return }
    const wldAmount = parseFloat(selWldAmount)
    if (!wldAmount || wldAmount <= 0) { toast_('Ingresá un monto válido', '#f85149'); return }
    setMiningWld(true)
    try {
      toast_('Minando...', '#d29922')
      const wm = new ethers.Contract(wldMiner.contractAddr, WLD_MINER_ABI, rpc())
      const wldWei = pe(wldAmount)
      const [hachiTotal, drachmaTotal] = await wm.previewMine(wldWei, selWldVariant)
      const minHachi = (hachiTotal * BigInt(98)) / BigInt(100)
      const minDrachma = (drachmaTotal * BigInt(98)) / BigInt(100)
      await sendTxMulti([
        ...buildPermit2Approvals(C.wld, wldMiner.contractAddr, wldWei),
        { to: wldMiner.contractAddr, abi: WLD_MINER_ABI, fnName: 'mineWld', args: [wldWei, selWldVariant, minHachi, minDrachma] },
      ])
      toast_('✓ Minería iniciada', '#3fb950')
      setSelWldAmount('')
      loadWldMiner(rpc())
    } catch(e: any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149') }
    finally { setMiningWld(false) }
  }

  const claimWldMinerAction = async () => {
    setClaimingWldMiner(true)
    try {
      toast_('Reclamando...', '#d29922')
      await sendTx(wldMiner.contractAddr, WLD_MINER_ABI, 'claimRewards', [wldMiner.activeMineId])
      toast_('✓ Reclamado', '#3fb950')
      loadWldMiner(rpc())
      loadBal(addr, rpc())
    } catch(e: any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149') }
    finally { setClaimingWldMiner(false) }
  }

  const loadWeeklyBonus = async (p: ethers.JsonRpcProvider) => {
    try {
      const wb = new ethers.Contract(WEEKLY_BONUS_ADDR, WEEKLY_BONUS_ABI, p)
      const [dailyRate, pending, lastAction, pool, duration] = await Promise.all([
        wb.getDailyRate(addr), wb.previewClaim(addr), wb.lastActionTime(addr), wb.sushiPool(), wb.cycleDuration(),
      ])
      const nowSecs = Math.floor(Date.now()/1000)
      const secondsUntilNext = Math.max(0, Number(lastAction) + Number(duration) - nowSecs)
      setWeeklyBonus({dailyRate: fe(dailyRate), pending: fe(pending), everClaimed: Number(lastAction) > 0, poolFree: fe(pool), secondsUntilNext})
    } catch(e) {}
  }

  const claimWeeklyBonus = async () => {
    if (!connected) { toast_(t('err_connect'),'#f85149'); return }
    setClaimingWeekly(true)
    try {
      toast_('Reclamando bono semanal...', '#d29922')
      await sendTx(WEEKLY_BONUS_ADDR, WEEKLY_BONUS_ABI, 'claimBonus', [])
      toast_('✓ Bono semanal reclamado', '#3fb950')
      loadWeeklyBonus(rpc())
      loadBal(addr, rpc())
    } catch(e: any) {
      toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149')
    } finally {
      setClaimingWeekly(false)
    }
  }

  const mineDrachmaAction = async () => {
    if (!connected) { toast_(t('err_connect'),'#f85149'); return }
    const costWithSlippage = drachmaMiner.costs[selDrachmaTier] * 1.02
    if (hachiRaw < costWithSlippage) { toast_(`Sin saldo HACHI suficiente. Necesitás ${costWithSlippage.toFixed(2)}, tenés ${hachiRaw.toFixed(2)}.`,'#f85149'); return }
    try {
      toast_('Minando Drachma...', '#d29922')
      const costWei = pe(costWithSlippage)
      await sendTxMulti([
        ...buildPermit2Approvals(C.hachi, drachmaMiner.contractAddr, costWei),
        { to: drachmaMiner.contractAddr, abi: DRACHMA_MINER_ABI, fnName: 'mineDrachma', args: [selDrachmaTier, costWei] },
      ])
      toast_(`✓ Drachma en generación (${drachmaMiner.durationDays} días)`, '#3fb950')
      loadDrachmaMiner(rpc())
    } catch(e: any) {
      log('drachma mine err: ' + JSON.stringify(e).slice(0,900))
      toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149')
    }
  }

  const claimDrachmaMineAction = async () => {
    try {
      toast_('Reclamando Drachma...', '#d29922')
      await sendTx(drachmaMiner.contractAddr, DRACHMA_MINER_ABI, 'claimDrachma', [drachmaMiner.activeMineId])
      toast_('✓ Drachma reclamado', '#3fb950')
      await new Promise(r => setTimeout(r, 1500))
      loadDrachmaMiner(rpc())
      loadBal(addr, rpc())
    } catch(e: any) { toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149') }
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
    localLicsAvail = n > 0 ? n + ' lics. básicas' : '0'
  } catch(e) {}
  let poolAFreeNum = 0
  try { const ps2 = await core.getPoolStatus(); poolAFreeNum = fe(ps2[2]) } catch(e) {}
  setPoolsData({wldTotal:fmt(fe(ws[0]))+' HACHI', wldComm:fmt(fe(ws[2]))+' HACHI', wldFree:fmt(fe(ws[1]))+' HACHI', wldPaid:fmt(fe(ws[3]))+' HACHI', poolA, poolAC, poolAF, poolAFreeNum, sushiAvail, wldSales:fmt(fe(st[0]))+' WLD', wldLics:st[2].toString(), sushiLics:st[3].toString(), burned:fmt(fe(st[4]))+' HACHI', licsAvail:localLicsAvail})
  } catch(e:any) { log('loadPools err: '+(e.message||'error').slice(0,50)) }
  }

  const loadRefs = async (p: ethers.JsonRpcProvider) => {
    try {
      const rf = new ethers.Contract(C.referral,REFERRAL,p)
      const [info,refB,newB] = await Promise.all([rf.getReferralInfo(addr), rf.currentRefBonus(), rf.currentNewBonus()])
      const referrerAddr = info[0]!=='0x0000000000000000000000000000000000000000'?info[0]:''
      setRefInfo({
        referrer: referrerAddr,
        totalRefs: Number(info[1]),
        earned: fmt(fe(info[2]))+' HACHI',
        refBonus: fmt(fe(refB)),
        newBonus: fmt(fe(newB)),
      })
      if (referrerAddr) resolveUsernames([referrerAddr])
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

  useEffect(() => {
    const id = setInterval(() => setLiveTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { loadSwapQuote(swapIn, swapDir) }, 400)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapIn, swapDir])

  const doSwap = async () => {
    if (!connected) { toast_(t('err_connect'),'#f85149'); return }
    const amountIn = Number(swapIn)
    if (!amountIn || amountIn <= 0) { toast_('Ingresá un monto válido','#f85149'); return }
    setSwapLoading(true)
    try {
      const tokenIn  = swapDir === 'h2w' ? C.hachi : C.wld
      const tokenOut = swapDir === 'h2w' ? C.wld   : C.hachi
      const amountInWei = pe(swapIn)
      const pair = new ethers.Contract(HACHI_WLD_PAIR, PAIR_ABI, rpc())
      const [r0, r1] = await pair.getReserves()
      const adjBps = BigInt(200)
      const afterAdj = swapDir === 'h2w' ? amountInWei * (BigInt(10000) - adjBps) / BigInt(10000) : amountInWei
      const reserveIn  = swapDir === 'h2w' ? r1 : r0
      const reserveOut = swapDir === 'h2w' ? r0 : r1
      const amountInWithFee = afterAdj * BigInt(9970)
      const numerator = amountInWithFee * reserveOut
      const denominator = reserveIn * BigInt(10000) + amountInWithFee
      let quoted = numerator / denominator
      if (swapDir === 'w2h') quoted = quoted * (BigInt(10000) - adjBps) / BigInt(10000)
      const minAmountOut = quoted - (quoted * BigInt(100) / BigInt(10000)) // 1% de tolerancia a slippage
      const deadline = Math.floor(Date.now()/1000) + 600
      toast_('Confirmando swap...', '#d29922')
      await sendTxMulti([
        ...buildPermit2Approvals(tokenIn, HACHI_SWAP_ADDR, amountInWei),
        { to: HACHI_SWAP_ADDR, abi: HACHISWAP_ABI, fnName: 'swap', args: [tokenIn, tokenOut, amountInWei, minAmountOut, deadline] },
      ])
      toast_('✓ Swap realizado', '#3fb950')
      setSwapIn(''); setSwapQuote('0')
      await loadAll(addr)
      loadSwapHistory(rpc())
      loadStreakStatus(rpc())
    } catch(e: any) {
      log('swap err: ' + JSON.stringify(e).slice(0,900))
      toast_('Error: '+(e.reason||e.message||'error').slice(0,80), '#f85149')
    } finally {
      setSwapLoading(false)
    }
  }

  const wldNames = ['🌱 Básica','⚡ Estándar','💎 Premium','🚀 Elite']
  const now_ts = Math.floor(Date.now()/1000)
  const activeEliteCount = wldLics.filter(({l}) => Number(l[1])===3 && l[10] && Number(l[7])>now_ts).length
  const wldPrices = ['1 WLD','3 WLD','5 WLD','10 WLD']
  const sushiNames = ['🌱 Bocado','⚡ Bocado Doble','💎 Bocado Grande','🚀 Bocado Real']
  const sushiPrices = ['500 HACHI','2,000 HACHI','5,000 HACHI','10,000 HACHI']

  // PANTALLA DE INICIO DE SESIÓN — se muestra mientras no haya wallet conectada
  if (!connected) {
    return (
      <div style={{minHeight:'100vh',background:'linear-gradient(160deg,#2a1f63 0%,#1d1a52 55%,#2b2c78 100%)',color:'#e6edf3',fontFamily:'Georgia,serif',display:'flex',flexDirection:'column',position:'relative',overflow:'hidden'}}>
        <style>{`
          @keyframes orbitRotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
          @keyframes orbitCounterRotate { from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }
        `}</style>
        {toast&&<div style={{position:'fixed',top:16,right:16,zIndex:999,padding:'10px 16px',borderRadius:8,background:'#161b22',border:`1px solid ${toast.color}`,color:toast.color,fontSize:13,maxWidth:320}}>{toast.msg}</div>}

        {/* selector de idioma arriba a la derecha */}
        <div style={{display:'flex',justifyContent:'flex-end',gap:4,padding:16}}>
          {SHOW_LANG_BUTTONS&&(['es','en','pt'] as Lang[]).map(l=><button key={l} onClick={()=>setLang(l)} style={{background:'none',border:`1px solid ${lang===l?'#a78bfa':'#30363d'}`,borderRadius:4,padding:'2px 8px',fontSize:11,cursor:'pointer',color:lang===l?'#e6edf3':'#8b949e'}}>{l.toUpperCase()}</button>)}
        </div>

        <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'8px 20px 40px',maxWidth:480,margin:'0 auto',width:'100%',position:'relative',zIndex:1}}>

          {/* HERO */}
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,marginBottom:8}}>
            <div style={{fontSize:38,filter:'drop-shadow(0 0 16px rgba(251,191,36,.6))'}}>⛏</div>
            <h1 style={{fontSize:34,fontWeight:700,color:'#fbbf24',textShadow:'0 0 18px rgba(251,191,36,.5)',margin:0,textAlign:'center'}}>HachiMiner</h1>
          </div>
          <p style={{fontSize:15,color:'#c4b5fd',fontStyle:'italic',textAlign:'center',margin:'0 0 20px',lineHeight:1.5,maxWidth:360}}>{loginCopy.tagline}</p>

          {/* CTA */}
          <button onClick={connectWallet} style={{...btnP,marginBottom:20,fontSize:15,padding:'14px 16px',width:'100%'}}>
            {inWA ? loginCopy.ctaWA : loginCopy.cta}
          </button>

          {/* FEATURES — gato al centro, funciones alrededor en círculo */}
          <div style={{position:'relative',width:300,height:300,margin:'0 auto 16px',maxWidth:'90vw'}}>
            <img src="/hachi-cat-savings.png" alt="" style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',width:110,height:110,borderRadius:20,objectFit:'cover',boxShadow:'0 0 30px rgba(232,121,249,.6)',border:'2px solid #e879f9',zIndex:1}} />
            <div style={{position:'absolute',inset:0,animation:'orbitRotate 40s linear infinite'}}>
              {loginCopy.features.map((f,i)=>{
                const n = loginCopy.features.length
                const angle = (i / n) * 2 * Math.PI - Math.PI / 2
                const radius = 125
                const x = 150 + radius * Math.cos(angle)
                const y = 150 + radius * Math.sin(angle)
                return <div key={i} style={{position:'absolute',left:x,top:y,transform:'translate(-50%,-50%)',textAlign:'center',width:84}}>
                  <div style={{animation:'orbitCounterRotate 40s linear infinite'}}>
                    {(f as any).iconImg ? <img src={(f as any).iconImg} alt="" width={26} height={26} style={{borderRadius:13,objectFit:'cover',marginBottom:2,filter:'drop-shadow(0 0 6px rgba(124,58,237,.5))'}} /> : <div style={{fontSize:26,marginBottom:2,filter:'drop-shadow(0 0 6px rgba(124,58,237,.5))'}}>{f.icon}</div>}
                    <div style={{fontSize:10,fontWeight:700,color:'#e6edf3',lineHeight:1.2}}>{f.title}</div>
                  </div>
                </div>
              })}
            </div>
          </div>

          <div style={{display:'flex',flexWrap:'wrap',gap:8,width:'100%',marginBottom:16}}>
            <a href="https://whatsapp.com/channel/0029Vb7aycxDjiOasgPK2k1h" target="_blank" rel="noopener noreferrer" style={{flex:1,minWidth:90,display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'11px 8px',borderRadius:10,background:'linear-gradient(135deg,#25D366,#128C7E)',color:'#fff',fontSize:12,fontWeight:700,textDecoration:'none',boxShadow:'0 2px 10px rgba(37,211,102,.35)'}}><img src="https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/whatsapp.svg" alt="" width={16} height={16} style={{filter:'brightness(0) invert(1)'}} />Canal Oficial</a>
            <a href="https://t.me/+mg3Tt_4pZJs4NTAx" target="_blank" rel="noopener noreferrer" style={{flex:1,minWidth:90,display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'10px 8px',borderRadius:8,border:'1px solid #229ED9',color:'#229ED9',fontSize:12,fontWeight:600,textDecoration:'none'}}><img src="https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/telegram.svg" alt="" width={16} height={16} style={{filter:'invert(52%) sepia(89%) saturate(1996%) hue-rotate(166deg) brightness(97%) contrast(96%)'}} />Telegram</a>
            <a href="https://www.facebook.com/share/1KMjUKy9Yg/" target="_blank" rel="noopener noreferrer" style={{flex:1,minWidth:90,display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'10px 8px',borderRadius:8,border:'1px solid #1877F2',color:'#1877F2',fontSize:12,fontWeight:600,textDecoration:'none'}}><img src="https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/facebook.svg" alt="" width={16} height={16} style={{filter:'invert(29%) sepia(94%) saturate(1837%) hue-rotate(200deg) brightness(97%) contrast(96%)'}} />Facebook</a>
            <a href="https://hachiminnerworld.netlify.app/transparencia" target="_blank" rel="noopener noreferrer" style={{flex:1,minWidth:90,display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'10px 8px',borderRadius:8,border:'1px solid #a78bfa',color:'#a78bfa',fontSize:12,fontWeight:600,textDecoration:'none'}}>📊 Transparencia</a>
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
          <p style={{fontSize:11,color:'#8b949e',textAlign:'center',marginTop:12,lineHeight:1.5}}>{loginCopy.disclaimer}</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{minHeight:'100vh',background:'linear-gradient(160deg,#2a1f63 0%,#1d1a52 55%,#2b2c78 100%)',color:'#e6edf3',fontFamily:'Georgia,serif'}}>
      {toast&&<div style={{position:'fixed',top:16,right:16,zIndex:999,padding:'10px 16px',borderRadius:8,background:'#161b22',border:`1px solid ${toast.color}`,color:toast.color,fontSize:13,maxWidth:320}}>{toast.msg}</div>}

      {verifyingBackend&&<div style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(20,10,45,.92)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16}}>
        <style>{`
          @keyframes catJump { 0%,100%{transform:translateY(0) rotate(0deg);} 25%{transform:translateY(-22px) rotate(-8deg);} 50%{transform:translateY(0) rotate(0deg);} 75%{transform:translateY(-10px) rotate(6deg);} }
        `}</style>
        <div style={{fontSize:64,animation:'catJump 0.9s ease-in-out infinite'}}>🐱</div>
        <div style={{fontSize:16,fontWeight:700,color:'#e879f9',textAlign:'center',padding:'0 24px'}}>Tu sistema se está cargando...</div>
        <div style={{fontSize:13,color:'#c4b5fd',textAlign:'center',padding:'0 32px',lineHeight:1.5}}>Estamos confirmando tu verificación en la blockchain. Esto puede tardar hasta 10 segundos.</div>
      </div>}

      {/* VERIFICACION WORLD ID 4.0 — IDKit gestiona su propio modal */}
      {rpContext&&(
        <IDKitRequestWidget
          app_id="app_ba8d66235ecf4bc9e341fff3768d9058"
          action="verify-human"
          rp_context={rpContext}
          allow_legacy_proofs={true}
          preset={orbLegacy({ signal: addr })}
          open={showVerify}
          onOpenChange={(open) => setShowVerify(open)}
          handleVerify={async (result) => {
            setVerifyingBackend(true)
            try {
              const res = await fetch('/api/verify-proof', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rp_id: 'rp_ef869d909ad99c43', idkitResponse: result, address: addr }),
                keepalive: true,
              })
              if (!res.ok) {
                const { error } = await res.json().catch(() => ({ error: 'Error desconocido' }))
                log('verify-proof falló: ' + String(error).slice(0,80))
                toast_('Verify falló: ' + String(error).slice(0,60), '#f85149')
                throw new Error(error)
              }
            } finally {
              setVerifyingBackend(false)
            }
          }}
          onSuccess={() => { justVerifiedRef.current = true; setVerified(true); setShowVerify(false); toast_('✓ Verificado con World ID', '#3fb950') }}
          onError={(code) => { if (!justVerifiedRef.current) toast_('Error: ' + code, '#f85149'); justVerifiedRef.current = false }}
        />
      )}

      {/* HEADER */}
      <style>{`
        @keyframes hachiFireFloat {
          0%,100% { transform: translateY(0px); }
          50% { transform: translateY(-4px); }
        }
        @keyframes quickAccessPulse {
          0%,100% { box-shadow: 0 0 6px rgba(167,139,250,.3); }
          50% { box-shadow: 0 0 14px rgba(167,139,250,.6); }
        }
        @keyframes orbitRotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes orbitCounterRotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(-360deg); }
        }
      `}</style>
      <div style={{background:'#211a55',borderBottom:'1px solid #4c3a8f',padding:'8px 14px',position:'sticky',top:0,zIndex:100}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,marginBottom:connected?8:0}}>
          <div style={{fontSize:25,fontWeight:800,color:'#a78bfa',textShadow:'0 2px 0 #5b21b6, 0 4px 6px rgba(0,0,0,.4), 0 0 14px rgba(167,139,250,.5)',whiteSpace:'nowrap',display:'inline-block'}}>⛏ HachiMiner</div>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <div style={{display:'flex',gap:4}}>
              {SHOW_LANG_BUTTONS&&(['es','en','pt'] as Lang[]).map(l=><button key={l} onClick={()=>setLang(l)} style={{background:'none',border:`1px solid ${lang===l?'#a78bfa':'#3a3470'}`,borderRadius:4,padding:'2px 6px',fontSize:11,cursor:'pointer',color:lang===l?'#e6edf3':'#9b96c4'}}>{l.toUpperCase()}</button>)}
            </div>
            <button onClick={connectWallet} style={{background:'#7c3aed',color:'#fff',border:'none',borderRadius:8,padding:'7px 14px',fontSize:13,fontWeight:600,cursor:'pointer',boxShadow:'0 0 14px rgba(124,58,237,.5)',whiteSpace:'nowrap'}}>{connected?nameFor(addr):t('connect')}</button>
          </div>
        </div>
        {connected&&<div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
          <div style={{display:'flex',gap:16}}>{[['HACHI',hachiB],['WLD',wldB],['SUSHI',sushiB]].map(([l,v])=><div key={l} style={{display:'flex',flexDirection:'column'}}><div style={{fontSize:9,color:'#9b96c4',textTransform:'uppercase',letterSpacing:.5}}>{l}</div><div style={{fontFamily:'monospace',fontSize:13,fontWeight:600}}>{v}</div></div>)}</div>
          <div onClick={()=>!verified&&!rpLoading&&handleOpenVerify()} style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:'#9b96c4',cursor:verified?'default':'pointer',whiteSpace:'nowrap'}}><div style={{width:7,height:7,borderRadius:'50%',background:verified?'#3fb950':rpLoading?'#d29922':'#6b6494'}}></div><span>{verified?t('verified'):rpLoading?'Verificando...':t('not_verified')}</span></div>
        </div>}
      </div>

      {/* NAV */}
      {SHOW_TOP_NAV&&<div style={{background:'#12022a',borderBottom:'1px solid #3b0764',display:'flex',overflowX:'auto',gap:2,padding:'0 12px'}}>
        {(['home','lics','lock','ranking','pools','swap','refs','estado'] as Tab[]).map((v,i)=>{
          const labels=[t('nav_home'),t('nav_lics'),t('nav_lock'),t('nav_rank'),t('nav_pools'),t('nav_swap'),t('nav_refs'),t('nav_estado')]
          return <button key={v} onClick={()=>loadTab(v)} style={{background:'none',border:'none',borderBottom:`2px solid ${tab===v?'#a78bfa':'transparent'}`,color:tab===v?'#a78bfa':'#8b949e',padding:'12px 14px',fontSize:13,cursor:'pointer',whiteSpace:'nowrap',fontFamily:'Georgia,serif',textShadow:tab===v?'0 0 8px #a78bfa':''}}>{labels[i]}</button>
        })}
      </div>}
      {!SHOW_TOP_NAV&&tab!=='home'&&<div style={{background:'#12022a',borderBottom:'1px solid #3b0764',padding:'8px 12px'}}>
        {(()=>{
          const MINERIA_SUBTABS = ['lics','bocado','drachmaminer','wldminer','weeklybonus']
          const backTo = MINERIA_SUBTABS.includes(tab) ? 'mineria' : 'home'
          const backLabel = backTo==='mineria' ? '← Volver a Minería' : '← Volver a Inicio'
          return <button onClick={()=>loadTab(backTo as Tab)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',padding:'6px 12px',fontSize:13,cursor:'pointer'}}>{backLabel}</button>
        })()}</div>}

      <div style={{maxWidth:480,margin:'0 auto',padding:16}}>

        {tab==='home'&&<div>
          {priceAlert&&<div style={{background:'rgba(248,113,113,.1)',border:'1px solid rgba(248,113,113,.4)',borderRadius:8,padding:12,marginBottom:12,fontSize:13,color:'#f87171',textAlign:'center'}}>⚠ Ventas WLD pausadas — HACHI devaluado ({fmt(wldHachi)} &gt; {MAX_HACHI.toLocaleString()})</div>}
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14}}>
            {[
              {icon:'🐱',label:'Mi Estado',tab:'estado' as Tab,delay:0},
              {icon:'🎯',label:'Centro Hachi',tab:'centrohachi' as Tab,delay:0.15,isNew:true},
              {icon:'⛏️',label:'Minería',tab:'mineria' as Tab,delay:0.3},
              {icon:'🔒',label:'Lock',tab:'lock' as Tab,delay:0.9},
              {icon:'🗳️',label:'Votación',tab:'voting' as Tab,delay:3.3},
              {icon:'🔄',label:'Swap',tab:'swap' as Tab,delay:1.2},
              {icon:'🌊',label:'Pools',tab:'pools' as Tab,delay:1.5},
              {icon:'🏆',label:'Ranking',tab:'ranking' as Tab,delay:1.8},
              {icon:'👥',label:'Referidos',tab:'refs' as Tab,delay:2.1},
            ].map(btn=><button key={btn.tab} onClick={()=>{loadTab(btn.tab); if((btn as any).openBuy) setShowBuyWLD(true)}} style={{position:'relative',display:'flex',flexDirection:'column',alignItems:'center',gap:4,padding:'12px 4px',borderRadius:12,border:'1px solid #5b21b6',background:'linear-gradient(135deg,#2d1b69,#1e0840)',color:'#e6edf3',cursor:'pointer',animation:`quickAccessPulse 3s ease-in-out infinite`,animationDelay:`${btn.delay}s`}}>
              {(btn as any).isNew&&<span style={{position:'absolute',top:-6,right:-6,background:'#f59e0b',color:'#1e0840',fontSize:8,fontWeight:800,padding:'2px 5px',borderRadius:8,boxShadow:'0 0 8px rgba(245,158,11,.6)'}}>NUEVO</span>}
              {(btn as any).iconImg ? <img src={(btn as any).iconImg} alt="" width={22} height={22} style={{borderRadius:11,objectFit:'cover'}} /> : <span style={{fontSize:22}}>{btn.icon}</span>}
              <span style={{fontSize:10,fontWeight:600}}>{btn.label}</span>
            </button>)}
          </div>
          <div style={card}><div style={cTitle}>HACHI</div>
            {connected&&<div style={{fontSize:12,color:'#c4b5fd',marginBottom:8}}>👋 Bienvenido, <span style={{fontWeight:700,color:'#e6edf3'}}>{nameFor(addr)}</span></div>}
            <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:12}}>
              <img src="/hachi-cat-savings.png" alt="Hachi el gato ahorrando monedas HACHI" width={88} height={88} style={{borderRadius:14,flexShrink:0,objectFit:'cover',boxShadow:'0 0 18px rgba(124,58,237,.35)'}} />
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:8}}>
                  <div style={{fontSize:26,fontWeight:700,fontFamily:'monospace',color:'#fbbf24'}}>{fmt(piggy.accrued)}</div>
                  <div style={{fontSize:13,color:'#8b949e'}}>HACHI ahorrados</div>
                </div>
                {piggy.bonus>0&&<div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:8}}>
                  <div style={{fontSize:18,fontWeight:700,fontFamily:'monospace',color:'#60a5fa'}}>{piggy.bonus.toFixed(1)}</div>
                  <div style={{fontSize:12,color:'#8b949e'}}>Drachma</div>
                </div>}
              </div>
            </div>
            {connected&&!verified&&<button onClick={handleOpenVerify} disabled={rpLoading} style={{...btnP,width:'100%',padding:'10px 12px',marginBottom:8,opacity:rpLoading?0.6:1}}>{rpLoading?'Preparando verificación...':'🪪 Verificar con World ID'}</button>}
            <button onClick={withdrawDaily} disabled={!piggy.canWithdraw||!connected} style={{...btnG,width:'100%',padding:'10px 12px',opacity:(!piggy.canWithdraw||!connected)?0.4:1}}>Retirar al wallet</button>
            <div style={{fontSize:10,color:'#8b949e',marginTop:8,lineHeight:1.5}}>{piggy.canWithdraw ? `Podés reclamar ${fmt(piggy.accrued)} HACHI${piggy.bonus>0?` + ${fmt(piggy.bonus)} bonus`:''} ahora.` : `Próximo reclamo disponible en ${Math.ceil(piggy.secondsUntilNext/3600)}h.`} Se puede reclamar una vez cada 24hs.</div>
            <div style={{fontSize:9,color:'#fbbf24',marginTop:4,fontStyle:'italic'}}>🐱 Bono aumentado por agosto, mes de los gatos — vuelve a su base normal después.</div>
            <div style={{fontSize:10,color:'#8b949e',marginTop:4}}>Licencias WLD activas: <span style={{color:'#e6edf3',fontWeight:600}}>{activeLicCount}</span></div>
          </div>
          <button onClick={()=>loadTab('swap')} style={{...btnG,width:'100%',marginBottom:12}}>🪙 Comprar HACHI</button>
          {!connected&&<div style={{textAlign:'center',padding:'32px 16px',color:'#8b949e'}}>
            <div style={{fontSize:32,marginBottom:8}}>👋</div>
            <div style={{fontWeight:600,color:'#e6edf3',marginBottom:4}}>Bienvenido a HachiMiner</div>
            <div>{t('connect_prompt')}</div>
            <button onClick={connectWallet} style={{...btnP,marginTop:16,maxWidth:200}}>{t('connect')}</button>
          </div>}
        </div>}

        {tab==='lics'&&<div>
          {licTab==='wld'&&<div>
            <div style={{display:'flex',justifyContent:'center',gap:16,marginBottom:10,fontSize:13,fontWeight:700}}>
              <span style={{color:'#34d399'}}>🟢 Activas {wldLicActiveCount.real}</span>
              <span style={{color:'#f87171'}}>🔴 Terminadas {wldLicActiveCount.total - wldLicActiveCount.real}</span>
            </div>
            <button onClick={()=>setShowInfoLics(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'6px 12px',cursor:'pointer',marginBottom:10,width:'100%'}}>ℹ️ ¿Cómo funcionan las licencias?</button>
            {showInfoLics&&<div style={{background:'rgba(167,139,250,.08)',border:'1px solid rgba(167,139,250,.35)',borderRadius:8,padding:14,marginBottom:12,fontSize:12,color:'#c4b5fd',lineHeight:1.6}}>
              <strong>¿Quién puede participar?</strong> Cualquier usuario verificado con World ID. Comprar tu primera licencia WLD es el punto de entrada a todo el sistema de minería de Hachi.
              <br/><br/>
              <strong>Licencias WLD:</strong> pagás WLD una vez y recibís HACHI de forma lineal durante 3 meses (30% de retorno total, 35% en Elite). Podés tener hasta <strong>5 licencias WLD nuevas por mes</strong>.
              <br/><br/>
              <strong>Tu licencia te convierte en minero:</strong> según tu nivel (Básica/Estándar/Premium/Elite), tenés acceso a distintos mineros más avanzados dentro de la app — Drachma Miner y WLD Miner — cada uno con un tope de inversión que crece con tu nivel. Cuanto más alto tu nivel, a más minerías y mayores montos podés acceder.
              <br/><br/>
              <strong>Cuántos Bocados Básicos podés comprar por día</strong> (según tu licencia WLD activa más alta):
              <br/>• Sin licencia WLD: no disponible
              <br/>• Básica: 1 por día
              <br/>• Estándar: 2 por día
              <br/>• Premium: 3 por día
              <br/>• Elite: 4 por día
              <br/><br/>
              <strong>Licencias Bocado:</strong> pagás HACHI y recibís SUSHI al instante (el monto base + 25% de bonus), sin esperar.
              <br/><br/>
              <strong>Sistema limitado y sostenible:</strong> todos los topes de inversión están pensados según tu nivel, para que el sistema crezca de forma controlada. El equipo de Hachi reinvierte parte de lo recaudado y distribuye recursos entre los distintos pools para mantener todo funcionando — podés ver el detalle real en la página de <strong>Transparencia</strong> (junto a los enlaces de comunidad).
            </div>}
            <div style={{background:'rgba(251,191,36,.1)',border:'1px solid rgba(251,191,36,.4)',borderRadius:8,padding:12,marginBottom:12,fontSize:12,color:'#fbbf24',textAlign:'center',fontWeight:700}}>
              🔒 Máximo 3 licencias Elite activas al mismo tiempo, por usuario
            </div>
            <div style={sLabel}>Mis licencias WLD</div>
            {!wldLicsLoaded?<div style={empty}><div style={{fontSize:28}}>⏳</div><div>Consultando tus licencias...</div></div>:wldLics.length===0?<div style={empty}><div style={{fontSize:28}}>💠</div><div>{t('no_lics')}</div></div>:<div style={card}>
              {wldLics.map(({id,l,pend})=>{
                const dailyHachi = fe(BigInt(l[4]) * BigInt(86400))
                const dailyDrachma = fe(l[2]) * 0.5
                const secsSinceLoad = Math.max(0, (liveTick - wldLicsLoadedAt) / 1000)
                const livePend = fe(pend) + (dailyHachi/86400) * secsSinceLoad
                const nowSecs = Math.floor(liveTick/1000)
                const endSecs = Number(l[7])
                const startSecs = Number(l[6])
                const secsLeft = endSecs - nowSecs
                const diasLeft = Math.floor(Math.abs(secsLeft)/86400)
                const horasLeft = Math.floor((Math.abs(secsLeft)%86400)/3600)
                const countdownLabel = secsLeft <= 0 ? 'Vencida' : `${diasLeft}d ${horasLeft}h restantes`
                return <div key={id.toString()} style={{borderBottom:'1px solid #3b0764',paddingBottom:10,marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}><strong>{['Básica','Estándar','Premium','Elite'][l[1]]} <span style={{fontSize:11,color:'#8b949e'}}>#{id.toString()}</span></strong><div style={{color:l[10]?'#3fb950':'#8b949e'}}>●</div></div>
                  <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Pendiente</span><span style={{color:'#3fb950',fontFamily:'monospace'}}>{livePend.toFixed(6)} HACHI</span></div>
                  <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Genera por día</span><span style={{fontFamily:'monospace'}}>{dailyHachi.toFixed(6)} HACHI</span></div>
                  <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Comprada</span><span style={{fontFamily:'monospace'}}>{new Date(startSecs*1000).toLocaleDateString()}</span></div>
                  <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Vence</span><span style={{fontFamily:'monospace'}}>{new Date(endSecs*1000).toLocaleDateString()}</span></div>
                  <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Tiempo restante</span><span style={{fontFamily:'monospace',color:secsLeft<=0?'#f87171':'#fbbf24',fontWeight:700}}>{countdownLabel}</span></div>
                </div>
              })}
              <button onClick={claimAllWLD} style={{...btnG,width:'100%',marginTop:4}}>Cobrar todo</button>
            </div>}
            <button onClick={()=>setShowBuyWLD(true)} style={{...btnP,width:'100%',marginBottom:12}}>🛒 Comprá tu licencia</button>
          </div>}
          {showBuyWLD&&<div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'#0f0224',zIndex:200,overflowY:'auto',padding:16}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <span style={{...sLabel,margin:0}}>Comprar licencia WLD</span>
              <button onClick={()=>setShowBuyWLD(false)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#e6edf3',fontSize:13,padding:'6px 12px',cursor:'pointer'}}>✕ Cerrar</button>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              {wldNames.map((n,i)=>{
                const locked = i===3 && activeEliteCount>=3
                return <div key={i} onClick={()=>{if(!locked) setSelWLD(i)}} style={{...lCard,border:`1px solid ${selWLD===i?'#fbbf24':'#5b21b6'}`,background:selWLD===i?'rgba(251,191,36,.08)':'#1e0840',boxShadow:selWLD===i?'0 0 12px rgba(251,191,36,.3)':'none',opacity:locked?0.35:1,cursor:locked?'not-allowed':'pointer'}}>
                <div style={{fontSize:11,fontWeight:700}}>{n}{i===3&&<span style={{color:'#34d399'}}> +5%</span>}</div>
                <div style={{fontFamily:'monospace',fontSize:18,fontWeight:700,color:'#34d399'}}>{fmt(Math.round([1,3,5,10][i]*wldHachi*(i===3?1.35:1.3)))}</div>
                <div style={{fontSize:10,color:'#8b949e'}}>HACHI · 3 meses · {i===3?'35%':'30%'}</div>
                <div style={{fontSize:9,color:'#60a5fa',marginTop:4}}>🪙 Acceso a Drachma Miner (nivel {wldNames[i]})</div>
                <div style={{fontSize:9,color:'#a78bfa',marginTop:2}}>{([1,3,5,10][i]*0.5).toFixed(1)} Drachma/día</div>
                <div style={{fontSize:12,fontWeight:700,color:'#fbbf24',marginTop:6}}>{locked?'Ya tenés 1 activa':wldPrices[i]}</div>
              </div>})}
            </div>
            <div style={pBox}>{[['Tipo',wldNames[selWLD]],['Precio',wldPrices[selWLD]],['HACHI base',wldPrev.base],[selWLD===3?'Total ×1.35 (Elite +5%)':'Total ×1.3',wldPrev.total],['HACHI/día',wldPrev.daily],['Mensual',wldPrev.monthly]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace',fontSize:13}}>{v}</span></div>)}</div>
            <button onClick={buyWLD} disabled={!connected||wldHachi>MAX_HACHI||licsAvailNum<=0||(selWLD===3&&activeEliteCount>=3)} style={{...btnP,width:'100%',opacity:(!connected||wldHachi>MAX_HACHI||licsAvailNum<=0||(selWLD===3&&activeEliteCount>=3))?0.4:1}}>{wldHachi>MAX_HACHI?'⚠ Ventas pausadas':licsAvailNum<=0?'Sin stock disponible':(selWLD===3&&activeEliteCount>=3)?'Ya tenés 3 Elite activas (máximo)':`Comprar · ${wldPrices[selWLD]}`}</button>
          </div>}
          {licTab==='sushi'&&<div>
            {!sushiAccess&&<div style={{background:'rgba(248,113,113,.08)',border:'1px solid rgba(248,113,113,.35)',borderRadius:8,padding:20,textAlign:'center',marginBottom:12}}>
              <div style={{fontSize:28,marginBottom:8}}>🔒</div>
              <div style={{fontWeight:700,color:'#f87171',marginBottom:6}}>{t('access_title')}</div>
              <div style={{fontSize:13,color:'#8b949e'}}>{t('access_desc')}</div>
            </div>}
            {sushiAccess&&<>
              <div style={{...sLabel,display:'flex',alignItems:'center',gap:10}}><img src="/hachi-cat-savings.png" alt="" width={88} height={88} style={{borderRadius:14,flexShrink:0,objectFit:'cover',boxShadow:'0 0 18px rgba(124,58,237,.35)'}} />Convertí tus HACHI en Bocado</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
                <div onClick={()=>setSelSUSHI(0)} style={{...lCard,border:`1px solid ${selSUSHI===0?'#fbbf24':'#5b21b6'}`,background:selSUSHI===0?'rgba(251,191,36,.08)':'#1e0840',cursor:'pointer'}}>
                  <div style={{fontSize:11,fontWeight:700}}>{sushiNames[0]}</div>
                  <div style={{fontFamily:'monospace',fontSize:18,fontWeight:700,color:'#34d399'}}>{fmt(Math.round(500*hachiSushi*1.25))}</div>
                  <div style={{fontSize:10,color:'#8b949e'}}>SUSHI inmediato ×1.25</div>
                  <div style={{fontSize:12,fontWeight:700,color:'#fbbf24',marginTop:6}}>{sushiPrices[0]}</div>
                </div>
              </div>
              {(()=>{
                const maxBasicNow2 = wldTierActive===255?0:wldTierActive===0?1:wldTierActive===1?2:wldTierActive===2?3:4
                const disponiblesHoy = Math.max(0, maxBasicNow2 - basicBoughtToday)
                if (disponiblesHoy <= 1) return null
                return <div style={{marginBottom:10}}>
                  <div style={{fontSize:11,color:'#8b949e',marginBottom:4}}>¿Cuántos Bocados querés comprar de una vez? (tenés {disponiblesHoy} disponibles hoy)</div>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    {Array.from({length: disponiblesHoy}, (_, idx) => idx+1).map(n=>
                      <button key={n} onClick={()=>setSushiQty(n)} style={{padding:'6px 14px',borderRadius:8,border:`1px solid ${sushiQty===n?'#fbbf24':'#5b21b6'}`,background:sushiQty===n?'rgba(251,191,36,.15)':'#1e0840',color:'#e6edf3',fontSize:13,fontWeight:700,cursor:'pointer'}}>{n}</button>
                    )}
                  </div>
                </div>
              })()}
              <div style={pBox}>{[['Tipo',sushiNames[selSUSHI]],['Cantidad',sushiQty],['Precio total',`${([500,2000,5000,10000][selSUSHI]*sushiQty).toLocaleString()} HACHI`],['SUSHI base',sushiPrev.base],['Bonus inmediato','+25%'],['Recibís al instante (×1.25, ×'+sushiQty+')',sushiPrev.total]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace',fontSize:13}}>{v}</span></div>)}</div>
              {(()=>{
                const poolEmpty = !(poolsData.poolAFreeNum > 0)
                const maxBasicNow = wldTierActive===255?0:wldTierActive===0?1:wldTierActive===1?2:wldTierActive===2?3:4
                const dailyLimitHit = selSUSHI===0 && (basicBoughtToday + sushiQty) > maxBasicNow
                const disabled = poolEmpty || dailyLimitHit
                const label = poolEmpty ? '⏳ Sin fondos en el pool ahora — probá más tarde' : dailyLimitHit ? '🚫 Supera el límite diario disponible' : sushiQty>1 ? `Comprar ${sushiQty} · ${([500,2000,5000,10000][selSUSHI]*sushiQty).toLocaleString()} HACHI` : `Comprar · ${sushiPrices[selSUSHI]}`
                return <button onClick={buySUSHI} disabled={disabled} style={{...btnG, opacity: disabled?0.5:1, cursor: disabled?'not-allowed':'pointer'}}>{label}</button>
              })()}
              {(()=>{
                const tierLabel = !wldTierLoaded?'Consultando...':wldTierActive===255?'Sin licencia WLD':['Básica','Estándar','Premium','Elite'][wldTierActive]??'—'
                const maxBasic  = wldTierActive===255?0:wldTierActive===0?1:wldTierActive===1?2:wldTierActive===2?3:4
                return (
                  <div style={{background:'rgba(124,58,237,.08)',border:'1px solid #5b21b6',borderRadius:8,padding:12,marginTop:12,fontSize:12}}>
                    <div style={{...row,marginBottom:4}}><span style={{color:'#8b949e'}}>WLD activa</span><span style={{fontWeight:700,color:'#fbbf24'}}>{tierLabel}</span></div>
                    <div style={row}><span style={{color:'#8b949e'}}>Bocados hoy</span><span style={{fontFamily:'monospace',fontWeight:600}}>{basicBoughtToday} / {maxBasic}</span></div>
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
            {[['Total lockeado',lockData.total],['Tier',lockData.tier],['APY anual',lockData.apy]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e'}}>{l}</span><span style={{fontFamily:'monospace',fontWeight:600}}>{v}</span></div>)}
            <div style={{...row,marginTop:2}}>
              <span style={{color:'#8b949e'}}>Próximo cobro en</span>
              {lockData.nextClaimIn==='—'
                ? <span style={{fontFamily:'monospace',fontWeight:700,color:'#3fb950',display:'flex',alignItems:'center',gap:4}}>✓ Listo</span>
                : <span style={{fontFamily:'monospace',fontWeight:700,color:'#fbbf24',textShadow:'0 0 8px rgba(251,191,36,.5)'}}>{lockData.nextClaimIn}</span>
              }
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
            <button onClick={claimAPY} disabled={lockData.nextClaimIn!=='—'} style={{...btnG,opacity:lockData.nextClaimIn!=='—'?0.4:1}}>{lockData.nextClaimIn!=='—'?`Disponible en ${lockData.nextClaimIn}`:'Cobrar APY'}</button>
            <button onClick={doUnstake} style={btnGh}>Retirar HACHI</button>
          </div>
          <div style={sLabel}>Depositar HACHI</div>
          <input value={depositAmt} onChange={e=>setDepositAmt(e.target.value)} type="number" placeholder="Cantidad de HACHI" style={{background:'#12022a',border:'1px solid #5b21b6',borderRadius:8,padding:'10px 12px',fontSize:14,color:'#e6edf3',width:'100%',marginBottom:8,fontFamily:'monospace'}} />
          <div style={{fontSize:11,color:'#d29922',marginBottom:8,lineHeight:1.4}}>⚠ Depositar reinicia el cooldown de 24h para cobrar APY</div>
          <button onClick={doDeposit} style={btnP}>Depositar</button>
          <button onClick={()=>setShowDeposits(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'8px 12px',cursor:'pointer',margin:'8px 0',width:'100%',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span>📦 Mis depósitos ({lockBatches.length})</span>
            <span>{showDeposits?'▲':'▼'}</span>
          </button>
          {showDeposits&&<>
            {lockBatches.length===0?<div style={empty}><div style={{fontSize:28}}>🔒</div><div>Sin depósitos aún</div></div>:lockBatches.map((b,i)=><div key={i} style={{...card,marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontFamily:'monospace',fontSize:16,fontWeight:700,color:'#e6edf3'}}>{b.amount.toLocaleString(undefined,{maximumFractionDigits:4})} HACHI</span>
                {b.ready
                  ? <span style={{color:'#3fb950',fontWeight:700,fontSize:13}}>✓ Disponible</span>
                  : <span style={{color:'#fbbf24',fontWeight:700,fontSize:13}}>⏳ Liberando</span>
                }
              </div>
              {!b.ready&&<div style={{fontSize:12,color:'#8b949e',marginTop:6}}>Se libera el {b.unlocks.toLocaleDateString()} a las {b.unlocks.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>}
            </div>)}
          </>}
          <button onClick={()=>setShowInfoTiers(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'8px 12px',cursor:'pointer',margin:'8px 0',width:'100%'}}>ℹ️ Niveles del Lock — Saber más</button>
          {showInfoTiers&&<div style={{...card,marginTop:0}}>
            <div style={{fontSize:11,color:'#8b949e',marginBottom:10,lineHeight:1.5}}>Con menos de 50,000 HACHI bloqueados (Sin tier) accedés a las licencias Bocado Básicas, pero no generás APY. Desde 50,000 HACHI (Tier 1 — Akira) empezás a ganar rendimiento. Desde 250,000 HACHI además accedés a la Reinversión VIP.</div>
            {[{name:'Akira',min:'50,000',apy:'10%',vip:null},{name:'Zen',min:'200,000',apy:'20%',vip:null},{name:'Koban',min:'500,000',apy:'30%',vip:'8%'},{name:'Tayko',min:'750,000',apy:'40%',vip:'10%'},{name:'Hachi',min:'1,000,000',apy:'50%',vip:'12%'}].map(({name,min,apy,vip})=>{
              const isCurrent = lockData.tier === name
              return <div key={name} style={{padding:'7px 6px',borderRadius:6,marginBottom:2,background:isCurrent?'rgba(52,211,153,.08)':'transparent',border:isCurrent?'1px solid rgba(52,211,153,.3)':'1px solid transparent'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontSize:13,fontWeight:isCurrent?700:400,color:isCurrent?'#34d399':'#8b949e'}}>{isCurrent?'→ ':''}{name}</span>
                  <span style={{fontFamily:'monospace',fontSize:11,color:'#8b949e'}}>{min} HACHI</span>
                  <span style={{fontFamily:'monospace',fontSize:12,fontWeight:600,color:isCurrent?'#fbbf24':'#6b7280'}}>{apy} APY</span>
                </div>
                {vip&&<div style={{fontSize:10,color:'#fbbf24',marginTop:2,textAlign:'right'}}>💎 +{vip} bono en Reinversión VIP</div>}
                {name==='Zen'&&<div style={{fontSize:10,color:'#8b949e',marginTop:2,textAlign:'right'}}>Con 250,000+ (dentro de este nivel): 5% bono en Reinversión VIP</div>}
              </div>
            })}
          </div>}

          <div style={{...card,marginTop:12,border:'1px solid #fbbf24',boxShadow:'0 0 16px rgba(251,191,36,.2)'}}>
            <div style={{...cTitle,display:'flex',alignItems:'center',gap:6}}>💎 Reinversión VIP</div>
            <div style={{background:'rgba(52,211,153,.1)',border:'1px solid rgba(52,211,153,.4)',borderRadius:8,padding:12,marginTop:8,marginBottom:4,fontSize:12,color:'#6ee7b7',lineHeight:1.5,textAlign:'center'}}>
              ✅ <strong>¡Ya disponible!</strong> Por ahora solo podés cambiar tus ganancias por SUSHI (el pool de Drachma todavía no se cargó).
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'#8b949e',marginBottom:8,padding:'0 2px'}}>
              <span>Pool Drachma: <strong style={{color:'#60a5fa'}}>{vipData.drachmaPoolFree.toFixed(0)}</strong></span>
              <span>Pool SUSHI: <strong style={{color:'#a78bfa'}}>{vipData.sushiPoolFree.toFixed(0)}</strong></span>
            </div>
            <button onClick={()=>setShowInfoVip(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'6px 12px',cursor:'pointer',margin:'8px 0',width:'100%'}}>ℹ️ ¿Qué es y cómo funciona?</button>
            {showInfoVip&&<div style={{background:'rgba(251,191,36,.08)',border:'1px solid rgba(251,191,36,.35)',borderRadius:8,padding:14,marginBottom:12,fontSize:12,color:'#fde68a',lineHeight:1.6}}>
              <strong>Es un beneficio exclusivo para holders grandes</strong> — con 250,000+ HACHI lockeados, en vez de vender el HACHI que vas generando por APY, lo cambiás acá directo por Drachma o SUSHI, con un bono extra según tu nivel:
              <br/>• 250,000 - 499,999: <strong>5%</strong> de bono
              <br/>• 500,000 - 749,999: <strong>8%</strong> de bono
              <br/>• 750,000 - 999,999: <strong>10%</strong> de bono
              <br/>• 1,000,000+: <strong>12%</strong> de bono
              <br/><br/>
              El HACHI que vas generando se acumula solo (calculado en vivo desde tu Lock), hasta un tope de <strong>4 semanas</strong> — no se pierde mientras no lo uses, y podés cambiarlo cuando quieras.
              <br/><br/>
              Elegís si preferís recibir Drachma o SUSHI; si ese pool no tiene fondos en ese momento, usa el otro automáticamente. El HACHI que aportás ayuda a financiar licencias WLD para el resto de la comunidad — así tu ganancia sigue generando valor para el sistema, en vez de salir a la venta.
            </div>}
            {!vipData.loaded?<div style={{textAlign:'center',padding:'12px 8px',color:'#8b949e',fontSize:13}}>⏳ Consultando tu Lock...</div>:vipData.level===255?<div style={{textAlign:'center',padding:'12px 8px',color:'#8b949e',fontSize:13}}>🔒 Necesitás al menos 250,000 HACHI lockeados para acceder</div>:<>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Tu nivel</span><span style={{fontFamily:'monospace',fontWeight:700,color:'#fbbf24'}}>{['5% bono','8% bono','10% bono','12% bono'][vipData.level]}</span></div>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>HACHI acumulado</span><span style={{fontFamily:'monospace'}}>{vipData.pendingHachi.toFixed(4)}</span></div>
              {(()=>{
                const drachmaLocked = vipData.drachmaOut > vipData.drachmaPoolFree
                const sushiLocked = vipData.sushiOut > vipData.sushiPoolFree
                return <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,margin:'10px 0'}}>
                  <div onClick={()=>{if(!drachmaLocked) setVipPreferredToken(0)}} style={{...lCard,padding:10,border:`1px solid ${vipPreferredToken===0&&!drachmaLocked?'#fbbf24':'#5b21b6'}`,background:vipPreferredToken===0&&!drachmaLocked?'rgba(251,191,36,.08)':'#1e0840',cursor:drachmaLocked?'not-allowed':'pointer',textAlign:'center',opacity:drachmaLocked?0.4:1}}>
                    <div style={{fontSize:11,color:'#8b949e'}}>Drachma</div>
                    <div style={{fontFamily:'monospace',fontWeight:700,color:'#60a5fa'}}>{vipData.drachmaOut.toFixed(2)}</div>
                    {drachmaLocked&&<div style={{fontSize:9,color:'#f87171',marginTop:2}}>Sin fondos</div>}
                  </div>
                  <div onClick={()=>{if(!sushiLocked) setVipPreferredToken(1)}} style={{...lCard,padding:10,border:`1px solid ${vipPreferredToken===1&&!sushiLocked?'#fbbf24':'#5b21b6'}`,background:vipPreferredToken===1&&!sushiLocked?'rgba(251,191,36,.08)':'#1e0840',cursor:sushiLocked?'not-allowed':'pointer',textAlign:'center',opacity:sushiLocked?0.4:1}}>
                    <div style={{fontSize:11,color:'#8b949e'}}>SUSHI</div>
                    <div style={{fontFamily:'monospace',fontWeight:700,color:'#a78bfa'}}>{vipData.sushiOut.toFixed(2)}</div>
                    {sushiLocked&&<div style={{fontSize:9,color:'#f87171',marginTop:2}}>Sin fondos</div>}
                  </div>
                </div>
              })()}
              <button onClick={exchangeVipAction} disabled={exchangingVip||vipData.pendingHachi<=0} style={{...btnP,width:'100%',opacity:(exchangingVip||vipData.pendingHachi<=0)?0.4:1}}>{exchangingVip?'Cambiando...':vipData.pendingHachi<=0?'Nada acumulado todavía':'Cambiar ahora'}</button>
            </>}
          </div>
        </div>}

        {tab==='ranking'&&<div>
          {lastWinners.length>0&&<div style={{background:'linear-gradient(90deg,#34d399,#10b981)',borderRadius:8,padding:'10px 14px',marginBottom:12,textAlign:'center',boxShadow:'0 0 14px rgba(52,211,153,.4)'}}>
            <div style={{fontSize:13,fontWeight:800,color:'#052e1f'}}>🎉 Ranking ejecutado el {lastExecDate} — {fmt(lastWinners.reduce((s,w)=>s+w.amount,0))} HACHI repartidos entre {lastWinners.length} participantes según su posición</div>
          </div>}
          <div style={card}><div style={cTitle}>Mis estadísticas</div>
            {[['Mis puntos',rankStats.points],['Mi posición',rankStats.pos],['Premio pendiente',rankStats.reward],['Total ganado',rankStats.earned]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e'}}>{l}</span><span style={{fontFamily:'monospace',fontWeight:600}}>{v}</span></div>)}
            <div style={{fontSize:11,color:'#8b949e',marginTop:8}}>Próximo reparto: <span style={{color:'#fbbf24',fontWeight:600}}>{rankStats.nextDist}</span></div>
          </div>
          <button onClick={claimPrize} disabled={rankStats.rewardRaw<=0} style={{...btnGo,opacity:rankStats.rewardRaw<=0?0.4:1,cursor:rankStats.rewardRaw<=0?'not-allowed':'pointer'}}>{rankStats.rewardRaw<=0?'Sin premio pendiente':'Cobrar premio'}</button>
          <div style={{...sLabel,marginTop:12}}>Ranking (cada 15 días)</div>
          {rankList.length===0?<div style={empty}><div style={{fontSize:28}}>🏆</div><div>Sin participantes aún</div></div>:
          <div style={{maxHeight:440,overflowY:'auto',WebkitOverflowScrolling:'touch',paddingRight:2,marginBottom:8}}>
            {rankList.map((e,i)=>{
              const isMe=e.a.toLowerCase()===addr.toLowerCase(),medal=i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`
              return <div key={e.a} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',borderRadius:8,marginBottom:4,background:'#1e0840',border:`1px solid ${isMe?'#34d399':'#5b21b6'}`}}>
                <div style={{fontFamily:'monospace',fontSize:13,fontWeight:700,width:28}}>{medal}</div>
                <div style={{fontFamily:'monospace',fontSize:12,flex:1}}>{nameFor(e.a)}{isMe&&<span style={{color:'#34d399'}}> (tú)</span>}</div>
                <div style={{fontFamily:'monospace',fontSize:12,fontWeight:700,color:'#fbbf24'}}>{fmt(e.pts)}</div>
              </div>
            })}
          </div>
          }
          {lastWinners.length>0&&<div style={card}>
            <div style={cTitle}>🏆 Último reparto ({lastWinners.length} participantes)</div>
            <div style={{maxHeight:440,overflowY:'auto',WebkitOverflowScrolling:'touch',paddingRight:2}}>
              {lastWinners.map(({addr,amount,rank})=>(
                <div key={rank} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid #3b0764'}}>
                  <span style={{fontFamily:'monospace',fontWeight:700,width:28,color:'#fbbf24'}}>{rank===1?'🥇':rank===2?'🥈':rank===3?'🥉':`#${rank}`}</span>
                  <span style={{fontFamily:'monospace',fontSize:12,flex:1,color:'#c9d1d9'}}>{nameFor(addr)}</span>
                  <span style={{fontFamily:'monospace',fontSize:12,fontWeight:600,color:'#34d399'}}>{fmt(amount)} HACHI</span>
                </div>
              ))}
            </div>
          </div>}
          <div style={card}>
            <div style={cTitle}>¿Cómo se suman puntos?</div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:700,color:'#34d399',marginBottom:4,letterSpacing:.5}}>✓ SUMAN PUNTOS</div>
              {[['💰','Cobrar HACHI de licencia WLD'],['bocado','Comprar Bocado'],['🐱','Reclamar recompensa diaria'],['📈','Cobrar APY del Lock'],['👥','Registrar un referido (vos y tu referido)']].map(([icon,text])=><div key={text} style={{display:'flex',alignItems:'flex-start',gap:6,padding:'4px 0',borderBottom:'1px solid #3b0764'}}><span style={{flexShrink:0,fontSize:13,display:'flex',alignItems:'center'}}>{icon==='bocado'?<img src="/hachi-cat-savings.png" width={16} height={16} style={{borderRadius:3,objectFit:'cover'}} />:icon}</span><span style={{fontSize:12,color:'#c9d1d9',lineHeight:1.4}}>{text}</span></div>)}
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:700,color:'#f87171',marginBottom:4,letterSpacing:.5}}>✗ NO SUMAN PUNTOS</div>
              {['Comprar licencia WLD (los puntos llegan al cobrar el HACHI generado)','Depositar en el Lock (los puntos llegan al cobrar el APY)','Retirar del Lock (unstake)'].map(text=><div key={text} style={{display:'flex',alignItems:'flex-start',gap:6,padding:'4px 0',borderBottom:'1px solid #3b0764'}}><span style={{flexShrink:0,fontSize:12,color:'#8b949e'}}>—</span><span style={{fontSize:12,color:'#8b949e',lineHeight:1.4}}>{text}</span></div>)}
            </div>
            <div style={{fontSize:11,color:'#9b96c4',lineHeight:1.5,paddingTop:4}}>Tu multiplicador de tier actual aumenta todos los puntos que ganés. Mientras más HACHI tengas bloqueado en el Lock, más puntos sumás por cada acción.</div>
          </div>
        </div>}

        {tab==='pools'&&<div>
          <div style={card}><div style={cTitle}>Estado del sistema</div>
            {[['Oracle',oracleSt],['1 WLD =',fmt(wldHachi)+' HACHI'],['1 HACHI =',hachiSushi.toFixed(4)+' SUSHI'],['Pool WLD disponible',poolFree],['Licencias WLD disponibles',licsAvail]].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e'}}>{l}</span><span style={{fontFamily:'monospace',fontWeight:600}}>{v}</span></div>)}
          </div>
          <div style={sLabel}>Estado de pools</div>
          <div style={card}><div style={cTitle}>🔒 Lock & APY</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>APY Pool</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.apyPool)} HACHI</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Total lockeado</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.totalLocked)} HACHI</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Usuarios</span><span style={{fontFamily:'monospace'}}>{poolsExtra.lockUsers}</span></div>
          </div>
          <div style={card}><div style={cTitle}>💠 Hachi Miner</div>
            {[['Total',poolsData.wldTotal||'—'],['Reservado',poolsData.wldComm||'—'],['Libre',poolsData.wldFree||'—'],['Total pagado',poolsData.wldPaid||'—'],['Licencias disponibles',poolsData.licsAvail||'—']].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace'}}>{v}</span></div>)}
          </div>
          <div style={card}><div style={cTitle}>🪙 Drachma Miner</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Libre (contrato anterior)</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.drachmaMinerFree)} Drachma</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Libre (contrato actual)</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.drachmaMinerFreeNew)} Drachma</span></div>
          </div>
          <div style={card}><div style={cTitle}>⛏️ WLD Miner</div>
            <div style={{fontSize:11,color:'#8b949e',fontWeight:700,marginTop:2}}>Contrato anterior</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>HACHI libre</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.wldMinerHachiFree)} HACHI</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Drachma libre</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.wldMinerDrachmaFree)} Drachma</span></div>
            <div style={{fontSize:11,color:'#8b949e',fontWeight:700,marginTop:6}}>Contrato actual</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>HACHI libre</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.wldMinerHachiFreeNew)} HACHI</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Drachma libre</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.wldMinerDrachmaFreeNew)} Drachma</span></div>
          </div>
          <div style={card}><div style={{...cTitle,display:'flex',alignItems:'center',gap:6}}><img src="/hachi-cat-savings.png" width={20} height={20} style={{borderRadius:4,objectFit:'cover',flexShrink:0}} />Pool A — Bocado</div>
            {[['Libre',poolsData.poolAF||'—'],['Licencias Bocado disponibles',poolsData.sushiAvail||'—']].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace'}}>{v}</span></div>)}
          </div>
          <div style={card}><div style={cTitle}>🎁 Reward</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Pool SUSHI</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.weeklyBonusPool)} SUSHI</span></div>
          </div>
          <div style={card}><div style={cTitle}>💎 Reinversión VIP</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Pool Drachma</span><span style={{fontFamily:'monospace'}}>{vipData.drachmaPoolFree.toFixed(0)}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Pool SUSHI</span><span style={{fontFamily:'monospace'}}>{vipData.sushiPoolFree.toFixed(0)}</span></div>
          </div>
          <div style={card}><div style={cTitle}>🎁 Reclamo diario</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Pool HACHI</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.dailyHachiPool)} HACHI</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Pool Drachma</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(poolsExtra.dailyBonusPool)} Drachma</span></div>
          </div>
          <div style={card}><div style={cTitle}>📊 Estadísticas</div>
            {[['Licencias WLD vendidas',poolsData.wldLics||'—'],['Licencias Bocado vendidas',poolsData.sushiLics||'—']].map(([l,v])=><div key={l} style={row}><span style={{color:'#8b949e',fontSize:12}}>{l}</span><span style={{fontFamily:'monospace'}}>{v}</span></div>)}
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>🔥 HACHI quemados</span><span style={{fontFamily:'monospace',color:'#f87171',fontWeight:600}}>{poolsData.burned||'—'}</span></div>
          </div>
        </div>}

        {tab==='swap'&&<div>
          <div style={{borderRadius:10,overflow:'hidden',marginBottom:12,border:'1px solid #3b0764',height:300}}>
            <iframe
              src="https://www.geckoterminal.com/world-chain/pools/0xfB461C1EcE675568a1561df75a18d65DDBdc5481?embed=1&info=0&swaps=0&light_chart=0&chart_type=price&resolution=30m"
              title="Gráfico HACHI/WLD"
              frameBorder="0"
              allow="clipboard-write"
              allowFullScreen
              style={{width:'100%',height:'100%'}}
            />
          </div>
          <button onClick={()=>setShowInfoSwap(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'6px 12px',cursor:'pointer',marginBottom:10,width:'100%'}}>ℹ️ ¿Cómo funciona el Swap?</button>
          {showInfoSwap&&<div style={{background:'rgba(167,139,250,.08)',border:'1px solid rgba(167,139,250,.35)',borderRadius:8,padding:14,marginBottom:12,fontSize:12,color:'#c4b5fd',lineHeight:1.6}}>
            El Swap te permite intercambiar HACHI y WLD directo en la app, usando la liquidez real del pool de Uniswap (no un precio inventado).
          </div>}
          {SWAP_MAINTENANCE_MODE&&!debugMode&&<div style={{background:'rgba(251,191,36,.1)',border:'1px solid rgba(251,191,36,.4)',borderRadius:8,padding:16,marginBottom:12,textAlign:'center'}}>
            <div style={{fontSize:28,marginBottom:8}}>🛠️</div>
            <div style={{fontWeight:700,color:'#fbbf24',marginBottom:6}}>Estamos mejorando la experiencia de Swap</div>
            <div style={{fontSize:13,color:'#8b949e'}}>Volvé pronto — estamos terminando de ajustar todo para que ande perfecto.</div>
          </div>}
          {(!SWAP_MAINTENANCE_MODE||debugMode)&&<>
          <div style={sLabel}>Intercambiar HACHI ↔ WLD</div>
          <div style={card}>
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              <button onClick={()=>setSwapDir('w2h')} style={{flex:1,padding:'8px 12px',borderRadius:8,border:`1px solid ${swapDir==='w2h'?'#a78bfa':'#3b0764'}`,background:swapDir==='w2h'?'rgba(167,139,250,.15)':'transparent',color:'#e6edf3',fontSize:13,cursor:'pointer'}}>WLD → HACHI</button>
              <button onClick={()=>setSwapDir('h2w')} style={{flex:1,padding:'8px 12px',borderRadius:8,border:`1px solid ${swapDir==='h2w'?'#a78bfa':'#3b0764'}`,background:swapDir==='h2w'?'rgba(167,139,250,.15)':'transparent',color:'#e6edf3',fontSize:13,cursor:'pointer'}}>HACHI → WLD</button>
            </div>
            <div style={{fontSize:11,color:'#8b949e',marginBottom:4}}>Enviás</div>
            <input value={swapIn} onChange={e=>setSwapIn(e.target.value.replace(/[^0-9.]/g,''))} placeholder="0.0" style={{background:'#12022a',border:'1px solid #5b21b6',borderRadius:8,padding:'10px 12px',fontSize:16,color:'#e6edf3',width:'100%',marginBottom:8,fontFamily:'monospace'}} />
            <div style={{display:'flex',gap:6,marginBottom:12}}>
              {[['25%',0.25],['50%',0.5],['MAX',1]].map(([label,pct])=><button key={label} onClick={()=>{
                const bal = swapDir==='h2w' ? hachiRaw : wldRaw
                setSwapIn((bal*(pct as number)).toFixed(6))
              }} style={{...btnGh,flex:1,padding:'6px 8px',fontSize:12}}>{label}</button>)}
            </div>
            <div style={{fontSize:11,color:'#8b949e',marginBottom:4}}>Recibís (estimado)</div>
            <div style={{...pBox,marginBottom:12}}>
              <span style={{fontFamily:'monospace',fontSize:16,color:'#3fb950'}}>{swapQuote} {swapDir==='h2w'?'WLD':'HACHI'}</span>
            </div>
            <div style={{fontSize:10,color:'#8b949e',marginBottom:12,lineHeight:1.5}}>Liquidez real de Uniswap · Fee de pool 0.3% + fee de app 0.05% · Tolerancia a slippage 1%</div>
            <button onClick={doSwap} disabled={!connected||swapLoading||!swapIn||Number(swapIn)<=0} style={{...btnP,width:'100%',opacity:(!connected||swapLoading||!swapIn||Number(swapIn)<=0)?0.4:1}}>{swapLoading?'Intercambiando...':'Intercambiar'}</button>
          </div>
          <div style={{background:'linear-gradient(90deg,#f59e0b,#d97706)',borderRadius:8,padding:'14px',marginTop:12,marginBottom:12,textAlign:'center',boxShadow:'0 0 14px rgba(245,158,11,.4)'}}>
            <div style={{fontSize:14,fontWeight:800,color:'#451a03'}}>🏁 Campaña de racha y ranking finalizada</div>
            <div style={{fontSize:12,color:'#451a03',marginTop:4}}>¡Gracias a todos los que participaron! Seguimos construyendo juntos.</div>
          </div>
          <div style={sLabel}>Tu historial</div>
          {swapHistory.length===0?<div style={empty}><div style={{fontSize:28}}>🔄</div><div>Sin intercambios todavía</div></div>:(swapHistoryExpanded?swapHistory:swapHistory.slice(0,5)).map((h,i)=>{
            const inName = h.tokenIn.toLowerCase()===C.hachi.toLowerCase() ? 'HACHI' : 'WLD'
            const outName = h.tokenOut.toLowerCase()===C.hachi.toLowerCase() ? 'HACHI' : 'WLD'
            return <a key={h.hash+i} href={`https://worldscan.org/tx/${h.hash}`} target="_blank" rel="noopener noreferrer" style={{textDecoration:'none'}}>
              <div style={{...card,marginBottom:6,padding:'8px 12px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                <span style={{fontSize:12,color:'#e6edf3',fontWeight:600,whiteSpace:'nowrap'}}>{inName}→{outName}</span>
                <span style={{fontSize:11,fontFamily:'monospace',color:'#8b949e',flex:1,textAlign:'center'}}>{fmtPrecise(fe(h.amountIn))} → <span style={{color:'#3fb950'}}>{fmtPrecise(fe(h.amountOut))}</span></span>
                <span style={{color:'#a78bfa',fontSize:14}}>↗</span>
              </div>
            </a>
          })}
          {!swapHistoryExpanded&&swapHistory.length>5&&<button onClick={()=>setSwapHistoryExpanded(true)} style={{...btnGh,width:'100%',marginTop:4}}>Ver más ({swapHistory.length-5})</button>}
          </>}
        </div>}

        {tab==='estado'&&<div>
          <div style={sLabel}>📊 Mi Estado</div>
          {myStatus.loading&&<div style={{fontSize:11,color:'#8b949e',fontStyle:'italic',marginBottom:8}}>Cargando tus datos...</div>}
          <div style={card}><div style={cTitle}>📜 Licencias</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Licencias WLD activas</span><span style={{fontFamily:'monospace',fontWeight:600}}>{wldLics.length}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Acceso a Bocado hasta</span><span style={{fontFamily:'monospace',fontWeight:600,color:'#34d399'}}>{activeEliteCount>0?sushiNames[3]:wldLics.some(({l}:any)=>Number(l[1])>=2&&l[10])?sushiNames[2]:wldLics.some(({l}:any)=>Number(l[1])>=1&&l[10])?sushiNames[1]:wldLics.length>0?sushiNames[0]:'—'}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Licencias Bocado compradas</span><span style={{fontFamily:'monospace',fontWeight:600}}>{myStatus.bocadoCount}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Bocado especial</span><span style={{fontFamily:'monospace',color:myStatus.specialAvail?'#3fb950':'#8b949e'}}>{myStatus.specialAvail?'Disponible ahora':`en ${Math.max(0,Math.ceil((myStatus.lastSpecial+5*86400-Date.now()/1000)/86400))} días`}</span></div>
          </div>
          <div style={card}><div style={cTitle}>🔒 Lock & APY</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Total lockeado</span><span style={{fontFamily:'monospace',fontWeight:600}}>{lockData.total} HACHI</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Tier actual</span><span style={{fontFamily:'monospace',color:'#34d399'}}>{lockData.tier}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>APY</span><span style={{fontFamily:'monospace'}}>{lockData.apy}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Pendiente de cobrar</span><span style={{fontFamily:'monospace',color:'#3fb950'}}>{lockData.pending} HACHI</span></div>
          </div>
          <div style={card}><div style={cTitle}>🎁 Disponible para reclamar (cada 24hs)</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Base</span><span style={{fontFamily:'monospace'}}>5 HACHI</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>+ Lock activo</span><span style={{fontFamily:'monospace'}}>{lockData.total!=='0'?'+20 HACHI':'0 (sin lock activo)'}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>+ Licencia WLD activa</span><span style={{fontFamily:'monospace'}}>{wldLics.length>0?'+20 HACHI':'0 (sin licencia activa)'}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Total HACHI ahora</span><span style={{fontFamily:'monospace',fontWeight:700,color:'#3fb950'}}>{fmt(piggy.accrued)}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Drachma (0.5 por WLD invertido/licencia)</span><span style={{fontFamily:'monospace',fontWeight:700,color:'#60a5fa'}}>{piggy.bonus.toFixed(2)}</span></div>
          </div>
          <div style={card}><div style={cTitle}>🏆 Ranking (premios cada 15 días)</div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Mis puntos</span><span style={{fontFamily:'monospace',fontWeight:600}}>{rankStats.points}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Mi posición</span><span style={{fontFamily:'monospace'}}>{rankStats.pos}</span></div>
            <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Total ganado histórico</span><span style={{fontFamily:'monospace',color:'#3fb950'}}>{rankStats.earned}</span></div>
          </div>
        </div>}

        {tab==='drachmaminer'&&<div>
          <div style={sLabel}>🪙 Drachma Miner</div>
          {drachmaMiner.activeMineId===0 && drachmaMiner.contractAddr===DRACHMA_MINER_ADDR_OLD && <div style={{background:'linear-gradient(135deg,#fbbf24,#f59e0b)',borderRadius:10,padding:14,marginBottom:12,textAlign:'center',boxShadow:'0 0 16px rgba(251,191,36,.5)'}}>
            <div style={{fontSize:14,fontWeight:800,color:'#1e0840'}}>🎁 ¡Conseguí tu primera minería Drachma y ganá 10,000 SUSHI!</div>
            <div style={{fontSize:11,color:'#1e0840',marginTop:4,lineHeight:1.4}}>Solo por tiempo limitado, hasta agotar el pool. El bono se paga de forma manual los días <strong>5 y 10 de agosto</strong>.</div>
          </div>}
          <div style={{fontSize:10,color:'#8b949e',marginBottom:8,textAlign:'right'}}>Pool disponible: {fmtPrecise(drachmaMiner.poolFree)} Drachma</div>
          <div style={{fontSize:11,color:'#8b949e',textAlign:'center',marginBottom:8}}>Minerías activas ahora: <strong style={{color:'#34d399'}}>{drachmaActiveCount.real}</strong> de {drachmaActiveCount.total} creadas en total</div>
          <button onClick={()=>setShowInfoDrachma(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'6px 12px',cursor:'pointer',marginBottom:10,width:'100%'}}>ℹ️ ¿Cómo funciona el Drachma Miner?</button>
          {showInfoDrachma&&<div style={{background:'rgba(167,139,250,.08)',border:'1px solid rgba(167,139,250,.35)',borderRadius:8,padding:14,marginBottom:12,fontSize:12,color:'#c4b5fd',lineHeight:1.6}}>
            Con una licencia WLD activa o un Lock de al menos 50,000 HACHI, podés "minar" Drachma: elegís un nivel (según tu tier más alto) y pagás HACHI por un monto fijo de Drachma, con un descuento sobre el precio real de mercado.
            <br/><br/>
            El Drachma no llega de golpe — se genera de a poco durante {drachmaMiner.durationDays} días, y lo vas reclamando cuando quieras con el botón "Reclamar Drachma".
            <br/><br/>
            Solo podés tener <strong>1 minería activa a la vez</strong> — cuando termine de generarse del todo, podés arrancar una nueva.
          </div>}
          <button onClick={()=>setShowDrachmaHistory(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'6px 12px',cursor:'pointer',marginBottom:10,width:'100%'}}>📜 Minerías terminadas</button>
          {showDrachmaHistory&&<div style={{background:'rgba(52,211,153,.08)',border:'1px solid rgba(52,211,153,.35)',borderRadius:8,padding:14,marginBottom:12,fontSize:12,color:'#c9d1d9',lineHeight:1.6}}>
            {drachmaMinerHistory.filter(h=>h.done).length===0?<div style={{textAlign:'center',color:'#8b949e'}}>Todavía no tenés ninguna minería terminada.</div>:drachmaMinerHistory.filter(h=>h.done).map(h=>(
              <div key={h.contrato+h.id} style={{padding:'6px 0',borderBottom:'1px solid #3b0764'}}>
                <div style={{display:'flex',justifyContent:'space-between'}}><span>✓ Mina #{h.id} ({h.contrato})</span></div>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'#8b949e'}}><span>Pagaste</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(h.hachiPaid)} HACHI</span></div>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:11}}><span style={{color:'#8b949e'}}>Recibiste</span><span style={{fontFamily:'monospace',color:'#3fb950'}}>{fmtPrecise(h.drachmaTotal)} Drachma</span></div>
              </div>
            ))}
          </div>}
          {!drachmaMiner.loaded?<div style={empty}><div style={{fontSize:28}}>⏳</div><div>Consultando tu licencia y Lock...</div></div>:drachmaMiner.tier===255?<div style={empty}><div style={{fontSize:28}}>🔒</div><div>Necesitás una licencia WLD o Lock activo para acceder</div></div>:<>
            <div style={card}>
              <div style={cTitle}>Tu tier: {['Básica','Estándar','Premium','Elite'][drachmaMiner.tier]}</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12,marginTop:8}}>
                {['Básica','Estándar','Premium','Elite'].map((n,i)=>{
                  const locked = i > drachmaMiner.tier
                  return <div key={i} onClick={()=>{if(!locked) setSelDrachmaTier(i)}} style={{...lCard,border:`1px solid ${selDrachmaTier===i?'#fbbf24':'#5b21b6'}`,background:selDrachmaTier===i?'rgba(251,191,36,.08)':'#1e0840',opacity:locked?0.35:1,cursor:locked?'not-allowed':'pointer'}}>
                    <div style={{fontSize:11,fontWeight:700}}>{n}</div>
                    <div style={{fontFamily:'monospace',fontSize:16,fontWeight:700,color:'#60a5fa'}}>{fmtPrecise(drachmaMiner.amounts[i])} Drachma</div>
                    <div style={{fontSize:10,color:'#8b949e'}}>Costo: {fmtPrecise(drachmaMiner.costs[i])} HACHI</div>
                  </div>
                })}
              </div>
              <div style={{background:'rgba(52,211,153,.1)',border:'1px solid rgba(52,211,153,.4)',borderRadius:8,padding:10,marginBottom:10,textAlign:'center',fontSize:12,color:'#6ee7b7',fontWeight:700}}>
                🟢 <strong>7 días</strong> de duración durante todo agosto (promo del mes)
              </div>
              {(()=>{
                const nowSecsDm = Math.floor(Date.now()/1000)
                const drachmaReallyActive = drachmaMiner.active && (nowSecsDm < drachmaMiner.endTime || drachmaMiner.pending > 0.01)
                return <>
                  <div style={{fontSize:11,color:'#3fb950',textAlign:'center',marginBottom:6,fontWeight:600}}>🎁 Ganás un {((drachmaMiner.discountBps/(10000-drachmaMiner.discountBps))*100).toFixed(1)}% extra respecto al valor de mercado (descuento del {(drachmaMiner.discountBps/100).toFixed(0)}%)</div>
                  <button onClick={mineDrachmaAction} disabled={!connected||drachmaReallyActive} style={{...btnP,width:'100%',opacity:(!connected||drachmaReallyActive)?0.4:1}}>{drachmaReallyActive?'Ya tenés una mina activa':`Pagás ${fmtPrecise(drachmaMiner.costs[selDrachmaTier])} HACHI → recibís ${fmtPrecise(drachmaMiner.amounts[selDrachmaTier])} Drachma`}</button>
                </>
              })()}
            </div>
            {drachmaMiner.active&&(Math.floor(Date.now()/1000)<drachmaMiner.endTime||drachmaMiner.pending>0.01)&&<div style={{...card,marginTop:12}}>
              <div style={cTitle}>Tu minería activa</div>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Total</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(drachmaMiner.drachmaTotal)} Drachma</span></div>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Ya reclamado</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(drachmaMiner.drachmaClaimed)} Drachma</span></div>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Pendiente ahora</span><span style={{fontFamily:'monospace',color:'#3fb950'}}>{fmtPrecise(drachmaMiner.pending)} Drachma</span></div>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Termina</span><span style={{fontFamily:'monospace'}}>{new Date(drachmaMiner.endTime*1000).toLocaleDateString()}</span></div>
              <button onClick={claimDrachmaMineAction} disabled={drachmaMiner.pending<=0} style={{...btnG,width:'100%',marginTop:8,opacity:drachmaMiner.pending>0?1:0.4}}>Reclamar Drachma</button>
            </div>}
          </>}
        </div>}

        {tab==='weeklybonus'&&<div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
            <span style={sLabel}>🎁 Reward</span>
            <span style={{fontSize:10,color:'#8b949e'}}>Pool: {fmtPrecise(weeklyBonus.poolFree)} SUSHI</span>
          </div>
          <button onClick={()=>setShowInfoWeekly(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'6px 12px',cursor:'pointer',marginBottom:10,width:'100%'}}>ℹ️ ¿Qué es esto?</button>
          {showInfoWeekly&&<div style={{background:'rgba(167,139,250,.08)',border:'1px solid rgba(167,139,250,.35)',borderRadius:8,padding:14,marginBottom:12,fontSize:12,color:'#c4b5fd',lineHeight:1.6}}>
            Cada 7 días, si tenés licencias WLD o una minería de Drachma activa, se te va preparando un <strong>regalo sorpresa</strong> — un extra esporádico de agradecimiento, no algo garantizado por sistema.
            <br/><br/>
            No vas a ver el monto acumulándose — solo vas a saber que tenés un regalo esperando cuando esté listo para abrir. Una vez que lo abrís, tenés 3 días de gracia para reclamarlo antes de que vuelva al pool.
          </div>}
          <div style={{...card,textAlign:'center',padding:'32px 16px'}}>
            {(()=>{
              const listo = weeklyBonus.secondsUntilNext<=0 && weeklyBonus.pending>0
              const bloqueado = !listo
              if (bloqueado) {
                const d = Math.floor(weeklyBonus.secondsUntilNext/86400), h = Math.floor((weeklyBonus.secondsUntilNext%86400)/3600)
                return <>
                  <div style={{fontSize:64,marginBottom:12,filter:'grayscale(0.4) opacity(0.6)'}}>🎁</div>
                  <div style={{fontSize:14,color:'#8b949e',marginBottom:6}}>Tu próximo regalo se está preparando</div>
                  {weeklyBonus.dailyRate<=0
                    ? <div style={{fontSize:12,color:'#f87171',lineHeight:1.5}}>Necesitás una licencia WLD activa o una minería de Drachma activa para empezar a generar tu regalo.</div>
                    : <div style={{fontSize:13,color:'#fbbf24',fontWeight:700}}>{weeklyBonus.everClaimed ? `Listo en ${d}d ${h}h` : 'Ya podés reclamar tu primer regalo'}</div>}
                  {!weeklyBonus.everClaimed && weeklyBonus.dailyRate>0 && <button onClick={claimWeeklyBonus} disabled={claimingWeekly} style={{...btnP,width:'100%',marginTop:16,opacity:claimingWeekly?0.4:1}}>{claimingWeekly?'Abriendo...':'🎁 Abrir mi primer regalo'}</button>}
                </>
              }
              if (listo && !giftOpened) {
                return <>
                  <div onClick={()=>setGiftOpened(true)} style={{fontSize:72,marginBottom:12,cursor:'pointer',animation:'giftBounce 1.2s ease-in-out infinite'}}>🎁</div>
                  <div style={{fontSize:15,fontWeight:800,color:'#fbbf24',marginBottom:6}}>¡Tenés un regalo esperando!</div>
                  <div style={{fontSize:12,color:'#8b949e'}}>Tocá el regalo para abrirlo</div>
                  <style>{`@keyframes giftBounce { 0%,100%{transform:translateY(0) rotate(-3deg);} 50%{transform:translateY(-10px) rotate(3deg);} }`}</style>
                </>
              }
              return <>
                <div style={{fontSize:56,marginBottom:12}}>🎉</div>
                <div style={{fontSize:16,fontWeight:800,color:'#3fb950',marginBottom:4}}>¡Felicidades!</div>
                <div style={{fontSize:14,color:'#e6edf3',marginBottom:16}}>Ganaste <strong style={{color:'#fbbf24'}}>{weeklyBonus.pending.toFixed(2)} SUSHI</strong></div>
                <button onClick={async()=>{await claimWeeklyBonus(); setGiftOpened(false)}} disabled={claimingWeekly} style={{...btnP,width:'100%',opacity:claimingWeekly?0.4:1}}>{claimingWeekly?'Reclamando...':'Reclamar'}</button>
                <div style={{fontSize:11,color:'#8b949e',marginTop:12}}>Gracias por usar Hachi Miner 🐱</div>
              </>
            })()}
          </div>
        </div>}

        {tab==='voting'&&<div>
          <div style={sLabel}>🗳️ Votación — Partido Hachi en World Republic</div>
          <div style={card}>
            {(()=>{
              const open = isVotingOpen()
              const secs = open ? 0 : secondsUntilNextVoting()
              const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600)
              return <div style={{textAlign:'center',marginBottom:14}}>
                <div style={{fontSize:15,fontWeight:800,color:open?'#3fb950':'#e6edf3',marginBottom:6}}>{open?'✓ Votación abierta ahora mismo':'⏳ Próxima votación'}</div>
                {!open&&<div style={{fontSize:13,color:'#8b949e'}}>Faltan <strong style={{color:'#fbbf24'}}>{d}d {h}h</strong></div>}
              </div>
            })()}
            <div style={{background:'rgba(124,58,237,.08)',border:'1px solid #5b21b6',borderRadius:8,padding:14,marginBottom:14,fontSize:13,color:'#c4b5fd',lineHeight:1.6}}>
              🎁 <strong>10,000 SUSHI</strong> a repartir entre quienes voten por el Partido Hachi, y <strong>5,000 SUSHI</strong> entre quienes reaccionen a HACHI en DexScreener.
              <br/><br/>
              ⚠️ Solo se acepta el <strong>link</strong> que te da la propia plataforma al tocar "Compartir" — es el único válido. Las capturas de pantalla <strong>no</strong> se aceptan. Mandanos tu link por WhatsApp para que quede registrado.
            </div>
            <div style={{fontSize:12,color:'#8b949e',marginBottom:14,lineHeight:1.6}}>
              La votación se abre todas las semanas, de <strong>jueves 20:00</strong> a <strong>domingo 19:59</strong> (hora de Chile / GMT-4). El enlace funciona siempre — cuando entrás fuera de ese horario, vas a ver la página del partido pero sin el botón de votar habilitado todavía.
            </div>
            <a href="https://www.worldrepublic.org/es/govern/parties/1f9bc8d0-9ae5-46fe-b6e1-0282cb782c41?ref=GEFSRZRZ" target="_blank" rel="noopener noreferrer" style={{display:'block',textAlign:'center',background:'linear-gradient(135deg,#7c3aed,#a78bfa)',color:'#fff',fontSize:14,fontWeight:700,padding:'12px 20px',borderRadius:10,textDecoration:'none',boxShadow:'0 0 16px rgba(124,58,237,.4)'}}>Ir al Partido Hachi →</a>
          </div>
        </div>}

        {tab==='wldminer'&&<div>
          <div style={{marginBottom:8}}>
            <span style={sLabel}>⛏️ WLD Miner</span>
          </div>
          <div style={{display:'flex',justifyContent:'center',gap:16,marginBottom:10,fontSize:13,fontWeight:700}}>
            <span style={{color:'#34d399'}}>🟢 Activas {wldActiveCount.real}</span>
            <span style={{color:'#f87171'}}>🔴 Terminadas {wldActiveCount.total - wldActiveCount.real}</span>
          </div>
          <button onClick={()=>setShowInfoWldMiner(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'6px 12px',cursor:'pointer',marginBottom:10,width:'100%'}}>ℹ️ ¿Cómo funciona?</button>
          {showInfoWldMiner&&<div style={{background:'rgba(167,139,250,.08)',border:'1px solid rgba(167,139,250,.35)',borderRadius:8,padding:14,marginBottom:12,fontSize:12,color:'#c4b5fd',lineHeight:1.6}}>
            Pagás WLD y recibís HACHI + Drachma combinados (70%/30%), generados de a poco durante el plazo que elijas. Cuanto más largo el plazo, mayor el retorno.
            <br/><br/>
            El tope de WLD que podés invertir depende de tu licencia WLD o Lock (el que sea más alto). Solo podés tener <strong>1 minería activa a la vez</strong>.
          </div>}
          {!wldMiner.loaded?<div style={empty}><div style={{fontSize:28}}>⏳</div><div>Consultando tu licencia y Lock...</div></div>:wldMiner.tier===255?<div style={empty}><div style={{fontSize:28}}>🔒</div><div>Necesitás una licencia WLD o Lock activo para acceder</div></div>:<>
            {(()=>{
              const CUTOFF_TS = 1785281858
              const startTimeAviso = wldMiner.endTime - (wldMiner.variant===2?604800:wldMiner.variant===1?1296000:2592000)
              const posibleAfectado = wldMiner.active && wldMiner.variant===2 && startTimeAviso < CUTOFF_TS
              return posibleAfectado ? <div style={{background:'rgba(251,191,36,.1)',border:'1px solid rgba(251,191,36,.4)',borderRadius:8,padding:12,marginBottom:12,fontSize:12,color:'#fde68a',lineHeight:1.6}}>
                ⚠️ <strong>Aviso importante:</strong> detectamos que tu minería activa se creó antes del 28/07, cuando un error visual en esta pantalla podía hacer que el sistema registrara una duración distinta a la que veías seleccionada (por ejemplo, elegir "30 días" y que quedara grabado como "7 días"). Ya está corregido. Si creés que tu duración no coincide con la que elegiste, escribinos y lo revisamos con los datos reales de la blockchain.
              </div> : null
            })()}
            {(()=>{
              const nowSecsWld = Math.floor(Date.now()/1000)
              const wldReallyActive = wldMiner.active && (nowSecsWld < wldMiner.endTime || wldMiner.pendingHachi > 0.01 || wldMiner.pendingDrachma > 0.01)

              return <>
                {wldReallyActive && <div style={card}>
                  <div style={cTitle}>Tu minería activa</div>
                  <div style={row}><span style={{color:'#8b949e',fontSize:12}}>HACHI total / reclamado</span><span style={{fontFamily:'monospace'}}>{wldMiner.hachiTotal.toFixed(2)} / <span style={{color:'#3fb950'}}>{wldMiner.hachiClaimed.toFixed(2)}</span></span></div>
                  <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Drachma total / reclamado</span><span style={{fontFamily:'monospace'}}>{wldMiner.drachmaTotal.toFixed(2)} / <span style={{color:'#3fb950'}}>{wldMiner.drachmaClaimed.toFixed(2)}</span></span></div>
                  <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Liberados HACHI</span><span style={{fontFamily:'monospace',color:'#3fb950'}}>{wldMiner.pendingHachi.toFixed(2)}</span></div>
                  <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Liberados Drachma</span><span style={{fontFamily:'monospace',color:'#60a5fa'}}>{wldMiner.pendingDrachma.toFixed(2)}</span></div>
                  {(()=>{
                    const durDias = wldMinerVariants[wldMiner.variant]?.days || 0
                    const startTime = wldMiner.endTime - durDias*86400
                    const nowSecs = Math.floor(Date.now()/1000)
                    const diasRestantes = Math.max(0, Math.ceil((wldMiner.endTime - nowSecs) / 86400))
                    return <>
                      <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Fecha de inicio</span><span style={{fontFamily:'monospace'}}>{new Date(startTime*1000).toLocaleDateString()}</span></div>
                      <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Fecha de término</span><span style={{fontFamily:'monospace'}}>{new Date(wldMiner.endTime*1000).toLocaleDateString()}</span></div>
                      <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Duración</span><span style={{fontFamily:'monospace'}}>{durDias} días</span></div>
                      <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Te quedan</span><span style={{fontFamily:'monospace',color:diasRestantes<=0?'#3fb950':'#fbbf24',fontWeight:700}}>{diasRestantes<=0?'Terminada — reclamá el saldo':`${diasRestantes} días minando`}</span></div>
                    </>
                  })()}
                  <button onClick={claimWldMinerAction} disabled={claimingWldMiner||(wldMiner.pendingHachi<=0&&wldMiner.pendingDrachma<=0)} style={{...btnG,width:'100%',marginTop:8,opacity:(wldMiner.pendingHachi>0||wldMiner.pendingDrachma>0)?1:0.4}}>{claimingWldMiner?'Reclamando...':'Reclamar'}</button>
                </div>}

                <button onClick={()=>setShowWldHistory(v=>!v)} style={{background:'none',border:'1px solid #5b21b6',borderRadius:8,color:'#a78bfa',fontSize:12,padding:'6px 12px',cursor:'pointer',marginTop:12,marginBottom:10,width:'100%'}}>📜 Minerías terminadas</button>
                {showWldHistory&&<div style={{background:'rgba(52,211,153,.08)',border:'1px solid rgba(52,211,153,.35)',borderRadius:8,padding:14,marginBottom:12,fontSize:12,color:'#c9d1d9',lineHeight:1.6}}>
                  {wldMinerHistory.filter(h=>h.done).length===0?<div style={{textAlign:'center',color:'#8b949e'}}>Todavía no tenés ninguna minería terminada.</div>:wldMinerHistory.filter(h=>h.done).map(h=>(
                    <div key={h.contrato+h.id} style={{padding:'6px 0',borderBottom:'1px solid #3b0764'}}>
                      <div style={{display:'flex',justifyContent:'space-between'}}><span>✓ Mina #{h.id} ({h.contrato})</span></div>
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'#8b949e'}}><span>Pagaste</span><span style={{fontFamily:'monospace'}}>{fmtPrecise(h.wldPaid)} WLD</span></div>
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:11}}><span style={{color:'#8b949e'}}>Recibiste</span><span style={{fontFamily:'monospace',color:'#3fb950'}}>{fmtPrecise(h.hachiTotal)} HACHI + {fmtPrecise(h.drachmaTotal)} Drachma</span></div>
                    </div>
                  ))}
                </div>}

                {!wldReallyActive && <div style={card}>
                  <div style={{fontSize:12,color:'#8b949e',marginBottom:8}}>Tu tope máximo: <strong style={{color:'#fbbf24'}}>{wldMiner.cap.toFixed(2)} WLD</strong></div>
                  <div style={{background:'rgba(248,113,113,.1)',border:'1px solid rgba(248,113,113,.4)',borderRadius:8,padding:'8px 10px',marginBottom:10,fontSize:11,color:'#f87171',fontWeight:600,textAlign:'center'}}>⚠️ Solo podés tener 1 minería activa a la vez</div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:10}}>
                    {wldMinerVariants.map(({days,pct},i)=>[`${days} días`, `${pct}%`]).map(([d,r],i)=>
                      <div key={i} onClick={()=>{setSelWldVariant(i); previewWldMine(i)}} style={{...lCard,padding:8,border:`1px solid ${selWldVariant===i?'#fbbf24':'#5b21b6'}`,background:selWldVariant===i?'rgba(251,191,36,.08)':'#1e0840',cursor:'pointer'}}>
                        <div style={{fontSize:11,fontWeight:700}}>{d}</div>
                        <div style={{fontSize:14,fontWeight:700,color:'#34d399'}}>{r}</div>
                      </div>
                    )}
                  </div>
                  <input type="number" value={selWldAmount} onChange={e=>setSelWldAmount(e.target.value)} onBlur={()=>previewWldMine()} placeholder="Cantidad de WLD" style={{width:'100%',padding:10,borderRadius:8,border:'1px solid #5b21b6',background:'#1e0840',color:'#e6edf3',fontSize:14,marginBottom:10}} />
                  {(wldMinerPreview.hachi>0||wldMinerPreview.drachma>0)&&<div style={{...pBox,marginBottom:10}}>
                    <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Recibirías (HACHI)</span><span style={{fontFamily:'monospace',color:'#3fb950'}}>{fmtPrecise(wldMinerPreview.hachi)}</span></div>
                    <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Recibirías (Drachma)</span><span style={{fontFamily:'monospace',color:'#60a5fa'}}>{fmtPrecise(wldMinerPreview.drachma)}</span></div>
                  </div>}
                  <button onClick={mineWldAction} disabled={!connected||miningWld} style={{...btnP,width:'100%',opacity:(!connected||miningWld)?0.4:1}}>{miningWld?'Minando...':'Minar'}</button>
                </div>}

                <div style={{fontSize:10,color:'#8b949e',textAlign:'center',marginTop:12}}>Pools: {wldMiner.poolFreeHachi.toFixed(2)} HACHI / {wldMiner.poolFreeDrachma.toFixed(2)} Drachma</div>
              </>
            })()}
          </>}
        </div>}

        {tab==='mineria'&&<div>
          <div style={sLabel}>⛏️ Minería</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8,marginBottom:12}}>
            {[
              {icon:'📜',label:'Hachi Miner',action:()=>{setLicTab('wld'); loadTab('lics')},iconImg:'/hachi-logo.png'},
              {icon:'🍡',label:'Bocado',action:()=>{setLicTab('sushi'); loadTab('lics')},iconImg:'/hachi-cat-savings.png'},
              {icon:'🪙',label:'Drachma Miner',action:()=>loadTab('drachmaminer'),iconImg:'https://assets.geckoterminal.com/0gp3m01cu8d61jd4n9nmhkvn5auh'},
              {icon:'⛏️',label:'WLD Miner',action:()=>loadTab('wldminer')},
              {icon:'🎁',label:'Reward',action:()=>loadTab('weeklybonus')},
            ].map(btn=><button key={btn.label} onClick={btn.action} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4,padding:'16px 8px',borderRadius:12,border:'1px solid #5b21b6',background:'linear-gradient(135deg,#2d1b69,#1e0840)',color:'#e6edf3',cursor:'pointer'}}>
              {(btn as any).iconImg ? <img src={(btn as any).iconImg} alt="" width={26} height={26} style={{borderRadius:13,objectFit:'cover'}} /> : <span style={{fontSize:26}}>{btn.icon}</span>}
              <span style={{fontSize:12,fontWeight:600}}>{btn.label}</span>
            </button>)}
          </div>
        </div>}

        {tab==='centrohachi'&&<div>
          <div style={sLabel}>🎯 Centro Hachi</div>
          <div style={{fontSize:11,color:'#8b949e',textAlign:'center',marginBottom:12,lineHeight:1.5}}>
            Todo lo que tenés disponible para reclamar o usar, en un solo lugar.
          </div>
          {(()=>{
            const wldLicsPendTotal = wldLics.reduce((acc,l)=>acc+Number(fe(l.pend||BigInt(0))),0)
            const maxBasicCH = wldTierActive===255?0:wldTierActive===0?1:wldTierActive===1?2:wldTierActive===2?3:4
            const bocadoDisponible = Math.max(0, maxBasicCH - basicBoughtToday)
            const lockPendNum = parseFloat(lockData.pending) || 0

            const fmtSecsCH = (s:number) => { const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600); return d>0?`${d}d ${h}h`:`${h}h` }
            const nowSecsCH = Math.floor(Date.now()/1000)
            const msUntilMidnightUTC = new Date().setUTCHours(24,0,0,0) - Date.now()
            const bocadoResetIn = fmtSecsCH(Math.floor(msUntilMidnightUTC/1000))

            const items = [
              { key:'wldlics', iconImg:'/hachi-logo.png', label:'Hachi Miner (Licencias WLD)', valor: wldLicsPendTotal>0.01 ? `${fmtPrecise(wldLicsPendTotal)} HACHI` : null, pendiente: 'Sin nada acumulado todavía', disponibleAhora:true, tieneInversion: wldLics.length>0, claimFn: claimAllWLD },
              { key:'drachma', iconImg:'https://assets.geckoterminal.com/0gp3m01cu8d61jd4n9nmhkvn5auh', label:'Drachma Miner', valor: drachmaMiner.pending>0.01 ? `${drachmaMiner.pending.toFixed(2)} Drachma` : null, pendiente: 'Sin nada acumulado todavía', disponibleAhora:true, tieneInversion: drachmaMiner.tier!==255, claimFn: claimDrachmaMineAction },
              { key:'wldminer', icon:'⛏️', label:'WLD Miner', valor: (wldMiner.pendingHachi>0.01||wldMiner.pendingDrachma>0.01) ? `${wldMiner.pendingHachi.toFixed(2)} HACHI + ${wldMiner.pendingDrachma.toFixed(2)} Drachma` : null, pendiente: 'Sin nada acumulado todavía', disponibleAhora:true, tieneInversion: wldMiner.tier!==255, claimFn: claimWldMinerAction },
              { key:'lock', icon:'🔒', label:'Lock (APY)', valor: lockPendNum>0.01 ? `${lockData.pending} HACHI` : null, pendiente: lockData.nextClaimIn!=='—' ? `Disponible en ${lockData.nextClaimIn}` : 'Sin nada acumulado todavía', disponibleAhora: lockData.nextClaimIn==='—', tieneInversion: parseFloat(lockData.total)>0, claimFn: claimAPY },
              { key:'diario', icon:'🐱', label:'Claim diario', valor: piggy.canWithdraw && piggy.accrued>0 ? `${fmtPrecise(piggy.accrued)} HACHI` : null, pendiente: !piggy.canWithdraw ? `Disponible en ${Math.ceil(piggy.secondsUntilNext/3600)}h` : 'Sin nada acumulado todavía', disponibleAhora: piggy.canWithdraw, tieneInversion: true, claimFn: withdrawDaily },
              { key:'bocado', iconImg:'/hachi-cat-savings.png', label:'Bocado disponible hoy', valor: bocadoDisponible>0 ? `${bocadoDisponible} disponible${bocadoDisponible>1?'s':''}` : null, pendiente: `Se resetea en ${bocadoResetIn}`, disponibleAhora:false, tieneInversion: wldTierActive!==255, action:()=>{setLicTab('sushi'); loadTab('lics')} },
              { key:'reinversion', icon:'💎', label:'Reinversión VIP', valor: vipData.pendingHachi>0.01 ? `${vipData.pendingHachi.toFixed(2)} HACHI acumulado` : null, pendiente: 'Sin nada acumulado todavía', disponibleAhora:true, tieneInversion: vipData.level!==255, action:()=>loadTab('lock') },
              { key:'semanal', icon:'🎁', label:'Reward', valor: weeklyBonus.pending>0.01 ? `${fmtPrecise(weeklyBonus.pending)} SUSHI` : null, pendiente: weeklyBonus.secondsUntilNext>0 ? `Disponible en ${fmtSecsCH(weeklyBonus.secondsUntilNext)}` : 'Sin nada acumulado todavía', disponibleAhora: weeklyBonus.secondsUntilNext<=0, tieneInversion: weeklyBonus.dailyRate>0, claimFn: claimWeeklyBonus },
            ]

            return <>
              {items.map(i=>{
                const tieneAlgo = !!i.valor
                const puedeReclamarYa = tieneAlgo && (i as any).disponibleAhora
                const colorBoton = puedeReclamarYa ? '#3fb950' : (i as any).tieneInversion ? '#fbbf24' : '#f87171'
                return <div key={i.key} style={{...card,display:'flex',justifyContent:'space-between',alignItems:'center',padding:'16px 14px',marginBottom:12,gap:10}}>
                  <div style={{display:'flex',alignItems:'center',gap:12,flex:'1 1 auto',minWidth:0}}>
                    {(i as any).iconImg ? <img src={(i as any).iconImg} alt="" width={28} height={28} style={{borderRadius:14,objectFit:'cover',flexShrink:0}} /> : <span style={{fontSize:28,flexShrink:0}}>{(i as any).icon}</span>}
                    <div style={{minWidth:0}}>
                      <div style={{fontSize:13,color:'#8b949e',marginBottom:3}}>{i.label}</div>
                      <div style={{fontSize:15,fontWeight:700,color:'#e6edf3'}}>{(i as any).disponibleAhora ? (i.valor || i.pendiente) : i.pendiente}</div>
                    </div>
                  </div>
                  <button onClick={()=> (i as any).claimFn ? ((i as any).disponibleAhora && (i as any).claimFn()) : (i as any).action()} disabled={!(i as any).action && !((i as any).disponibleAhora)} style={{flex:'0 0 auto',width:64,padding:'6px 4px',fontSize:10,fontWeight:700,borderRadius:8,border:`1px solid ${colorBoton}`,background:colorBoton,color:'#1e0840',cursor:(!(i as any).action && !((i as any).disponibleAhora))?'not-allowed':'pointer',opacity:(!(i as any).action && !((i as any).disponibleAhora))?0.6:1}}>{(i as any).claimFn?'Reclamar':'Ir'}</button>
                </div>
              })}
            </>
          })()}
        </div>}

        {tab==='refs'&&<div>
          <div style={card}><div style={cTitle}>Mi código de referido</div>
            <div style={{color:'#8b949e',fontSize:12,marginBottom:8}}>{addr?'✓ Tu código está listo para compartir':'Conecta tu wallet para ver tu código'}</div>
            {(()=>{const isRealUsername = (n?: string) => !!n && !n.startsWith('UserVerif '); const cachedName = usernameCache[addr.toLowerCase()]; const refPart = isRealUsername(username) ? ('u:'+encodeURIComponent(username)) : isRealUsername(cachedName) ? ('u:'+encodeURIComponent(cachedName)) : ('a:'+addr); const link=`https://world.org/mini-app?app_id=${APP_ID}&path=${encodeURIComponent('/?ref='+refPart)}`;return(<button onClick={async()=>{
    if (MiniKit.isInstalled()) {
      try {
        await MiniKit.share({ title: 'HachiMiner', text: 'Sumate a HachiMiner conmigo', url: link })
        return
      } catch (e) {}
    }
    if(navigator.share){try{await navigator.share({title:'HachiMiner',url:link})}catch{await navigator.clipboard.writeText(link);toast_('Link copiado','#3fb950')}}else{await navigator.clipboard.writeText(link);toast_('Link copiado','#3fb950')}
  }} style={{...btnGh,marginTop:8}}>Compartir mi link de invitación</button>)})()}
            <div style={pBox}>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>Mis referidos</span><span style={{fontFamily:'monospace',fontWeight:600}}>{refInfo.totalRefs}</span></div>
              <div style={row}><span style={{color:'#8b949e',fontSize:12}}>HACHI ganado</span><span style={{color:'#3fb950',fontFamily:'monospace'}}>{refInfo.earned}</span></div>
              <div style={{fontSize:11,color:'#8b949e',marginTop:8,lineHeight:1.5}}>✓ Ya está en tu wallet — se paga automáticamente cuando alguien se registra con tu link, sin necesidad de cobrar.</div>
            </div>
          </div>
          {refInfo.referrer?
            <div style={card}><div style={cTitle}>Ya tenés referidor</div>
              <div style={{fontFamily:'monospace',fontSize:12,wordBreak:'break-all',color:'#a78bfa'}}>{nameFor(refInfo.referrer)}</div>
            </div>
          : refFromLink ?
            <>
              <div style={sLabel}>Registrar referido</div>
              <div style={card}>
                <div style={{fontSize:12,color:'#8b949e',marginBottom:8}}>Te invitó: <span style={{fontFamily:'monospace',color:'#a78bfa',fontWeight:600}}>{nameFor(refFromLink)}</span></div>
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
