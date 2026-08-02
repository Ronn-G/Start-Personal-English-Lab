import { NextResponse } from "next/server";

import { isRecord, readJsonBody, storageErrorResponse } from "@/server/storage/api";
import type { CreateLessonInput } from "@/server/storage/domain";
import { StorageError } from "@/server/storage/errors";
import { getStorageContext } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const lessons = await getStorageContext().repository.listLessons();
    return NextResponse.json({ lessons });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, 1_000_000);
    if (!isRecord(body) || !isRecord(body.lesson)) {
      throw new StorageError("VALIDATION_ERROR", "Request thiếu lesson.");
    }
    const lesson = await getStorageContext().repository.createLesson(
      body as unknown as CreateLessonInput,
    );
    return NextResponse.json({ lesson }, { status: 201 });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
