import type { Lesson } from "../../types/lesson";
import type { LessonProgressPayload, LessonSource } from "./domain";
import { StorageError } from "./errors";

const MAX_JSON_CHARS = 2_000_000;
const MAX_ID_CHARS = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertValidId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > MAX_ID_CHARS) {
    throw new StorageError("VALIDATION_ERROR", "Lesson ID không hợp lệ.");
  }
}

export function assertValidLesson(value: unknown): asserts value is Lesson {
  if (!isRecord(value) || !isNonEmptyString(value.title) || !isNonEmptyString(value.summary)) {
    throw new StorageError("VALIDATION_ERROR", "Lesson cần title và summary hợp lệ.");
  }

  for (const field of ["vocabulary", "idiomsAndSlang", "exampleSentences", "quiz"] as const) {
    if (!Array.isArray(value[field])) {
      throw new StorageError("VALIDATION_ERROR", `Lesson thiếu mảng ${field}.`);
    }
  }

  if (JSON.stringify(value).length > MAX_JSON_CHARS) {
    throw new StorageError("VALIDATION_ERROR", "Lesson vượt quá kích thước lưu trữ cho phép.");
  }
}

export function assertValidProgress(
  value: unknown,
): asserts value is LessonProgressPayload {
  if (!isRecord(value)) {
    throw new StorageError("VALIDATION_ERROR", "Progress phải là một JSON object.");
  }

  if (
    value.answeredQuestions !== undefined &&
    (!Array.isArray(value.answeredQuestions) ||
      value.answeredQuestions.some((item) => !Number.isInteger(item) || Number(item) < 0))
  ) {
    throw new StorageError("VALIDATION_ERROR", "answeredQuestions không hợp lệ.");
  }

  if (JSON.stringify(value).length > MAX_JSON_CHARS) {
    throw new StorageError("VALIDATION_ERROR", "Progress vượt quá kích thước lưu trữ cho phép.");
  }
}

export function normalizeSource(value: unknown): LessonSource {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new StorageError("VALIDATION_ERROR", "Lesson source không hợp lệ.");
  }

  const stringFields = [
    "title",
    "url",
    "channel",
    "originalTranscript",
    "processedTranscript",
  ] as const;
  const source: LessonSource = {};
  for (const field of stringFields) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      throw new StorageError("VALIDATION_ERROR", `Lesson source ${field} không hợp lệ.`);
    }
    if (typeof fieldValue === "string") source[field] = fieldValue;
  }

  if (value.wasTruncated !== undefined && typeof value.wasTruncated !== "boolean") {
    throw new StorageError("VALIDATION_ERROR", "Lesson source wasTruncated không hợp lệ.");
  }
  if (typeof value.wasTruncated === "boolean") source.wasTruncated = value.wasTruncated;
  return source;
}
