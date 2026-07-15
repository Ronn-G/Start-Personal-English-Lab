import { NextResponse } from "next/server";

import { isRecord, readJsonBody, storageErrorResponse } from "@/server/storage/api";
import type { UpdateLessonInput } from "@/server/storage/domain";
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
    const lesson = await getStorageContext().repository.getLesson(id);
    if (!lesson) throw new StorageError("NOT_FOUND", "Không tìm thấy lesson.");
    return NextResponse.json({ lesson });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: RouteParameters) {
  try {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new StorageError("VALIDATION_ERROR", "Request update không hợp lệ.");
    }
    const { id } = await params;
    const lesson = await getStorageContext().repository.updateLesson(
      id,
      body as UpdateLessonInput,
    );
    return NextResponse.json({ lesson });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: RouteParameters) {
  try {
    const { id } = await params;
    await getStorageContext().repository.deleteLesson(id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
