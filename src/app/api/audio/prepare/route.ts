import { NextResponse } from "next/server";

import type { AudioRetryMode, AudioSourceType } from "@/lib/audio-domain";
import { AudioCacheService, AudioServiceError } from "@/server/audio/audio-cache";
import { getStorageContext } from "@/server/storage";
import { isRecord, readJsonBody } from "@/server/storage/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const retryModes = new Set<AudioRetryMode>(["preload", "automatic", "manual"]);

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, 10000);
    if (!isRecord(body) || typeof body.text !== "string") {
      throw new AudioServiceError(
        "INVALID_AUDIO_REQUEST",
        400,
        false,
        "The audio request is invalid.",
      );
    }
    const retryMode =
      typeof body.retryMode === "string" && retryModes.has(body.retryMode as AudioRetryMode)
        ? (body.retryMode as AudioRetryMode)
        : "automatic";
    const result = await new AudioCacheService({
      database: getStorageContext().database,
    }).prepare(
      body.text,
      {
        voice: typeof body.voice === "string" ? body.voice : undefined,
        speed: typeof body.speed === "number" ? body.speed : undefined,
        language: typeof body.language === "string" ? body.language : undefined,
        modelVersion: typeof body.modelVersion === "string" ? body.modelVersion : undefined,
        normalizationVersion:
          typeof body.normalizationVersion === "number" ? body.normalizationVersion : undefined,
        format: body.format === "wav" ? body.format : undefined,
      },
      {
        retryMode,
        priority:
          typeof body.priority === "number" && Number.isFinite(body.priority)
            ? Math.max(0, Math.min(20, Math.trunc(body.priority)))
            : 0,
        sourceType:
          typeof body.sourceType === "string" ? (body.sourceType as AudioSourceType) : undefined,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    const failure =
      error instanceof AudioServiceError
        ? error
        : new AudioServiceError("KOKORO_UNAVAILABLE", 503, true, "Kokoro is unavailable.");
    console.warn("Kokoro audio preparation failed.", {
      errorCode: failure.code,
      causeCode: failure.causeCode,
    });
    return NextResponse.json(
      {
        error: failure.code,
        summary: failure.safeSummary,
        provider: "kokoro",
        status: "failed",
        retryable: failure.retryable,
        nextRetryAt: failure.nextRetryAt,
      },
      { status: failure.httpStatus },
    );
  }
}
