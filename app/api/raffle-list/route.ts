import { NextResponse } from "next/server";
import { getStore } from "@netlify/blobs";
import { ethers } from "ethers";

const RPC = "https://worldchain-mainnet.g.alchemy.com/public";
const DRACHMA_MINER_OLD = "0x19d23871C64F29e22F31AcC094A255e5B1aAD577";
const DRACHMA_MINER_NEW = "0xF34a0C6F3C55Bb3b8E489E0c66779331FFc72eA4";
const WLD_MINER_OLD = "0x35C82EC1C5414b228eF39b65fAC545409fc92d75";
const WLD_MINER_NEW = "0x2C191913eBdA9b2bb61E3d00Ca5d35b6991F4B9A";
const CORE = "0xE1892183A27389c6a4CACc091F62F9412B7EA6b9";
const RAFFLE_BASELINE = 290;

const DM_ABI = [
  "function mineId() view returns (uint256)",
  "function mines(uint256) view returns (address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
];
const WM_ABI = [
  "function mineId() view returns (uint256)",
  "function mines(uint256) view returns (address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
];
const CORE_ABI = [
  "function wldLicId() view returns (uint256)",
  "function wldLics(uint256) view returns (address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)",
];

type Entry = { owner: string; startTime: number };
type CacheData = {
  entries: Entry[];
  counts: { dOld: number; dNew: number; wOld: number; wNew: number; lics: number };
};

async function fetchNewEntries(
  contract: ethers.Contract,
  fromId: number,
  toId: number,
  kind: "drachma" | "wldminer" | "lics"
): Promise<Entry[]> {
  const out: Entry[] = [];
  const BATCH = 10;
  for (let i = fromId; i <= toId; i += BATCH) {
    const ids: number[] = [];
    for (let j = i; j <= Math.min(i + BATCH - 1, toId); j++) ids.push(j);
    const calls = ids.map((id) =>
      kind === "lics" ? contract.wldLics(id) : contract.mines(id)
    );
    const results = await Promise.all(calls);
    for (const r of results) {
      const owner = (r[0] as string).toLowerCase();
      const startTime = kind === "wldminer" ? Number(r[7]) : Number(r[6]);
      out.push({ owner, startTime });
    }
  }
  return out;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address")?.toLowerCase() || null;

  const store = getStore("raffle-list-cache");
  const cachedRaw = await store.get("data", { type: "json" }).catch(() => null);
  const cached: CacheData = (cachedRaw as CacheData) || {
    entries: [],
    counts: { dOld: 0, dNew: 0, wOld: 0, wNew: 0, lics: 0 },
  };

  const provider = new ethers.JsonRpcProvider(RPC);
  const dmOld = new ethers.Contract(DRACHMA_MINER_OLD, DM_ABI, provider);
  const dmNew = new ethers.Contract(DRACHMA_MINER_NEW, DM_ABI, provider);
  const wmOld = new ethers.Contract(WLD_MINER_OLD, WM_ABI, provider);
  const wmNew = new ethers.Contract(WLD_MINER_NEW, WM_ABI, provider);
  const core = new ethers.Contract(CORE, CORE_ABI, provider);

  const [dOld, dNew, wOld, wNew, lics] = await Promise.all([
    dmOld.mineId(),
    dmNew.mineId(),
    wmOld.mineId(),
    wmNew.mineId(),
    core.wldLicId(),
  ]);
  const current = {
    dOld: Number(dOld),
    dNew: Number(dNew),
    wOld: Number(wOld),
    wNew: Number(wNew),
    lics: Number(lics),
  };

  const newEntries: Entry[] = [];
  if (current.dOld > cached.counts.dOld) {
    newEntries.push(...(await fetchNewEntries(dmOld, cached.counts.dOld + 1, current.dOld, "drachma")));
  }
  if (current.dNew > cached.counts.dNew) {
    newEntries.push(...(await fetchNewEntries(dmNew, cached.counts.dNew + 1, current.dNew, "drachma")));
  }
  if (current.wOld > cached.counts.wOld) {
    newEntries.push(...(await fetchNewEntries(wmOld, cached.counts.wOld + 1, current.wOld, "wldminer")));
  }
  if (current.wNew > cached.counts.wNew) {
    newEntries.push(...(await fetchNewEntries(wmNew, cached.counts.wNew + 1, current.wNew, "wldminer")));
  }
  if (current.lics > cached.counts.lics) {
    newEntries.push(...(await fetchNewEntries(core, cached.counts.lics, current.lics - 1, "lics")));
  }

  let entries = cached.entries;
  if (newEntries.length > 0) {
    entries = [...cached.entries, ...newEntries].sort((a, b) => a.startTime - b.startTime);
    await store.setJSON("data", { entries, counts: current });
  }

  const total = Math.max(0, entries.length - RAFFLE_BASELINE);

  const participants = entries
    .map((e, i) => ({ numero: i + 1 - RAFFLE_BASELINE, owner: e.owner }))
    .filter((p) => p.numero > 0);

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (address) {
    const myNumbers = participants.filter((p) => p.owner === address).map((p) => p.numero);
    return NextResponse.json({ total, myNumbers, participants }, { headers: corsHeaders });
  }

  return NextResponse.json({ total, participants }, { headers: corsHeaders });
}

export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
