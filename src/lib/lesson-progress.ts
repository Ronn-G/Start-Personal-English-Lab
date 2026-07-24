import type { Diagnostic } from "./lesson-schema";
import type { Lesson, PracticeFeedback } from "../types/lesson";

export const CURRENT_PROGRESS_SCHEMA_VERSION = 1;
export const PRACTICE_HISTORY_LIMIT = 20;
export const LESSON_SECTION_KEYS = ["vocabulary", "idioms", "grammar", "practice", "quiz"] as const;

export type LessonSectionKey = (typeof LESSON_SECTION_KEYS)[number];
export type LearningStatus = "new" | "learning" | "learned";

export interface QuizItemProgress {
  itemId: string;
  selectedAnswer: number;
  correct: boolean;
  attemptCount: number;
  answeredAt: string;
  completed: boolean;
}

export interface LearningItemProgress {
  itemId: string;
  status: LearningStatus;
  updatedAt: string;
  userSelected: boolean;
}

export interface PracticeHistoryItem {
  id: string;
  itemId: string;
  mode: "writing" | "speaking";
  prompt: string;
  userAnswer: string;
  feedback: PracticeFeedback;
  occurredAt: string;
}

export interface LessonProgress {
  lessonId: string;
  progressVersion: typeof CURRENT_PROGRESS_SCHEMA_VERSION;
  quizItems: Record<string, QuizItemProgress>;
  learningItems: Record<string, LearningItemProgress>;
  visitedSections: LessonSectionKey[];
  practiceHistory: PracticeHistoryItem[];
  createdAt: string;
  updatedAt: string;
}

export type LessonProgressCommand =
  | { type: "mark_learning_item_reviewed"; itemId: string }
  | { type: "mark_section_visited"; section: LessonSectionKey }
  | {
      type: "record_quiz_answer";
      itemId: string;
      selectedAnswer: number;
    }
  | { type: "append_practice_history"; record: PracticeHistoryItem };

export interface ProgressResult {
  success: boolean;
  data?: LessonProgress;
  diagnostics: Diagnostic[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const text = (value: unknown, maximum = 10_000): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const error = (code: string, path: string, message: string): Diagnostic => ({
  code,
  path,
  message,
  severity: "error",
});

function validFeedback(value: unknown): value is PracticeFeedback {
  return (
    record(value) &&
    Number.isInteger(value.score) &&
    Number(value.score) >= 0 &&
    Number(value.score) <= 10 &&
    text(value.overall, 4_000) &&
    Array.isArray(value.strengths) &&
    value.strengths.every((item) => text(item, 2_000)) &&
    Array.isArray(value.corrections) &&
    value.corrections.every((item) => text(item, 2_000)) &&
    text(value.improvedVersion, 4_000) &&
    text(value.nextStep, 4_000)
  );
}

export function emptyLessonProgress(
  lessonId: string,
  timestamp = new Date().toISOString(),
): LessonProgress {
  return {
    lessonId,
    progressVersion: CURRENT_PROGRESS_SCHEMA_VERSION,
    quizItems: {},
    learningItems: {},
    visitedSections: [],
    practiceHistory: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function validateLessonProgress(value: unknown): ProgressResult {
  const diagnostics: Diagnostic[] = [];
  if (!record(value)) {
    return {
      success: false,
      diagnostics: [error("INVALID_TYPE", "$", "Progress phải là JSON object.")],
    };
  }
  if (typeof value.lessonId !== "string" || !value.lessonId) {
    diagnostics.push(error("INVALID_FIELD", "$.lessonId", "lessonId không hợp lệ."));
  }
  if (value.progressVersion !== CURRENT_PROGRESS_SCHEMA_VERSION) {
    diagnostics.push(
      error(
        "UNSUPPORTED_PROGRESS_VERSION",
        "$.progressVersion",
        `Chỉ hỗ trợ progress version ${CURRENT_PROGRESS_SCHEMA_VERSION}.`,
      ),
    );
  }
  if (!record(value.quizItems)) {
    diagnostics.push(
      error("INVALID_TYPE", "$.quizItems", "quizItems phải là object theo item ID."),
    );
  } else {
    for (const [id, item] of Object.entries(value.quizItems)) {
      if (
        !record(item) ||
        item.itemId !== id ||
        !Number.isInteger(item.selectedAnswer) ||
        ![0, 1, 2, 3].includes(Number(item.selectedAnswer)) ||
        typeof item.correct !== "boolean" ||
        !Number.isInteger(item.attemptCount) ||
        Number(item.attemptCount) < 1 ||
        !iso(item.answeredAt) ||
        typeof item.completed !== "boolean"
      ) {
        diagnostics.push(
          error("INVALID_QUIZ_PROGRESS", `$.quizItems.${id}`, "Quiz progress item không hợp lệ."),
        );
      }
    }
  }
  if (!record(value.learningItems)) {
    diagnostics.push(
      error("INVALID_TYPE", "$.learningItems", "learningItems phải là object theo item ID."),
    );
  } else {
    for (const [id, item] of Object.entries(value.learningItems)) {
      if (
        !record(item) ||
        item.itemId !== id ||
        !["new", "learning", "learned"].includes(String(item.status)) ||
        !iso(item.updatedAt) ||
        typeof item.userSelected !== "boolean"
      ) {
        diagnostics.push(
          error(
            "INVALID_LEARNING_PROGRESS",
            `$.learningItems.${id}`,
            "Learning progress item không hợp lệ.",
          ),
        );
      }
    }
  }
  if (
    !Array.isArray(value.visitedSections) ||
    value.visitedSections.some(
      (section) => !LESSON_SECTION_KEYS.includes(section as LessonSectionKey),
    )
  ) {
    diagnostics.push(
      error("INVALID_SECTION", "$.visitedSections", "visitedSections không hợp lệ."),
    );
  }
  if (
    !Array.isArray(value.practiceHistory) ||
    value.practiceHistory.length > PRACTICE_HISTORY_LIMIT ||
    value.practiceHistory.some(
      (item) =>
        !record(item) ||
        !UUID.test(String(item.id ?? "")) ||
        !UUID.test(String(item.itemId ?? "")) ||
        !["writing", "speaking"].includes(String(item.mode)) ||
        !text(item.prompt, 4_000) ||
        !text(item.userAnswer, 10_000) ||
        !validFeedback(item.feedback) ||
        !iso(item.occurredAt),
    )
  ) {
    diagnostics.push(
      error("INVALID_PRACTICE_HISTORY", "$.practiceHistory", "Lịch sử luyện tập không hợp lệ."),
    );
  }
  if (!iso(value.createdAt) || !iso(value.updatedAt)) {
    diagnostics.push(error("INVALID_TIMESTAMP", "$", "Timestamp progress không hợp lệ."));
  }
  return {
    success: diagnostics.length === 0,
    data: diagnostics.length ? undefined : (value as unknown as LessonProgress),
    diagnostics,
  };
}

export function normalizeLessonProgress(
  value: unknown,
  lessonId?: string,
  timestamp = new Date().toISOString(),
): ProgressResult {
  if (!record(value)) {
    return validateLessonProgress(value);
  }
  if (value.progressVersion === undefined && value.quizItems === undefined) {
    return validateLessonProgress(value);
  }
  const normalized = {
    ...value,
    lessonId: value.lessonId ?? lessonId,
    progressVersion: value.progressVersion ?? CURRENT_PROGRESS_SCHEMA_VERSION,
    quizItems: value.quizItems ?? {},
    learningItems: value.learningItems ?? {},
    visitedSections: value.visitedSections ?? [],
    practiceHistory: value.practiceHistory ?? [],
    createdAt: value.createdAt ?? timestamp,
    updatedAt: value.updatedAt ?? timestamp,
  };
  return validateLessonProgress(normalized);
}

function lessonItemIds(lesson: Lesson): Set<string> {
  return new Set([
    ...lesson.vocabulary.map((item) => item.id),
    ...lesson.idiomsAndSlang.map((item) => item.id),
    ...lesson.exampleSentences.map((item) => item.id),
    ...lesson.quiz.map((item) => item.id),
    ...lesson.deepPractice.shadowingPractice.lines.map((item) => item.id),
    ...lesson.deepPractice.sentenceMining.map((item) => item.id),
    ...lesson.deepPractice.ankiCards.map((item) => item.id),
  ]);
}

export function applyLessonProgressCommand(
  current: LessonProgress | undefined,
  lesson: Lesson,
  command: LessonProgressCommand,
  timestamp = new Date().toISOString(),
): LessonProgress {
  const progress = current ?? emptyLessonProgress(lesson.id, timestamp);
  if (progress.lessonId !== lesson.id) {
    throw new Error("Progress không thuộc bài học này.");
  }

  if (command.type === "mark_section_visited") {
    if (!LESSON_SECTION_KEYS.includes(command.section)) {
      throw new Error("Phần bài học không hợp lệ.");
    }
    return {
      ...progress,
      visitedSections: [...new Set([...progress.visitedSections, command.section])],
      updatedAt: timestamp,
    };
  }

  const allowedIds = lessonItemIds(lesson);
  if (
    !allowedIds.has(
      command.type === "append_practice_history" ? command.record.itemId : command.itemId,
    )
  ) {
    throw new Error("Nội dung không thuộc bài học này.");
  }

  if (command.type === "mark_learning_item_reviewed") {
    if (!lesson.vocabulary.some((item) => item.id === command.itemId)) {
      throw new Error("Từ vựng không thuộc bài học này.");
    }
    return {
      ...progress,
      learningItems: {
        ...progress.learningItems,
        [command.itemId]: {
          itemId: command.itemId,
          status: "learned",
          updatedAt: timestamp,
          userSelected: true,
        },
      },
      updatedAt: timestamp,
    };
  }

  if (command.type === "record_quiz_answer") {
    const question = lesson.quiz.find((item) => item.id === command.itemId);
    if (!question || ![0, 1, 2, 3].includes(command.selectedAnswer)) {
      throw new Error("Câu trả lời quiz không hợp lệ.");
    }
    const old = progress.quizItems[command.itemId];
    return {
      ...progress,
      quizItems: {
        ...progress.quizItems,
        [command.itemId]: {
          itemId: command.itemId,
          selectedAnswer: command.selectedAnswer,
          correct: command.selectedAnswer === question.correctAnswer,
          attemptCount: (old?.attemptCount ?? 0) + 1,
          answeredAt: timestamp,
          completed: true,
        },
      },
      updatedAt: timestamp,
    };
  }

  const checkedRecord = validateLessonProgress({
    ...progress,
    practiceHistory: [command.record],
    updatedAt: timestamp,
  });
  if (!checkedRecord.success) {
    throw new Error("Bản ghi luyện tập không hợp lệ.");
  }
  const byId = new Map(progress.practiceHistory.map((item) => [item.id, item]));
  byId.set(command.record.id, command.record);
  const practiceHistory = [...byId.values()]
    .sort(
      (left, right) =>
        Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, PRACTICE_HISTORY_LIMIT);
  return { ...progress, practiceHistory, updatedAt: timestamp };
}

export function migrateLegacyProgress(
  value: unknown,
  lesson: Lesson,
  timestamp = lesson.createdAt,
): ProgressResult {
  const diagnostics: Diagnostic[] = [];
  if (!record(value)) {
    return {
      success: false,
      diagnostics: [error("INVALID_TYPE", "$", "Legacy progress phải là JSON object.")],
    };
  }
  const answered = value.answeredQuestions;
  if (answered !== undefined && !Array.isArray(answered)) {
    return {
      success: false,
      diagnostics: [
        error("INVALID_TYPE", "$.answeredQuestions", "answeredQuestions phải là array index."),
      ],
    };
  }
  const quizItems: Record<string, QuizItemProgress> = {};
  for (const raw of new Set(Array.isArray(answered) ? answered : [])) {
    if (!Number.isInteger(raw)) {
      diagnostics.push({
        ...error("INVALID_INDEX", "$.answeredQuestions", `Bỏ qua index sai kiểu: ${String(raw)}.`),
        severity: "warning",
      });
      continue;
    }
    const question = lesson.quiz[Number(raw)];
    if (!question) {
      diagnostics.push({
        ...error(
          "INDEX_OUT_OF_RANGE",
          "$.answeredQuestions",
          `Bỏ qua quiz index ngoài phạm vi: ${raw}.`,
        ),
        severity: "warning",
      });
      continue;
    }
    quizItems[question.id] = {
      itemId: question.id,
      selectedAnswer: question.correctAnswer,
      correct: true,
      attemptCount: 1,
      answeredAt: timestamp,
      completed: true,
    };
  }
  const visitedSections = Array.isArray(value.visitedTabs)
    ? value.visitedTabs.filter(
        (section): section is LessonSectionKey =>
          typeof section === "string" && LESSON_SECTION_KEYS.includes(section as LessonSectionKey),
      )
    : [];
  return {
    success: true,
    data: {
      ...emptyLessonProgress(lesson.id, timestamp),
      quizItems,
      visitedSections,
    },
    diagnostics,
  };
}
