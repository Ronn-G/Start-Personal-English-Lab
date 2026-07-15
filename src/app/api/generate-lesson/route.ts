import { NextResponse } from "next/server";

import { generateLesson } from "@/lib/openai";

const MAX_TRANSCRIPT_CHARS = 14_000;

function truncateTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[Transcript truncated due to length.]`;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { transcript?: string };
    const rawTranscript = body.transcript?.trim();

    console.log(
      "[generate-lesson] Request received, transcript length:",
      rawTranscript?.length ?? 0,
    );

    if (!rawTranscript) {
      return NextResponse.json(
        { error: "Vui lòng dán transcript tiếng Anh trước khi tạo bài học." },
        { status: 400 },
      );
    }

    if (rawTranscript.length < 200) {
      return NextResponse.json(
        {
          error:
            "Transcript hơi ngắn. Hãy dán thêm nội dung để AI tạo bài học tốt hơn.",
        },
        { status: 400 },
      );
    }

    const transcript = truncateTranscript(rawTranscript);

    console.log("[generate-lesson] Generating lesson from pasted transcript...");
    const lesson = await generateLesson(transcript);
    console.log("[generate-lesson] Lesson generated successfully");

    return NextResponse.json({ lesson });
  } catch (error) {
    console.error("[generate-lesson] Failed:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Đã xảy ra lỗi khi tạo bài học.";

    const status = message.includes("GEMINI_API_KEY") ? 500 : 422;

    return NextResponse.json({ error: message }, { status });
  }
}
