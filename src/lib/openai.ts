import { formatLessonDiagnostics, parseLessonText, stripJsonFences } from "./lesson-schema";
import { LESSON_SYSTEM_PROMPT } from "./lesson-prompt";
import { parseSentenceCheck, type SentenceCheckResult } from "./sentence-check";
import type { Lesson, PracticeFeedback } from "../types/lesson";

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MAX_OUTPUT_TOKENS = 16_384;
const GEMINI_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const GEMINI_TIMEOUT_MS = 20_000;
const GEMINI_MODEL_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
}

export class AiProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly safeMessage: string,
  ) {
    super(code);
    this.name = "AiProviderError";
  }
}

export function describeAiFailure(error: unknown, fallback: string) {
  if (error instanceof AiProviderError) {
    return { code: error.code, status: error.status, message: error.safeMessage };
  }
  return { code: "AI_OUTPUT_INVALID", status: 422, message: fallback };
}

async function readBoundedGeminiResponse(response: Response): Promise<GeminiResponse> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > GEMINI_RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new AiProviderError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      502,
      "The AI provider returned an invalid response.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new AiProviderError(
      "PROVIDER_INVALID_RESPONSE",
      502,
      "The AI provider returned an invalid response.",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GEMINI_RESPONSE_LIMIT_BYTES) {
        throw new AiProviderError(
          "PROVIDER_RESPONSE_TOO_LARGE",
          502,
          "The AI provider returned an invalid response.",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as GeminiResponse;
  } catch {
    throw new AiProviderError(
      "PROVIDER_INVALID_RESPONSE",
      502,
      "The AI provider returned an invalid response.",
    );
  }
}

export async function generateGeminiJson({
  systemPrompt,
  userPrompt,
}: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AiProviderError(
      "PROVIDER_REQUIRED",
      503,
      "Gemini is not configured on this computer.",
    );
  }
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";
  if (!GEMINI_MODEL_PATTERN.test(model)) {
    throw new AiProviderError(
      "PROVIDER_CONFIGURATION_INVALID",
      503,
      "The configured Gemini model is invalid.",
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.35,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          },
        }),
      },
    );
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      throw new AiProviderError(
        "PROVIDER_TIMEOUT",
        504,
        "The AI provider took too long to respond.",
      );
    }
    throw new AiProviderError(
      "PROVIDER_UNAVAILABLE",
      502,
      "The AI provider is temporarily unavailable.",
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    console.warn("Gemini request rejected.", { status: response.status });
    throw new AiProviderError(
      "PROVIDER_REJECTED",
      response.status === 429 ? 503 : 502,
      "The AI provider could not complete the request.",
    );
  }
  const data = await readBoundedGeminiResponse(response);
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new AiProviderError(
      "PROVIDER_OUTPUT_LIMIT",
      422,
      "The AI response reached its output limit. Try a shorter input.",
    );
  }
  if (
    candidate?.finishReason &&
    !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)
  ) {
    throw new AiProviderError(
      "PROVIDER_INCOMPLETE_RESPONSE",
      422,
      "The AI provider did not complete the response.",
    );
  }
  const content = candidate?.content?.parts
    ?.filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!content) {
    throw new AiProviderError(
      "PROVIDER_EMPTY_RESPONSE",
      502,
      "The AI provider returned an empty response.",
    );
  }
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

interface PracticeFeedbackInput {
  mode: "speaking" | "writing";
  lessonTitle: string;
  target: string;
  answer: string;
}

function parsePracticeFeedback(raw: string): PracticeFeedback {
  const parsed = JSON.parse(stripJsonFences(raw)) as PracticeFeedback;
  if (
    typeof parsed.score !== "number" ||
    !parsed.overall ||
    !Array.isArray(parsed.strengths) ||
    !Array.isArray(parsed.corrections) ||
    !parsed.improvedVersion ||
    !parsed.nextStep
  ) {
    throw new Error("Invalid practice feedback.");
  }
  return {
    score: Math.min(Math.max(Math.round(parsed.score), 1), 10),
    overall: parsed.overall,
    strengths: parsed.strengths.slice(0, 3),
    corrections: parsed.corrections.slice(0, 4),
    improvedVersion: parsed.improvedVersion,
    nextStep: parsed.nextStep,
  };
}

export async function generatePracticeFeedback({
  mode,
  lessonTitle,
  target,
  answer,
}: PracticeFeedbackInput): Promise<PracticeFeedback> {
  const content = await generateGeminiJson({
    systemPrompt:
      "You are a kind English coach for Vietnamese learners. Return valid JSON only with score (1-10), overall, strengths, corrections, improvedVersion and nextStep. Keep Vietnamese simple and encouraging; focus on communicative usefulness.",
    userPrompt: `Lesson: ${lessonTitle}\nPractice mode: ${mode}\nTarget sentence or prompt: ${target}\nLearner answer/transcript: ${answer}`,
  });
  return parsePracticeFeedback(content);
}

export async function generateSentenceCheck(input: {
  original: string;
  question?: string;
  pattern: string;
  targetPhrase?: string;
  sentence: string;
}): Promise<SentenceCheckResult> {
  if (process.env.SENTENCE_CHECK_MOCK === "1") {
    return {
      understandable: true,
      verdict: "needs_small_fix",
      correctedSentence: "I need to be honest with myself about how much time I spend gaming.",
      naturalAlternative: "I need to admit that I spend too much time gaming.",
      explanationVi: "Sau ‘about’, nên dùng một cụm danh từ hoặc cấu trúc ‘how much...’.",
    };
  }
  const raw = await generateGeminiJson({
    systemPrompt:
      "You check one personal English sentence for a Vietnamese learner. Preserve their exact meaning and personal experience. Prefer short, natural spoken English. Correct only necessary grammar, vocabulary, or structure. correctedSentence stays as close as possible; naturalAlternative is null when no improvement is needed. explanationVi is 1–3 short Vietnamese sentences. Never score, judge, use markdown, or add fields. Return JSON only with understandable, verdict (clear|needs_small_fix|needs_rewrite|unclear), correctedSentence, naturalAlternative, explanationVi.",
    userPrompt: `Learner: Vietnamese; wants natural spoken English and short easy-to-say sentences.\nOriginal: ${input.original}\nQuestion: ${input.question ?? ""}\nUseful pattern: ${input.pattern}\nTarget phrase: ${input.targetPhrase ?? ""}\nUser sentence: ${input.sentence}`,
  });
  return parseSentenceCheck(raw);
}
