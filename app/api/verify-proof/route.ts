import { NextResponse } from "next/server";
import { getStore } from "@netlify/blobs";

export async function POST(request: Request): Promise<Response> {
  const { rp_id, idkitResponse } = await request.json();

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

  // Session proofs carry nullifier in responses[0].session_nullifier[0];
  // uniqueness proofs (v3 and v4) carry it in responses[0].nullifier.
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

  const store = getStore("world-id-nullifiers");
  const existing = await store.get(nullifier);

  if (existing !== null) {
    return NextResponse.json({ error: "Already verified" }, { status: 400 });
  }

  await store.set(nullifier, "1");

  return NextResponse.json({ success: true });
}
