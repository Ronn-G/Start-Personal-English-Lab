import { NextResponse } from "next/server";

import { AudioCacheService } from "@/server/audio/audio-cache";
import { getStorageContext } from "@/server/storage";
import { isRecord, readJsonBody } from "@/server/storage/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, 10000);
    if (!isRecord(body) || typeof body.text !== "string") {
      return NextResponse.json(
        {
          error: "INVALID_INPUT",
          provider: "kokoro",
          status: "failed",
          retryable: false,
        },
        { status: 400 },
      );
    }
    const result = await new AudioCacheService({
      database: getStorageContext().database,
    }).prepare(body.text, {
      voice: typeof body.voice === "string" ? body.voice : undefined,
      speed: typeof body.speed === "number" ? body.speed : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = String(error);
    const status = message.includes("INVALID_TEXT") ? 400 : message.includes("Abort") ? 504 : 503;
    const errorCode =
      status === 400 ? "INVALID_TEXT" : status === 504 ? "KOKORO_TIMEOUT" : "KOKORO_UNAVAILABLE";
    console.warn("Kokoro audio preparation failed.", {
      errorCode,
      cause:
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : error instanceof Error
            ? error.message
            : "Unknown audio error",
    });
    return NextResponse.json(
      {
        error: errorCode,
        provider: "kokoro",
        status: "failed",
        retryable: status !== 400,
      },
      { status },
    );
  }
}
