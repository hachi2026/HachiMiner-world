import { NextResponse } from "next/server";
import { getStore } from "@netlify/blobs";
import { hashSignal } from "@worldcoin/idkit-core";
import { ethers } from "ethers";

const RPC = process.env.WORLDCHAIN_RPC || "https://worldchain-mainnet.g.alchemy.com/public";

const SET_HUMAN_VERIFIED_ABI = ["function setHumanVerified(address user) external"];

async function syncHumanVerifiedOnChain(userAddress: string) {
  const pk = process.env.VERIFIER_PRIVATE_KEY;
  const referralManagerAddr = process.env.REFERRAL_MANAGER_ADDRESS;

  if (!pk) {
    console.error("VERIFIER_PRIVATE_KEY no configurada; no se pudo sincronizar on-chain");
    return { referralManager: false };
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);

  const results = { referralManager: false };

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
  const existing = await store.get(nullifier);

  if (existing !== null) {
    return NextResponse.json({ error: "Already verified" }, { status: 400 });
  }

  await store.set(nullifier, "1");
  await store.set('addr:' + address.toLowerCase(), "1");

  const onChain = await syncHumanVerifiedOnChain(address);

  return NextResponse.json({ success: true, onChain });
}
