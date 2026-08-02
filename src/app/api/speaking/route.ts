import { NextResponse } from "next/server";

import { SpeakingService, type SpeakingCommand } from "@/server/speaking/speaking-service";
import { getStorageContext } from "@/server/storage";
import { isRecord, readJsonBody, storageErrorResponse } from "@/server/storage/api";
import { StorageError } from "@/server/storage/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, 64 * 1024);
    if (!isRecord(body) || typeof body.action !== "string") {
      throw new StorageError("VALIDATION_ERROR", "Lệnh speaking không hợp lệ.");
    }
    const result = new SpeakingService(getStorageContext().database).execute(
      body as unknown as SpeakingCommand,
    );
    return NextResponse.json(result);
  } catch (error) {
    return storageErrorResponse(error);
  }
}
