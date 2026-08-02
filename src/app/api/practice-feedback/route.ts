import { NextResponse } from "next/server";

import { describeAiFailure, generatePracticeFeedback } from "@/lib/openai";
import { geminiAdmission } from "@/server/security/admission";
import {
  ApiRequestError,
  isRecord,
  readJsonBody,
  storageErrorResponse,
} from "@/server/storage/api";

const MAX_FEEDBACK_BODY_BYTES = 32 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_TARGET_CHARS = 2_000;
const MAX_ANSWER_CHARS = 8_000;

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, MAX_FEEDBACK_BODY_BYTES);
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Practice request is invalid." }, { status: 400 });
    }
    const mode = body.mode === "speaking" ? "speaking" : "writing";
    const lessonTitle = typeof body.lessonTitle === "string" ? body.lessonTitle.trim() : "";
    const target = typeof body.target === "string" ? body.target.trim() : "";
    const answer = typeof body.answer === "string" ? body.answer.trim() : "";
    if (!target || !answer) {
      return NextResponse.json(
        { error: "Bạn cần có câu mẫu và phần trả lời để nhận phản hồi." },
        { status: 400 },
      );
    }
    if (answer.length < 8) {
      return NextResponse.json(
        { error: "Câu trả lời hơi ngắn. Hãy nói hoặc viết thêm một chút." },
        { status: 400 },
      );
    }
    if (
      lessonTitle.length > MAX_TITLE_CHARS ||
      target.length > MAX_TARGET_CHARS ||
      answer.length > MAX_ANSWER_CHARS
    ) {
      return NextResponse.json({ error: "Practice request is too long." }, { status: 422 });
    }
    const feedback = await geminiAdmission.run(() =>
      generatePracticeFeedback({
        mode,
        lessonTitle: lessonTitle || "English lesson",
        target,
        answer,
      }),
    );
    return NextResponse.json({ feedback });
  } catch (error) {
    if (error instanceof ApiRequestError) return storageErrorResponse(error);
    const failure = describeAiFailure(error, "Không thể tạo phản hồi luyện tập.");
    console.warn("[practice-feedback] Request failed.", { code: failure.code });
    return NextResponse.json(
      { error: failure.message, code: failure.code },
      { status: failure.status },
    );
  }
}
