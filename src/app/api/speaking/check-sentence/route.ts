import { NextResponse } from "next/server";

import { describeAiFailure, generateSentenceCheck } from "@/lib/openai";
import { geminiAdmission } from "@/server/security/admission";
import { SpeakingService, type SentenceCheckCommand } from "@/server/speaking/speaking-service";
import { getStorageContext } from "@/server/storage";
import {
  ApiRequestError,
  isRecord,
  readJsonBody,
  storageErrorResponse,
} from "@/server/storage/api";
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
      const result = await geminiAdmission.run(() =>
        generateSentenceCheck({
          original: prepared.task.text,
          question: prepared.task.personalizationQuestion,
          pattern: prepared.task.personalization,
          targetPhrase: prepared.task.targetPhrase,
          sentence: prepared.sentence,
        }),
      );
      return NextResponse.json(service.saveSentenceCheck(prepared, result));
    } finally {
      inFlight.delete(requestKey);
    }
  } catch (error) {
    if (error instanceof StorageError || error instanceof ApiRequestError) {
      return storageErrorResponse(error);
    }
    const failure = describeAiFailure(
      error,
      "The AI sentence checker returned an invalid response. Your draft is still saved.",
    );
    return NextResponse.json(
      {
        error: `${failure.message} Your draft is still saved.`,
        code: failure.code,
      },
      { status: failure.status },
    );
  }
}
