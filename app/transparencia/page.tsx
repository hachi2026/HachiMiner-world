'use client'

import { useEffect, useState } from 'react'
import { ethers } from 'ethers'

const RPC = 'https://worldchain-mainnet.g.alchemy.com/public'

// Bloque de corte: todo lo ANTERIOR a este bloque queda cubierto por los
// números manuales de abajo. De este bloque en adelante, lo que entra
// al sistema (SUSHI y Drachma) se escanea en vivo automático.
const CUTOFF_BLOCK = 32749931

// --- Invertido: WLD gastado por categoría, hasta hoy (manual) ---
const INVERTIDO_HACHI_WLD = 170
const INVERTIDO_DRACHMA_WLD = 200
const INVERTIDO_SUSHI_WLD = 120

// --- Entrado al sistema: tokens en circulación, hasta hoy (manual) ---
const MANUAL_DRACHMA_TOTAL = 31_000
const MANUAL_SUSHI_TOTAL = 3_000_000

const WLD = '0x2cfc85d8e48f8eab294be644d9e25c3030863003'

const ORACLE = '0x0e18Ff0A2b9981D2FF50658aD4960d17c9b7C22b'
const POOL_WLD_DRACHMA = '0xaaEF72194E42aF8f641e90c3e48a7F01e9547097'

const DRACHMA_MINER = '0x19d23871C64F29e22F31AcC094A255e5B1aAD577'
const WLD_MINER = '0x35C82EC1C5414b228eF39b65fAC545409fc92d75'
const CORE = '0xE1892183A27389c6a4CACc091F62F9412B7EA6b9'
const WLD_MINER_DEPLOY_BLOCK = 32678677

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

        const currentBlock = await provider.getBlockNumber()

        setProgress('Escaneando actividad reciente...')
        const dmC = new ethers.Contract(DRACHMA_MINER, [
          'event PoolFunded(uint256 amount, uint256 newTotal)',
        ], provider)
        const wmC = new ethers.Contract(WLD_MINER, [
          'event PoolFunded(string token, uint256 amount, uint256 newTotal)',
        ], provider)
        const coreEventsC = new ethers.Contract(CORE, [
          'event PoolFunded(uint8 pool, uint256 amount, uint256 newTotal)',
        ], provider)

        const [dmEvents, wmEvents, poolAEvents] = await Promise.all([
          scanEvents(dmC, dmC.filters.PoolFunded(), CUTOFF_BLOCK, currentBlock),
          scanEvents(wmC, wmC.filters.PoolFunded(), CUTOFF_BLOCK, currentBlock),
          scanEvents(coreEventsC, coreEventsC.filters.PoolFunded(), CUTOFF_BLOCK, currentBlock),
        ])

        let drachmaNuevo = 0
        for (const e of dmEvents as any[]) drachmaNuevo += fe(e.args.amount)
        for (const e of wmEvents as any[]) {
          if (e.args.token === 'DRACHMA') drachmaNuevo += fe(e.args.amount)
        }

        let sushiNuevo = 0
        for (const e of poolAEvents as any[]) {
          if (Number(e.args.pool) === 1) sushiNuevo += fe(e.args.amount)
        }

        const drachmaTotal = MANUAL_DRACHMA_TOTAL + drachmaNuevo
        const sushiTotal = MANUAL_SUSHI_TOTAL + sushiNuevo
        const drachmaWldEquiv = drachmaTotal / drachmaPerWldNum
        const sushiWldEquiv = sushiTotal / sushiPerWldNum

        const wmMinedC = new ethers.Contract(WLD_MINER, [
          'event Mined(address indexed user, uint8 variant, uint256 wldIn, uint256 hachiTotal, uint256 drachmaTotal, uint256 indexed id)',
        ], provider)
        const coreC = new ethers.Contract(CORE, [
          'function totalWldToOwner() view returns (uint256)',
        ], provider)

        const [minedEvents, wldLicencias] = await Promise.all([
          scanEvents(wmMinedC, wmMinedC.filters.Mined(), WLD_MINER_DEPLOY_BLOCK, currentBlock),
          coreC.totalWldToOwner(),
        ])

        let wldViaMiner = 0
        for (const e of minedEvents as any[]) wldViaMiner += fe(e.args.wldIn)

        const wldLicenciasNum = fe(wldLicencias)
        const totalRecaudado = wldLicenciasNum + wldViaMiner

        const totalInvertido = INVERTIDO_HACHI_WLD + INVERTIDO_DRACHMA_WLD + INVERTIDO_SUSHI_WLD
        const reserva = totalRecaudado - totalInvertido

        setData({
          wldLicenciasNum,
          wldViaMiner,
          totalRecaudado,
          reserva,
          totalInvertido,
          drachmaTotal,
          sushiTotal,
          drachmaWldEquiv,
          sushiWldEquiv,
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
        <p style={{ fontSize: 13, color: '#8b949e', textAlign: 'center', marginBottom: 24 }}>Cuánto se invirtió, y cuánto entró al sistema</p>

        {loading && <div style={{ textAlign: 'center', padding: 40, color: '#8b949e' }}>{progress}</div>}

        {!loading && data && <>
          {/* SECCIÓN 0: Recaudado y Reserva (lo más importante) */}
          <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3', marginBottom: 10 }}>🏦 Recaudado y Reserva</div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 16, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#8b949e' }}>📜 Licencias WLD</span>
              <span style={{ fontFamily: 'monospace', color: '#fbbf24' }}>{fmt(data.wldLicenciasNum)} WLD</span>
            </div>
          </div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 16, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#8b949e' }}>⛏️ WLD Miner</span>
              <span style={{ fontFamily: 'monospace', color: '#fbbf24' }}>{fmt(data.wldViaMiner)} WLD</span>
            </div>
          </div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 20, marginBottom: 12, textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#8b949e', marginBottom: 4 }}>Total recaudado</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#fbbf24' }}>{fmt(data.totalRecaudado)} WLD</div>
          </div>
          <div style={{ background: 'linear-gradient(135deg,#7c3aed,#a78bfa)', borderRadius: 12, padding: 20, marginBottom: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#f3e8ff', marginBottom: 4 }}>Reserva (recaudado − invertido)</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#fff' }}>{fmt(data.reserva)} WLD</div>
          </div>

          {/* SECCIÓN 1: Invertido */}
          <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3', marginBottom: 10 }}>💰 Invertido (WLD gastado)</div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 16, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#8b949e' }}>🔄 En HACHI</span>
              <span style={{ fontFamily: 'monospace', color: '#3fb950' }}>{fmt(INVERTIDO_HACHI_WLD)} WLD</span>
            </div>
          </div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 16, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#8b949e' }}>🪙 En Drachma</span>
              <span style={{ fontFamily: 'monospace', color: '#60a5fa' }}>{fmt(INVERTIDO_DRACHMA_WLD)} WLD</span>
            </div>
          </div>
          <div style={{ background: '#240a45', border: '1px solid #5b21b6', borderRadius: 12, padding: 16, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#8b949e' }}>🍣 En SUSHI</span>
              <span style={{ fontFamily: 'monospace', color: '#a78bfa' }}>{fmt(INVERTIDO_SUSHI_WLD)} WLD</span>
            </div>
          </div>
          <div style={{ background: 'linear-gradient(135deg,#7c3aed,#a78bfa)', borderRadius: 12, padding: 16, marginBottom: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#f3e8ff', marginBottom: 4 }}>Total invertido</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#fff' }}>{fmt(data.totalInvertido)} WLD</div>
          </div>

          {/* SECCIÓN 2: Entrado al sistema */}
          <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3', marginBottom: 10 }}>📦 Entrado al sistema</div>
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
            "Entrado al sistema" incluye una base cargada a mano (hasta hoy) + todo lo escaneado en vivo desde el bloque {CUTOFF_BLOCK.toLocaleString()} en adelante. El HACHI del propio wallet se sumará en una próxima mejora.
          </p>
        </>}
      </div>
    </div>
  )
}
