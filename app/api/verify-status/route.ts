import { NextResponse } from "next/server";
import { getStore } from "@netlify/blobs";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");

  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const store = getStore("world-id-nullifiers");
  const existing = await store.get('addr:' + address.toLowerCase()).catch(() => null);

  return NextResponse.json({ verified: existing !== null });
}
