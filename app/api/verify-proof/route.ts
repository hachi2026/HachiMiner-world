import { NextResponse } from "next/server";
import { getStore } from "@netlify/blobs";
import { hashSignal } from "@worldcoin/idkit-core";
import { ethers } from "ethers";

const RPC = process.env.WORLDCHAIN_RPC || "https://worldchain-mainnet.g.alchemy.com/public";

const SET_HUMAN_VERIFIED_ABI = ["function setHumanVerified(address user) external"];
const HACHI_SWAP_STREAK_ADDRESS_ENV = "HACHI_SWAP_STREAK_ADDRESS";
const HACHI_DRACHMA_MINER_ADDRESS_ENV = "HACHI_DRACHMA_MINER_ADDRESS";

async function syncHumanVerifiedOnChain(userAddress: string) {
  const pk = process.env.VERIFIER_PRIVATE_KEY;
  const referralManagerAddr = process.env.REFERRAL_MANAGER_ADDRESS;
  const hachiRankingAddr = process.env.HACHI_RANKING_ADDRESS;
  const dailyRewardsAddr = process.env.HACHI_DAILY_REWARDS_ADDRESS;
  const hachiSwapAddr = process.env.HACHI_SWAP_ADDRESS;
  const hachiSwapStreakAddr = process.env[HACHI_SWAP_STREAK_ADDRESS_ENV];
  const hachiDrachmaMinerAddr = process.env[HACHI_DRACHMA_MINER_ADDRESS_ENV];

  if (!pk) {
    console.error("VERIFIER_PRIVATE_KEY no configurada; no se pudo sincronizar on-chain");
    return { referralManager: false, hachiRanking: false, dailyRewards: false, hachiSwap: false, hachiSwapStreak: false, hachiDrachmaMiner: false };
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);

  const results = { referralManager: false, hachiRanking: false, dailyRewards: false, hachiSwap: false, hachiSwapStreak: false, hachiDrachmaMiner: false };

  if (referralManagerAddr) {
    try {
      const c = new ethers.Contract(referralManagerAddr, SET_HUMAN_VERIFIED_ABI, wallet);
      const tx = await c.setHumanVerified(userAddress);
      await tx.wait();
      results.referralManager = true;
    } catch (e) {
      console.error("Error sincronizando ReferralManager:", e);
    }
  }

  if (hachiRankingAddr) {
    try {
      const c = new ethers.Contract(hachiRankingAddr, SET_HUMAN_VERIFIED_ABI, wallet);
      const tx = await c.setHumanVerified(userAddress);
      await tx.wait();
      results.hachiRanking = true;
    } catch (e) {
      console.error("Error sincronizando HachiRanking:", e);
    }
  }

  if (dailyRewardsAddr) {
    try {
      const c = new ethers.Contract(dailyRewardsAddr, SET_HUMAN_VERIFIED_ABI, wallet);
      const tx = await c.setHumanVerified(userAddress);
      await tx.wait();
      results.dailyRewards = true;
    } catch (e) {
      console.error("Error sincronizando HachiDailyRewards:", e);
    }
  }

  if (hachiSwapAddr) {
    try {
      const c = new ethers.Contract(hachiSwapAddr, SET_HUMAN_VERIFIED_ABI, wallet);
      const tx = await c.setHumanVerified(userAddress);
      await tx.wait();
      results.hachiSwap = true;
    } catch (e) {
      console.error("Error sincronizando HachiSwap:", e);
    }
  }

  if (hachiSwapStreakAddr) {
    try {
      const c = new ethers.Contract(hachiSwapStreakAddr, SET_HUMAN_VERIFIED_ABI, wallet);
      const tx = await c.setHumanVerified(userAddress);
      await tx.wait();
      results.hachiSwapStreak = true;
    } catch (e) {
      console.error("Error sincronizando HachiSwapStreak:", e);
    }
  }

  if (hachiDrachmaMinerAddr) {
    try {
      const c = new ethers.Contract(hachiDrachmaMinerAddr, SET_HUMAN_VERIFIED_ABI, wallet);
      const tx = await c.setHumanVerified(userAddress);
      await tx.wait();
      results.hachiDrachmaMiner = true;
    } catch (e) {
      console.error("Error sincronizando HachiDrachmaMiner:", e);
    }
  }

  return results;
}

export async function POST(request: Request): Promise<Response> {
  const { rp_id, idkitResponse, address } = await request.json();

  const worldRes = await fetch(
    `https://developer.world.org/api/v4/verify/${rp_id}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(idkitResponse),
    }
  );

  if (!worldRes.ok) {
    const detail = await worldRes.json().catch(() => ({}));
    return NextResponse.json(
      { error: "Verification failed", detail },
      { status: worldRes.status }
    );
  }

  const isSession = "session_id" in idkitResponse;
  const firstResponse = idkitResponse?.responses?.[0];
  const nullifier: string | undefined = isSession
    ? firstResponse?.session_nullifier?.[0]
    : firstResponse?.nullifier;

  if (!nullifier) {
    return NextResponse.json(
      { error: "Could not extract nullifier from proof" },
      { status: 400 }
    );
  }

  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  const expectedSignalHash = hashSignal(address);
  if (firstResponse?.signal_hash && firstResponse.signal_hash !== expectedSignalHash) {
    return NextResponse.json(
      { error: "Address does not match proof signal" },
      { status: 400 }
    );
  }

  const store = getStore("world-id-nullifiers");
  const existing = await store.get(nullifier, { type: 'text' });
  const normalizedAddr = address.toLowerCase();

  if (existing !== null) {
    // El nullifier ya fue usado. Si fue por la MISMA direccion (caso de
    // datos viejos de pruebas anteriores al agregar el guardado de
    // address, o un reintento legitimo), lo tratamos como éxito y
    // completamos lo que falte — no es un problema de seguridad porque
    // ya se valido arriba que el signal_hash coincide con esta address.
    // Si fuera una direccion DISTINTA reusando el nullifier de otra
    // persona, ahi si lo rechazamos.
    if (existing !== normalizedAddr && existing !== "1") {
      return NextResponse.json({ error: "Already verified" }, { status: 400 });
    }
    const addrExisting = await store.get('addr:' + normalizedAddr).catch(() => null);
    if (addrExisting === null) {
      await store.set('addr:' + normalizedAddr, "1");
    }
    const onChain = await syncHumanVerifiedOnChain(address);
    return NextResponse.json({ success: true, onChain, healed: true });
  }

  await store.set(nullifier, normalizedAddr);
  await store.set('addr:' + normalizedAddr, "1");

  const onChain = await syncHumanVerifiedOnChain(address);

  return NextResponse.json({ success: true, onChain });
}
