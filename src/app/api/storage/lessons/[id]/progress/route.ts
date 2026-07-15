import { NextResponse } from "next/server";

import { isRecord, readJsonBody, storageErrorResponse } from "@/server/storage/api";
import { StorageError } from "@/server/storage/errors";
import { getStorageContext } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParameters {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParameters) {
  try {
    const { id } = await params;
    const progress = await getStorageContext().repository.getLessonProgress(id);
    return NextResponse.json({ progress });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: RouteParameters) {
  try {
    const body = await readJsonBody(request);
    if (!isRecord(body) || !isRecord(body.progress)) {
      throw new StorageError("VALIDATION_ERROR", "Request thiếu progress.");
    }
    const version = body.progressVersion;
    if (version !== undefined && (!Number.isInteger(version) || Number(version) < 1)) {
      throw new StorageError("VALIDATION_ERROR", "Progress version không hợp lệ.");
    }
    const { id } = await params;
    const progress = await getStorageContext().repository.saveLessonProgress(
      id,
      body.progress,
      version === undefined ? undefined : Number(version),
    );
    return NextResponse.json({ progress });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
