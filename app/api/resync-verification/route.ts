import { NextResponse } from "next/server";
import { getStore } from "@netlify/blobs";
import { ethers } from "ethers";

const RPC = process.env.WORLDCHAIN_RPC || "https://worldchain-mainnet.g.alchemy.com/public";
const ABI = [
  "function humanVerified(address) view returns (bool)",
  "function setHumanVerified(address user) external",
];

async function ensureVerified(addr: string, contractAddr: string, wallet: ethers.Wallet) {
  const c = new ethers.Contract(contractAddr, ABI, wallet);
  const already = await c.humanVerified(addr).catch(() => false);
  if (already) return true;
  const tx = await c.setHumanVerified(addr);
  await tx.wait();
  return true;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");

  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  const normalizedAddr = address.toLowerCase();

  const store = getStore("world-id-nullifiers");
  const wasVerified = await store.get('addr:' + normalizedAddr).catch(() => null);
  if (wasVerified === null) {
    return NextResponse.json({ error: "Not verified" }, { status: 400 });
  }

  const pk = process.env.VERIFIER_PRIVATE_KEY;
  const referralManagerAddr = process.env.REFERRAL_MANAGER_ADDRESS;
  const hachiRankingAddr = process.env.HACHI_RANKING_ADDRESS;
  const dailyRewardsAddr = process.env.HACHI_DAILY_REWARDS_ADDRESS;
  const hachiSwapAddr = process.env.HACHI_SWAP_ADDRESS;
  if (!pk) return NextResponse.json({ error: "No verifier key" }, { status: 500 });

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);

  const results = { referralManager: false, hachiRanking: false, dailyRewards: false, hachiSwap: false };
  if (referralManagerAddr) {
    try { results.referralManager = await ensureVerified(address, referralManagerAddr, wallet); }
    catch (e) { console.error("resync ReferralManager:", e); }
  }
  if (hachiRankingAddr) {
    try { results.hachiRanking = await ensureVerified(address, hachiRankingAddr, wallet); }
    catch (e) { console.error("resync HachiRanking:", e); }
  }
  if (dailyRewardsAddr) {
    try { results.dailyRewards = await ensureVerified(address, dailyRewardsAddr, wallet); }
    catch (e) { console.error("resync HachiDailyRewards:", e); }
  }
  if (hachiSwapAddr) {
    try { results.hachiSwap = await ensureVerified(address, hachiSwapAddr, wallet); }
    catch (e) { console.error("resync HachiSwap:", e); }
  }

  return NextResponse.json({ success: true, results });
}
