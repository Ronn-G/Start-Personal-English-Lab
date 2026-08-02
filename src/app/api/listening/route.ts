import { NextResponse } from "next/server";

import { ListeningService, type ListeningCommand } from "@/server/listening/listening-service";
import { getStorageContext } from "@/server/storage";
import { isRecord, readJsonBody, storageErrorResponse } from "@/server/storage/api";
import { StorageError } from "@/server/storage/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, 32 * 1024);
    if (!isRecord(body) || typeof body.action !== "string") {
      throw new StorageError("VALIDATION_ERROR", "Lệnh listening không hợp lệ.");
    }
    const result = new ListeningService(getStorageContext().database).execute(
      body as unknown as ListeningCommand,
    );
    return NextResponse.json(result);
  } catch (error) {
    return storageErrorResponse(error);
  }
}
