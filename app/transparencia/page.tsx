'use client'

import { useEffect, useState } from 'react'
import { ethers } from 'ethers'

const RPC = 'https://worldchain-mainnet.g.alchemy.com/public'

// Bloque de corte: todo lo ANTERIOR a este bloque queda cubierto por los
// números manuales de abajo (cargados a mano). De este bloque en
// adelante, todo se escanea en vivo automático.
const CUTOFF_BLOCK = 32749931

// --- Base manual: comprado/cargado HASTA HOY, a valor de WLD ---
const MANUAL_WLD_EN_SWAP = 170
const MANUAL_DRACHMA_TOTAL = 20_000 + 11_000 // Drachma Miner + WLD Miner
const MANUAL_SUSHI_TOTAL = 3_000_000

const WLD = '0x2cfc85d8e48f8eab294be644d9e25c3030863003'

const ORACLE = '0x0e18Ff0A2b9981D2FF50658aD4960d17c9b7C22b'
const POOL_WLD_DRACHMA = '0xaaEF72194E42aF8f641e90c3e48a7F01e9547097'

const HACHI_SWAP = '0x1EfCb70A4AE0dfa7D2242a43573A6B103776DC73'
const DRACHMA_MINER = '0x19d23871C64F29e22F31AcC094A255e5B1aAD577'
const WLD_MINER = '0x35C82EC1C5414b228eF39b65fAC545409fc92d75'
const CORE = '0xE1892183A27389c6a4CACc091F62F9412B7EA6b9'
const OWNER = '0xbD5BD64Fb835066E9c9327EBb16a0807Cd089f58'

const Q96 = BigInt('79228162514264337593543950336')

async function scanEvents(contract: ethers.Contract, filter: any, fromBlock: number, toBlock: number) {
  if (toBlock < fromBlock) return []
  const CHUNK = 100, BATCH = 15
  let events: any[] = []
  let to = toBlock
  while (to >= fromBlock) {
    const ranges: [number, number][] = []
    let cursor = to
    for (let j = 0; j < BATCH && cursor >= fromBlock; j++) {
      const from = Math.max(fromBlock, cursor - CHUNK + 1)
      ranges.push([from, cursor])
      cursor = from - 1
    }
    const results = await Promise.all(ranges.map(([f, t]) => contract.queryFilter(filter, f, t).catch(() => [])))
    for (const evs of results) events = events.concat(evs)
    to = cursor
  }
  return events
}

function fe(x: bigint) { return Number(ethers.formatEther(x)) }

export default function Transparencia() {
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState('Iniciando...')
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    const run = async () => {
      try {
        const provider = new ethers.JsonRpcProvider(RPC)

        setProgress('Leyendo precios actuales...')
        const oracle = new ethers.Contract(ORACLE, [
          'function wldToSushi(uint256) view returns (uint256)',
        ], provider)
        const sushiPerWld = await oracle.wldToSushi(ethers.parseEther('1'))

        const drachmaPool = new ethers.Contract(POOL_WLD_DRACHMA, [
          'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
          'function token0() view returns (address)',
        ], provider)
        const [slot0, token0] = await Promise.all([drachmaPool.slot0(), drachmaPool.token0()])
        const sqrtScaled = (slot0[0] * BigInt(1e9)) / Q96
        const TEN_36 = BigInt('1000000000000000000000000000000000000')
        let drachmaPerWld = sqrtScaled * sqrtScaled
        if (token0.toLowerCase() !== WLD.toLowerCase()) drachmaPerWld = TEN_36 / (sqrtScaled * sqrtScaled)

        const drachmaPerWldNum = fe(drachmaPerWld)
        const sushiPerWldNum = fe(sushiPerWld)

        setProgress('Leyendo WLD recaudado...')
        const core = new ethers.Contract(CORE, [
          'function totalWldToOwner() view returns (uint256)',
        ], provider)
        const wldRecaudado = fe(await core.totalWldToOwner())

        const currentBlock = await provider.getBlockNumber()

        setProgress('Escaneando actividad reciente...')
        const swapC = new ethers.Contract(HACHI_SWAP, [
          'event Swapped(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount)',
        ], provider)
        const dmC = new ethers.Contract(DRACHMA_MINER, [
          'event PoolFunded(uint256 amount, uint256 newTotal)',
        ], provider)
        const wmC = new ethers.Contract(WLD_MINER, [
          'event PoolFunded(string token, uint256 amount, uint256 newTotal)',
        ], provider)
        const coreEventsC = new ethers.Contract(CORE, [
          'event PoolFunded(uint8 pool, uint256 amount, uint256 newTotal)',
        ], provider)

        const [swapEvents, dmEvents, wmEvents, poolAEvents] = await Promise.all([
          scanEvents(swapC, swapC.filters.Swapped(OWNER), CUTOFF_BLOCK, currentBlock),
          scanEvents(dmC, dmC.filters.PoolFunded(), CUTOFF_BLOCK, currentBlock),
          scanEvents(wmC, wmC.filters.PoolFunded(), CUTOFF_BLOCK, currentBlock),
          scanEvents(coreEventsC, coreEventsC.filters.PoolFunded(), CUTOFF_BLOCK, currentBlock),
        ])

        let wldEnSwapNuevo = 0
        for (const e of swapEvents as any[]) {
          if (e.args.tokenIn.toLowerCase() === WLD.toLowerCase()) wldEnSwapNuevo += fe(e.args.amountIn)
        }

        let drachmaNuevo = 0
        for (const e of dmEvents as any[]) drachmaNuevo += fe(e.args.amount)
        for (const e of wmEvents as any[]) {
          if (e.args.token === 'DRACHMA') drachmaNuevo += fe(e.args.amount)
        }

        let sushiNuevo = 0
        for (const e of poolAEvents as any[]) {
          if (Number(e.args.pool) === 1) sushiNuevo += fe(e.args.amount)
        }

        const wldEnSwap = MANUAL_WLD_EN_SWAP + wldEnSwapNuevo
        const drachmaTotal = MANUAL_DRACHMA_TOTAL + drachmaNuevo
        const sushiTotal = MANUAL_SUSHI_TOTAL + sushiNuevo

        const drachmaWldEquiv = drachmaTotal / drachmaPerWldNum
        const sushiWldEquiv = sushiTotal / sushiPerWldNum

        const totalCompradoWld = wldEnSwap + drachmaWldEquiv + sushiWldEquiv

        setData({
          wldRecaudado,
          wldEnSwap,
          drachmaTotal,
          drachmaWldEquiv,
          sushiTotal,
          sushiWldEquiv,
          totalCompradoWld,
        })
        setLoading(false)
      } catch (e: any) {
        setProgress('Error: ' + (e?.message || 'desconocido'))
      }
    }
    run()
  }, [])

  const fmt = (n: number) => n.toLocaleString('es-CL', { maximumFractionDigits: 2 })

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg,#2a1f63 0%,#1d1a52 55%,#2b2c78 100%)', color: '#e6edf3', fontFamily: 'Georgia,serif', padding: '24px 16px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: '#fbbf24', textAlign: 'center', marginBottom: 4 }}>📊 Transparencia HachiMiner</h1>
        <p style={{ fontSize: 13, color: '#8b949e', textAlign: 'center', marginBottom: 24 }}>Valor recaudado, comprado, y en circulación en el sistema</p>

        {loading && <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>{progress}</div>}

        {!loading && data && <>
          {/* SECCIÓN 1: Recaudado vs Comprado */}
          <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3', marginBottom: 10 }}>💰 Recaudado vs. Comprado</div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 20, marginBottom: 12, textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#8b949e', marginBottom: 4 }}>WLD recaudado (venta de licencias)</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#fbbf24' }}>{fmt(data.wldRecaudado)} WLD</div>
          </div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 20, marginBottom: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#8b949e', marginBottom: 4 }}>Total comprado (HACHI + Drachma + SUSHI, a valor de hoy)</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#3fb950' }}>{fmt(data.totalCompradoWld)} WLD</div>
          </div>

          {/* SECCIÓN 2: Detalle de todo lo que entra al sistema */}
          <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3', marginBottom: 10 }}>📦 Todo lo que entra al sistema</div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 16, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#8b949e' }}>🔄 HACHI (vía Swap)</span>
              <span style={{ fontFamily: 'monospace', color: '#3fb950' }}>{fmt(data.wldEnSwap)} WLD</span>
            </div>
          </div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 16, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#8b949e' }}>🪙 Drachma</span>
              <span style={{ fontFamily: 'monospace', color: '#60a5fa' }}>{fmt(data.drachmaTotal)} Drachma</span>
            </div>
            <div style={{ textAlign: 'right', fontSize: 11, color: '#8b949e', marginTop: 2 }}>≈ {fmt(data.drachmaWldEquiv)} WLD</div>
          </div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 16, marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#8b949e' }}>🍣 SUSHI</span>
              <span style={{ fontFamily: 'monospace', color: '#a78bfa' }}>{fmt(data.sushiTotal)} SUSHI</span>
            </div>
            <div style={{ textAlign: 'right', fontSize: 11, color: '#8b949e', marginTop: 2 }}>≈ {fmt(data.sushiWldEquiv)} WLD</div>
          </div>

          <p style={{ fontSize: 11, color: '#8b949e', textAlign: 'center', lineHeight: 1.6 }}>
            Cada valor incluye una base cargada a mano (lo comprado hasta hoy) + todo lo escaneado en vivo desde el bloque {CUTOFF_BLOCK.toLocaleString()} en adelante.
          </p>
        </>}
      </div>
    </div>
  )
}
