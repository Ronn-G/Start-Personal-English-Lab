import { NextResponse } from "next/server";

import { AudioCacheService } from "@/server/audio/audio-cache";
import { getStorageContext } from "@/server/storage";
import {
  assertLocalMutationRequest,
  isRecord,
  readJsonBody,
  storageErrorResponse,
} from "@/server/storage/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const service = () => new AudioCacheService({ database: getStorageContext().database });

export async function GET() {
  return NextResponse.json(await service().info());
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, 1000);
    if (!isRecord(body) || body.action !== "repair_invalid") {
      return NextResponse.json({ error: "INVALID_CACHE_ACTION" }, { status: 400 });
    }
    return NextResponse.json(await service().repairInvalidEntries());
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertLocalMutationRequest(request);
    if (request.headers.get("x-confirm-clear") !== "yes") {
      return NextResponse.json({ error: "CONFIRMATION_REQUIRED" }, { status: 400 });
    }
    return NextResponse.json(await service().clear());
  } catch (error) {
    return storageErrorResponse(error);
  }
}
