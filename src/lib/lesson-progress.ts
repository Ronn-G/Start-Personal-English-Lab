import type { Diagnostic } from "./lesson-schema";
import type { Lesson } from "../types/lesson";

export const CURRENT_PROGRESS_SCHEMA_VERSION = 1;
export type LearningStatus = "new" | "learning" | "learned";
export interface QuizItemProgress { itemId: string; selectedAnswer: number; correct: boolean; attemptCount: number; answeredAt: string; completed: boolean }
export interface LearningItemProgress { itemId: string; status: LearningStatus; updatedAt: string; userSelected: boolean }
export interface PracticeHistoryItem { id: string; itemId?: string; mode: "writing" | "speaking" | "shadowing" | "other"; occurredAt: string; feedback?: unknown }
export interface LessonProgress {
  lessonId: string;
  progressVersion: typeof CURRENT_PROGRESS_SCHEMA_VERSION;
  quizItems: Record<string, QuizItemProgress>;
  learningItems: Record<string, LearningItemProgress>;
  visitedSections: string[];
  practiceHistory: PracticeHistoryItem[];
  createdAt: string;
  updatedAt: string;
}
export interface ProgressResult { success: boolean; data?: LessonProgress; diagnostics: Diagnostic[] }
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const iso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const error = (code: string, path: string, message: string): Diagnostic => ({ code, path, message, severity: "error" });

export function validateLessonProgress(value: unknown): ProgressResult {
  const diagnostics: Diagnostic[] = [];
  if (!record(value)) return { success: false, diagnostics: [error("INVALID_TYPE", "$", "Progress phải là JSON object.")] };
  if (typeof value.lessonId !== "string" || !value.lessonId) diagnostics.push(error("INVALID_FIELD", "$.lessonId", "lessonId không hợp lệ."));
  if (value.progressVersion !== CURRENT_PROGRESS_SCHEMA_VERSION) diagnostics.push(error("UNSUPPORTED_PROGRESS_VERSION", "$.progressVersion", `Chỉ hỗ trợ progress version ${CURRENT_PROGRESS_SCHEMA_VERSION}.`));
  if (!record(value.quizItems)) diagnostics.push(error("INVALID_TYPE", "$.quizItems", "quizItems phải là object theo item ID."));
  else for (const [id, item] of Object.entries(value.quizItems)) {
    if (!record(item) || item.itemId !== id || !Number.isInteger(item.selectedAnswer) || ![0,1,2,3].includes(Number(item.selectedAnswer)) || typeof item.correct !== "boolean" || !Number.isInteger(item.attemptCount) || Number(item.attemptCount) < 1 || !iso(item.answeredAt) || typeof item.completed !== "boolean") diagnostics.push(error("INVALID_QUIZ_PROGRESS", `$.quizItems.${id}`, "Quiz progress item không hợp lệ."));
  }
  if (!record(value.learningItems)) diagnostics.push(error("INVALID_TYPE", "$.learningItems", "learningItems phải là object theo item ID."));
  else for (const [id, item] of Object.entries(value.learningItems)) if (!record(item) || item.itemId !== id || !["new","learning","learned"].includes(String(item.status)) || !iso(item.updatedAt) || typeof item.userSelected !== "boolean") diagnostics.push(error("INVALID_LEARNING_PROGRESS", `$.learningItems.${id}`, "Learning progress item không hợp lệ."));
  if (!Array.isArray(value.visitedSections) || value.visitedSections.some((x) => typeof x !== "string")) diagnostics.push(error("INVALID_TYPE", "$.visitedSections", "visitedSections không hợp lệ."));
  if (!Array.isArray(value.practiceHistory)) diagnostics.push(error("INVALID_TYPE", "$.practiceHistory", "practiceHistory không hợp lệ."));
  if (!iso(value.createdAt) || !iso(value.updatedAt)) diagnostics.push(error("INVALID_TIMESTAMP", "$", "Timestamp progress không hợp lệ."));
  return { success: diagnostics.length === 0, data: diagnostics.length ? undefined : value as unknown as LessonProgress, diagnostics };
}

export function migrateLegacyProgress(value: unknown, lesson: Lesson, timestamp = lesson.createdAt): ProgressResult {
  const diagnostics: Diagnostic[] = [];
  if (!record(value)) return { success: false, diagnostics: [error("INVALID_TYPE", "$", "Legacy progress phải là JSON object.")] };
  const answered = value.answeredQuestions;
  if (answered !== undefined && !Array.isArray(answered)) return { success: false, diagnostics: [error("INVALID_TYPE", "$.answeredQuestions", "answeredQuestions phải là array index.")] };
  const quizItems: Record<string, QuizItemProgress> = {};
  for (const raw of new Set(Array.isArray(answered) ? answered : [])) {
    if (!Number.isInteger(raw)) { diagnostics.push({ ...error("INVALID_INDEX", "$.answeredQuestions", `Bỏ qua index sai kiểu: ${String(raw)}.`), severity: "warning" }); continue; }
    const question = lesson.quiz[Number(raw)];
    if (!question) { diagnostics.push({ ...error("INDEX_OUT_OF_RANGE", "$.answeredQuestions", `Bỏ qua quiz index ngoài phạm vi: ${raw}.`), severity: "warning" }); continue; }
    quizItems[question.id] = { itemId: question.id, selectedAnswer: question.correctAnswer, correct: true, attemptCount: 1, answeredAt: timestamp, completed: true };
  }
  const data: LessonProgress = { lessonId: lesson.id, progressVersion: CURRENT_PROGRESS_SCHEMA_VERSION, quizItems, learningItems: {}, visitedSections: Array.isArray(value.visitedTabs) ? value.visitedTabs.filter((x): x is string => typeof x === "string") : [], practiceHistory: [], createdAt: timestamp, updatedAt: timestamp };
  return { success: true, data, diagnostics };
}
