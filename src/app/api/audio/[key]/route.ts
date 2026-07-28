import { NextResponse } from "next/server";

import { AudioCacheService, AudioServiceError } from "@/server/audio/audio-cache";
import { getStorageContext } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await params;
    const bytes = await new AudioCacheService({
      database: getStorageContext().database,
    }).read(key);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    const failure =
      error instanceof AudioServiceError
        ? error
        : new AudioServiceError(
            "AUDIO_STORAGE_FAILED",
            404,
            true,
            "The cached audio file is missing or invalid.",
          );
    return NextResponse.json(
      {
        error: failure.code,
        summary: failure.safeSummary,
        retryable: failure.retryable,
      },
      { status: failure.httpStatus },
    );
  }
}
