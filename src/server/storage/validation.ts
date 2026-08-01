import { validateCanonicalLesson } from "../../lib/lesson-schema";
import { validateLessonProgress } from "../../lib/lesson-progress";
import type { Lesson } from "../../types/lesson";
import type { LessonProgressPayload, LessonSource } from "./domain";
import { StorageError } from "./errors";

const MAX_JSON_CHARS = 2_000_000;
const MAX_ID_CHARS = 128;
const SOURCE_LABEL_CHARS = 500;
const SOURCE_URL_CHARS = 2_048;
const SOURCE_TRANSCRIPT_CHARS = 2_000_000;
const SOURCE_TRANSCRIPT_BYTES = 4_000_000;
const SOURCE_KEYS = new Set([
  "title",
  "url",
  "channel",
  "originalTranscript",
  "processedTranscript",
  "wasTruncated",
]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function assertValidId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > MAX_ID_CHARS)
    throw new StorageError("VALIDATION_ERROR", "Lesson ID không hợp lệ.");
}
export function assertValidLesson(value: unknown): asserts value is Lesson {
  const result = validateCanonicalLesson(value);
  if (!result.success)
    throw new StorageError(
      "VALIDATION_ERROR",
      result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("; "),
    );
  if (JSON.stringify(value).length > MAX_JSON_CHARS)
    throw new StorageError("VALIDATION_ERROR", "Lesson vượt quá kích thước cho phép.");
}
export function assertValidProgress(value: unknown): asserts value is LessonProgressPayload {
  const result = validateLessonProgress(value);
  if (!result.success)
    throw new StorageError(
      "VALIDATION_ERROR",
      result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("; "),
    );
  if (JSON.stringify(value).length > MAX_JSON_CHARS)
    throw new StorageError("VALIDATION_ERROR", "Progress vượt quá kích thước cho phép.");
}
export function normalizeSource(value: unknown): LessonSource {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new StorageError("VALIDATION_ERROR", "Lesson source không hợp lệ.");
  if (Object.keys(value).some((key) => !SOURCE_KEYS.has(key)))
    throw new StorageError("VALIDATION_ERROR", "Lesson source có field không được hỗ trợ.");
  const source: LessonSource = {};
  for (const field of [
    "title",
    "url",
    "channel",
    "originalTranscript",
    "processedTranscript",
  ] as const) {
    const item = value[field];
    if (item !== undefined && typeof item !== "string")
      throw new StorageError("VALIDATION_ERROR", `Lesson source ${field} không hợp lệ.`);
    if (typeof item === "string") source[field] = item;
  }
  for (const field of ["title", "channel"] as const)
    if (source[field] !== undefined && source[field]!.length > SOURCE_LABEL_CHARS)
      throw new StorageError("VALIDATION_ERROR", `Lesson source ${field} quá dài.`);
  if (source.url !== undefined) {
    if (source.url.length > SOURCE_URL_CHARS)
      throw new StorageError("VALIDATION_ERROR", "Lesson source url quá dài.");
    try {
      const parsed = new URL(source.url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("protocol");
    } catch {
      throw new StorageError("VALIDATION_ERROR", "Lesson source url phải là HTTP(S) hợp lệ.");
    }
  }
  for (const field of ["originalTranscript", "processedTranscript"] as const) {
    const transcript = source[field];
    if (
      transcript !== undefined &&
      (transcript.length > SOURCE_TRANSCRIPT_CHARS ||
        new TextEncoder().encode(transcript).byteLength > SOURCE_TRANSCRIPT_BYTES)
    )
      throw new StorageError("VALIDATION_ERROR", `Lesson source ${field} quá dài.`);
    if (transcript !== undefined && /^data:audio\//i.test(transcript.trim()))
      throw new StorageError("VALIDATION_ERROR", "Lesson source không được chứa audio/base64.");
  }
  if (value.wasTruncated !== undefined && typeof value.wasTruncated !== "boolean")
    throw new StorageError("VALIDATION_ERROR", "wasTruncated không hợp lệ.");
  if (typeof value.wasTruncated === "boolean") source.wasTruncated = value.wasTruncated;
  return source;
}
