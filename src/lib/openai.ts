import { formatLessonDiagnostics, parseLessonText, stripJsonFences } from "./lesson-schema";
import { LESSON_SYSTEM_PROMPT } from "./lesson-prompt";
import type { Lesson, PracticeFeedback } from "../types/lesson";

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MAX_OUTPUT_TOKENS = 16_384;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
    finishMessage?: string;
  }>;
  error?: { message?: string };
}

async function generateGeminiJson({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình GEMINI_API_KEY.");
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";
  const response = await fetch(`${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.35,
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
      },
    }),
  });
  const data = await response.json() as GeminiResponse;
  if (!response.ok) throw new Error(data.error?.message ?? "Gemini API không tạo được nội dung.");

  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new Error("Gemini đã dừng vì bài học vượt giới hạn đầu ra. Hãy thử lại hoặc dùng transcript ngắn hơn.");
  }
  if (candidate?.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) {
    throw new Error(candidate.finishMessage ?? `Gemini không hoàn tất bài học (${candidate.finishReason}).`);
  }
  const content = candidate?.content?.parts
    ?.filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!content) throw new Error("Gemini không trả về nội dung JSON.");
  return content;
}

export function parseGeneratedLesson(raw: string): Lesson {
  const result = parseLessonText(raw);
  if (!result.success || !result.data) throw new Error(formatLessonDiagnostics(result));
  return result.data;
}

export async function generateLesson(transcript: string): Promise<Lesson> {
  const content = await generateGeminiJson({
    systemPrompt: LESSON_SYSTEM_PROMPT,
    userPrompt: `Create an English lesson for Vietnamese speakers from this YouTube transcript:\n\n${transcript}`,
  });
  return parseGeneratedLesson(content);
}

interface PracticeFeedbackInput { mode: "speaking" | "writing"; lessonTitle: string; target: string; answer: string }

function parsePracticeFeedback(raw: string): PracticeFeedback {
  const parsed = JSON.parse(stripJsonFences(raw)) as PracticeFeedback;
  if (typeof parsed.score !== "number" || !parsed.overall || !Array.isArray(parsed.strengths) || !Array.isArray(parsed.corrections) || !parsed.improvedVersion || !parsed.nextStep) throw new Error("Gemini trả về phản hồi luyện tập không đầy đủ.");
  return { score: Math.min(Math.max(Math.round(parsed.score), 1), 10), overall: parsed.overall, strengths: parsed.strengths.slice(0, 3), corrections: parsed.corrections.slice(0, 4), improvedVersion: parsed.improvedVersion, nextStep: parsed.nextStep };
}

export async function generatePracticeFeedback({ mode, lessonTitle, target, answer }: PracticeFeedbackInput): Promise<PracticeFeedback> {
  const content = await generateGeminiJson({
    systemPrompt: "You are a kind English coach for Vietnamese learners. Return valid JSON only with score (1-10), overall, strengths, corrections, improvedVersion and nextStep. Keep Vietnamese simple and encouraging; focus on communicative usefulness.",
    userPrompt: `Lesson: ${lessonTitle}\nPractice mode: ${mode}\nTarget sentence or prompt: ${target}\nLearner answer/transcript: ${answer}`,
  });
  return parsePracticeFeedback(content);
}
