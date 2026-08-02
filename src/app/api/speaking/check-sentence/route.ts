import { NextResponse } from "next/server";

import { generateSentenceCheck } from "@/lib/openai";
import { SpeakingService, type SentenceCheckCommand } from "@/server/speaking/speaking-service";
import { getStorageContext } from "@/server/storage";
import { isRecord, readJsonBody, storageErrorResponse } from "@/server/storage/api";
import { StorageError } from "@/server/storage/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inFlight = new Set<string>();

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, 4_000);
    if (!isRecord(body)) {
      throw new StorageError("VALIDATION_ERROR", "Sentence-check request không hợp lệ.");
    }
    const service = new SpeakingService(getStorageContext().database);
    const prepared = service.prepareSentenceCheck(body as unknown as SentenceCheckCommand);
    const requestKey = `${prepared.sessionId}:${prepared.binding.practiceItemId}:${prepared.clientCheckVersion}:${prepared.inputHash}:${prepared.binding.expectedRevision}`;
    if (inFlight.has(requestKey)) {
      throw new StorageError("CONFLICT", "Câu này đang được kiểm tra.");
    }
    inFlight.add(requestKey);
    try {
      const result = await generateSentenceCheck({
        original: prepared.task.text,
        question: prepared.task.personalizationQuestion,
        pattern: prepared.task.personalization,
        targetPhrase: prepared.task.targetPhrase,
        sentence: prepared.sentence,
      });
      return NextResponse.json(service.saveSentenceCheck(prepared, result));
    } finally {
      inFlight.delete(requestKey);
    }
  } catch (error) {
    if (error instanceof StorageError) return storageErrorResponse(error);
    if (error instanceof Error && error.message.includes("GEMINI_API_KEY")) {
      return NextResponse.json(
        {
          error:
            "Sentence checking requires an AI provider. Your draft is still saved, and you can continue speaking practice without checking it.",
          code: "PROVIDER_REQUIRED",
        },
        { status: 503 },
      );
    }
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      return NextResponse.json(
        {
          error: "Sentence checking timed out. Your draft is still saved.",
          code: "PROVIDER_TIMEOUT",
        },
        { status: 504 },
      );
    }
    return NextResponse.json(
      {
        error:
          "The AI sentence checker is temporarily unavailable. Your draft is still saved, so you can try again or continue speaking practice.",
        code: "PROVIDER_UNAVAILABLE",
      },
      { status: 502 },
    );
  }
}
