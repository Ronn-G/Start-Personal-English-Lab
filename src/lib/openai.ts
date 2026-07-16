import { formatLessonDiagnostics, parseLessonText, stripJsonFences } from "./lesson-schema";
import { LESSON_SYSTEM_PROMPT } from "./lesson-prompt";
import type { Lesson, PracticeFeedback } from "../types/lesson";
import { parseSentenceCheck, type SentenceCheckResult } from "./sentence-check";

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

export async function generateGeminiJson({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình GEMINI_API_KEY.");
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";
  const response = await fetch(`${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000), body: JSON.stringify({
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

export async function generateSentenceCheck(input:{original:string;question?:string;pattern:string;targetPhrase?:string;sentence:string}):Promise<SentenceCheckResult>{
  if(process.env.SENTENCE_CHECK_MOCK==="1")return {understandable:true,verdict:"needs_small_fix",correctedSentence:"I need to be honest with myself about how much time I spend gaming.",naturalAlternative:"I need to admit that I spend too much time gaming.",explanationVi:"Sau ‘about’, nên dùng một cụm danh từ hoặc cấu trúc ‘how much...’."};
  const raw=await generateGeminiJson({systemPrompt:"You check one personal English sentence for a Vietnamese learner. Preserve their exact meaning and personal experience. Prefer short, natural spoken English. Correct only necessary grammar, vocabulary, or structure. correctedSentence stays as close as possible; naturalAlternative is null when no improvement is needed. explanationVi is 1–3 short Vietnamese sentences. Never score, judge, use markdown, or add fields. Return JSON only with understandable, verdict (clear|needs_small_fix|needs_rewrite|unclear), correctedSentence, naturalAlternative, explanationVi.",userPrompt:`Learner: Vietnamese; wants natural spoken English and short easy-to-say sentences.\nOriginal: ${input.original}\nQuestion: ${input.question??""}\nUseful pattern: ${input.pattern}\nTarget phrase: ${input.targetPhrase??""}\nUser sentence: ${input.sentence}`});
  return parseSentenceCheck(raw);
}
