import { validateCanonicalLesson } from "../../lib/lesson-schema";
import { validateLessonProgress } from "../../lib/lesson-progress";
import type { Lesson } from "../../types/lesson";
import type { LessonProgressPayload, LessonSource } from "./domain";
import { StorageError } from "./errors";

const MAX_JSON_CHARS = 2_000_000;
const MAX_ID_CHARS = 128;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function assertValidId(id: string): void { if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > MAX_ID_CHARS) throw new StorageError("VALIDATION_ERROR", "Lesson ID không hợp lệ."); }
export function assertValidLesson(value: unknown): asserts value is Lesson {
  const result = validateCanonicalLesson(value);
  if (!result.success) throw new StorageError("VALIDATION_ERROR", result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("; "));
  if (JSON.stringify(value).length > MAX_JSON_CHARS) throw new StorageError("VALIDATION_ERROR", "Lesson vượt quá kích thước cho phép.");
}
export function assertValidProgress(value: unknown): asserts value is LessonProgressPayload {
  const result = validateLessonProgress(value);
  if (!result.success) throw new StorageError("VALIDATION_ERROR", result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("; "));
  if (JSON.stringify(value).length > MAX_JSON_CHARS) throw new StorageError("VALIDATION_ERROR", "Progress vượt quá kích thước cho phép.");
}
export function normalizeSource(value: unknown): LessonSource {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new StorageError("VALIDATION_ERROR", "Lesson source không hợp lệ.");
  const source: LessonSource = {};
  for (const field of ["title", "url", "channel", "originalTranscript", "processedTranscript"] as const) {
    const item = value[field]; if (item !== undefined && typeof item !== "string") throw new StorageError("VALIDATION_ERROR", `Lesson source ${field} không hợp lệ.`); if (typeof item === "string") source[field] = item;
  }
  if (value.wasTruncated !== undefined && typeof value.wasTruncated !== "boolean") throw new StorageError("VALIDATION_ERROR", "wasTruncated không hợp lệ.");
  if (typeof value.wasTruncated === "boolean") source.wasTruncated = value.wasTruncated;
  return source;
}
