import { NextResponse } from "next/server";

import { generatePracticeFeedback } from "@/lib/openai";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      mode?: "speaking" | "writing";
      lessonTitle?: string;
      target?: string;
      answer?: string;
    };

    const mode = body.mode === "speaking" ? "speaking" : "writing";
    const target = body.target?.trim();
    const answer = body.answer?.trim();

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

    const feedback = await generatePracticeFeedback({
      mode,
      lessonTitle: body.lessonTitle?.trim() || "English lesson",
      target,
      answer,
    });

    return NextResponse.json({ feedback });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Không thể tạo phản hồi luyện tập.";

    const status = message.includes("GEMINI_API_KEY") ? 500 : 422;

    return NextResponse.json({ error: message }, { status });
  }
}
