import { NextResponse } from "next/server";

import { resolveAudioConfig, type AudioRetryMode, type AudioSourceType } from "@/lib/audio-domain";
import { AudioCacheService, AudioServiceError } from "@/server/audio/audio-cache";
import { getStorageContext } from "@/server/storage";
import {
  ApiRequestError,
  isRecord,
  readJsonBody,
  storageErrorResponse,
} from "@/server/storage/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const retryModes = new Set<AudioRetryMode>(["preload", "automatic", "manual"]);
const sourceTypes = new Set<AudioSourceType>([
  "vocabulary",
  "idiom",
  "grammar",
  "example",
  "shadowing",
  "sentence-mining",
  "listening",
  "speaking",
  "relisten",
]);

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
    if (
      body.retryMode !== undefined &&
      (typeof body.retryMode !== "string" || !retryModes.has(body.retryMode as AudioRetryMode))
    ) {
      throw new AudioServiceError(
        "INVALID_AUDIO_REQUEST",
        400,
        false,
        "The audio request is invalid.",
      );
    }
    if (
      body.priority !== undefined &&
      (typeof body.priority !== "number" ||
        !Number.isInteger(body.priority) ||
        body.priority < 0 ||
        body.priority > 20)
    ) {
      throw new AudioServiceError(
        "INVALID_AUDIO_REQUEST",
        400,
        false,
        "The audio request is invalid.",
      );
    }
    if (
      body.sourceType !== undefined &&
      (typeof body.sourceType !== "string" || !sourceTypes.has(body.sourceType as AudioSourceType))
    ) {
      throw new AudioServiceError(
        "INVALID_AUDIO_REQUEST",
        400,
        false,
        "The audio request is invalid.",
      );
    }
    const retryMode = (body.retryMode as AudioRetryMode | undefined) ?? "automatic";
    let config;
    try {
      config = resolveAudioConfig({
        voice: body.voice as string | undefined,
        speed: body.speed as number | undefined,
        language: body.language as string | undefined,
        modelVersion: body.modelVersion as string | undefined,
        normalizationVersion: body.normalizationVersion as number | undefined,
        format: body.format as "wav" | undefined,
      });
    } catch {
      throw new AudioServiceError(
        "INVALID_AUDIO_REQUEST",
        400,
        false,
        "The audio request is invalid.",
      );
    }
    const result = await new AudioCacheService({
      database: getStorageContext().database,
    }).prepare(body.text, config, {
      retryMode,
      priority: (body.priority as number | undefined) ?? 0,
      sourceType: body.sourceType as AudioSourceType | undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApiRequestError) return storageErrorResponse(error);
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
