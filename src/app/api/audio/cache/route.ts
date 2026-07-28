import { NextResponse } from "next/server";

import { AudioCacheService } from "@/server/audio/audio-cache";
import { getStorageContext } from "@/server/storage";
import { isRecord, readJsonBody } from "@/server/storage/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const service = () => new AudioCacheService({ database: getStorageContext().database });

export async function GET() {
  return NextResponse.json(await service().info());
}

export async function POST(request: Request) {
  const body = await readJsonBody(request, 1000);
  if (!isRecord(body) || body.action !== "repair_invalid") {
    return NextResponse.json({ error: "INVALID_CACHE_ACTION" }, { status: 400 });
  }
  return NextResponse.json(await service().repairInvalidEntries());
}

export async function DELETE(request: Request) {
  if (request.headers.get("x-confirm-clear") !== "yes") {
    return NextResponse.json({ error: "CONFIRMATION_REQUIRED" }, { status: 400 });
  }
  return NextResponse.json(await service().clear());
}
