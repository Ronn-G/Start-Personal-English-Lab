import { NextResponse } from "next/server";

import { describeAiFailure, generateLesson } from "@/lib/openai";
import { geminiAdmission } from "@/server/security/admission";
import {
  ApiRequestError,
  isRecord,
  readJsonBody,
  storageErrorResponse,
} from "@/server/storage/api";

const MAX_GENERATE_BODY_BYTES = 64 * 1024;
const MIN_TRANSCRIPT_CHARS = 200;
const MAX_TRANSCRIPT_CHARS = 14_000;

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, MAX_GENERATE_BODY_BYTES);
    if (!isRecord(body) || typeof body.transcript !== "string") {
      return NextResponse.json({ error: "Transcript request is invalid." }, { status: 400 });
    }
    const transcript = body.transcript.trim();
    if (!transcript) {
      return NextResponse.json(
        { error: "Vui lòng dán transcript tiếng Anh trước khi tạo bài học." },
        { status: 400 },
      );
    }
    if (transcript.length < MIN_TRANSCRIPT_CHARS) {
      return NextResponse.json(
        { error: "Transcript hơi ngắn. Hãy dán thêm nội dung để AI tạo bài học tốt hơn." },
        { status: 400 },
      );
    }
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      return NextResponse.json(
        { error: `Transcript cannot exceed ${MAX_TRANSCRIPT_CHARS} characters.` },
        { status: 422 },
      );
    }

    console.info("[generate-lesson] Request accepted.", { transcriptLength: transcript.length });
    const lesson = await geminiAdmission.run(() => generateLesson(transcript));
    return NextResponse.json({ lesson });
  } catch (error) {
    if (error instanceof ApiRequestError) return storageErrorResponse(error);
    const failure = describeAiFailure(error, "Không thể tạo bài học từ phản hồi AI.");
    console.warn("[generate-lesson] Request failed.", { code: failure.code });
    return NextResponse.json(
      { error: failure.message, code: failure.code },
      { status: failure.status },
    );
  }
}
