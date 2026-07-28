import { NextResponse } from "next/server";

import { AudioCacheService } from "@/server/audio/audio-cache";
import { getStorageContext } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await new AudioCacheService({
    database: getStorageContext().database,
  }).health();
  return NextResponse.json(result, { status: result.reachable ? 200 : 503 });
}
