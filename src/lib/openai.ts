import type { Lesson, PracticeFeedback } from "@/types/lesson";

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const SYSTEM_PROMPT = `You are an expert English teacher creating lessons for Vietnamese speakers.

Given a YouTube video transcript, produce a structured English lesson as valid JSON only - no markdown, no code fences, no extra text.

The JSON must match this schema exactly:
{
  "title": "short lesson title in Vietnamese",
  "summary": "2-3 sentence overview entirely in Vietnamese describing what English skills and topics the learner will study",
  "vocabulary": [
    {
      "word": "English word or phrase from the transcript",
      "phonetic": "IPA pronunciation, e.g. /kənˈsɪstənt/",
      "definition": "clear explanation in Vietnamese of what the English word/phrase means",
      "vietnamese": "Vietnamese translation or equivalent",
      "context": "optional short English example quote from the transcript showing the word in use"
    }
  ],
  "idiomsAndSlang": [
    {
      "phrase": "English idiom, slang, or colloquial expression",
      "meaning": "explanation in Vietnamese of what it means",
      "vietnamese": "Vietnamese equivalent or paraphrase",
      "note": "optional usage note in Vietnamese"
    }
  ],
  "exampleSentences": [
    {
      "sentence": "English example sentence using a key phrase",
      "keyPhrase": "the highlighted English phrase",
      "vietnamese": "Vietnamese translation of the sentence"
    }
  ],
  "deepPractice": {
    "shadowingPractice": {
      "steps": [
        "short Vietnamese instruction for pass 1",
        "short Vietnamese instruction for pass 2",
        "short Vietnamese instruction for pass 3"
      ],
      "lines": [
        {
          "line": "short natural English line from or closely based on the transcript",
          "focus": "Vietnamese note about rhythm, linking, stress, or pronunciation",
          "vietnamese": "Vietnamese meaning of the line"
        }
      ]
    },
    "sentenceMining": [
      {
        "sentence": "useful English sentence from or closely based on the transcript",
        "pattern": "English pattern worth learning",
        "whyUseful": "Vietnamese explanation of why this pattern is useful",
        "remixPrompt": "Vietnamese prompt asking the learner to create a similar personal sentence"
      }
    ],
    "reviewPlan": [
      {
        "day": "Day 1",
        "task": "short Vietnamese review task"
      }
    ],
    "ankiCards": [
      {
        "front": "English prompt or cloze deletion",
        "back": "Vietnamese answer plus a short English example",
        "hint": "optional Vietnamese hint"
      }
    ]
  },
  "quiz": [
    {
      "question": "quiz question in Vietnamese",
      "options": ["Vietnamese option A", "Vietnamese option B", "Vietnamese option C", "Vietnamese option D"],
      "correctAnswer": 0,
      "explanation": "explanation in Vietnamese"
    }
  ]
}

Language rules:
- title and summary MUST be entirely in Vietnamese
- vocabulary.word, vocabulary.phonetic, idiomsAndSlang.phrase, and exampleSentences.sentence MUST be in English/IPA (the content being taught)
- definitions, meanings, notes, quiz questions, and explanations MUST be in Vietnamese
- context field may be a short English quote from the transcript

Requirements:
- Include exactly 20 vocabulary items drawn from the transcript
- Every vocabulary item MUST include phonetic IPA pronunciation in /slashes/
- Include 3-6 idioms or slang expressions (use [] if none appear)
- Include exactly 5 example sentences using key phrases from the lesson
- Include a compact deepPractice section:
  - exactly 3 shadowing steps and exactly 3 shadowing lines
  - exactly 3 sentenceMining items
  - exactly 4 reviewPlan items for Day 1, Day 2, Day 4, Day 7
  - exactly 5 Anki cards
- Include exactly 5 quiz questions with 4 options each
- correctAnswer must be the 0-based index of the correct option
- Use simple, learner-friendly Vietnamese for all Vietnamese text
- Keep deepPractice practical and concise, not academic or overwhelming

CRITICAL - Quiz rules:
- NEVER ask about the video's story, plot, events, people, places, times, or factual details.
- ALL quiz questions MUST test English language knowledge only: vocabulary meanings, grammar usage, idiom/slang meanings, choosing the correct word/phrase, fill-in-the-blank, or identifying correct usage.
- Every question must test whether the learner understands an English word, phrase, or grammar pattern from THIS lesson.
- Quiz question text must be in Vietnamese; quiz answer options must ALL be in Vietnamese.
- Good example: "Từ 'break the ice' có nghĩa là gì?"
- Bad example: "Trong video, họ đi đâu sau bữa sáng?"`;

function stripJsonFences(text: string): string {
  const trimmed = text.trim();

  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  return trimmed;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

async function generateGeminiJson({
  systemPrompt,
  userPrompt,
}: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Chưa cấu hình GEMINI_API_KEY.");
  }

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";
  const url = `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.35,
      },
    }),
  });

  const data = (await response.json()) as GeminiResponse;

  if (!response.ok) {
    throw new Error(data.error?.message ?? "Gemini API không tạo được nội dung.");
  }

  const content = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!content) {
    throw new Error("Gemini không trả về nội dung văn bản.");
  }

  return content;
}

function parseLesson(raw: string): Lesson {
  const parsed = JSON.parse(stripJsonFences(raw)) as Lesson;

  if (!parsed.title || parsed.vocabulary?.length !== 20 || parsed.quiz?.length !== 5) {
    throw new Error("Gemini trả về cấu trúc bài học không đầy đủ.");
  }

  if (parsed.vocabulary.some((item) => !item.phonetic?.trim())) {
    throw new Error("Gemini trả về từ vựng thiếu phiên âm IPA.");
  }

  if (parsed.exampleSentences?.length !== 5) {
    throw new Error("Gemini trả về số câu ví dụ không hợp lệ.");
  }

  if (
    parsed.deepPractice?.shadowingPractice?.steps?.length !== 3 ||
    parsed.deepPractice?.shadowingPractice?.lines?.length !== 3 ||
    parsed.deepPractice?.sentenceMining?.length !== 3 ||
    parsed.deepPractice?.reviewPlan?.length !== 4 ||
    parsed.deepPractice?.ankiCards?.length !== 5
  ) {
    throw new Error("Gemini trả về phần luyện sâu không hợp lệ.");
  }

  return parsed;
}

export async function generateLesson(transcript: string): Promise<Lesson> {
  const content = await generateGeminiJson({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Create an English lesson for Vietnamese speakers from this YouTube transcript:\n\n${transcript}`,
  });

  return parseLesson(content);
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
    throw new Error("Gemini trả về phản hồi luyện tập không đầy đủ.");
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
    systemPrompt: `You are a kind English coach for Vietnamese learners.
Return valid JSON only with this exact shape:
{
  "score": 1,
  "overall": "short Vietnamese feedback",
  "strengths": ["Vietnamese bullet"],
  "corrections": ["Vietnamese correction with English examples when useful"],
  "improvedVersion": "natural corrected English version",
  "nextStep": "one practical Vietnamese next step"
}

Rules:
- Keep Vietnamese simple and encouraging.
- Focus on communicative usefulness, not academic grammar.
- For speaking, comment on likely pronunciation/rhythm issues only when they can be inferred from the transcript text.
- Do not invent severe errors. If the answer is good, say so and polish it lightly.`,
    userPrompt: `Lesson: ${lessonTitle}
Practice mode: ${mode}
Target sentence or prompt: ${target}
Learner answer/transcript: ${answer}`,
  });

  return parsePracticeFeedback(content);
}
