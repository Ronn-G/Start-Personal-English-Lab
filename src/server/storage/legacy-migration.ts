import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  migrateLegacyProgress,
  normalizeLessonProgress,
  type LessonProgress,
} from "../../lib/lesson-progress";
import { normalizeLesson, validateCanonicalLesson, type Diagnostic } from "../../lib/lesson-schema";
import type { LegacyMigrationRecord } from "../../lib/legacy-storage-reader";
import type { Lesson } from "../../types/lesson";
import { StorageError } from "./errors";

export const LEGACY_MIGRATION_ID = "localstorage-lessons-v1";
const METADATA_KEY = `migration:${LEGACY_MIGRATION_ID}`;
export type MigrationState =
  | "not-started"
  | "preview-ready"
  | "in-progress"
  | "completed"
  | "completed-with-warnings"
  | "failed"
  | "skipped";

export interface MigrationStatus {
  migrationId: string;
  version: 1;
  status: MigrationState;
  startedAt?: string;
  completedAt?: string;
  detectedLessons: number;
  migratedLessons: number;
  skippedLessons: number;
  warningCount: number;
  fingerprintCount: number;
}

export interface MigrationPreviewItem {
  index: number;
  fingerprint?: string;
  lessonId?: string;
  title?: string;
  outcome: "valid" | "existing" | "invalid";
  progressConverted: boolean;
  diagnostics: Diagnostic[];
  lesson?: Lesson;
  progress?: LessonProgress;
}

export interface MigrationPreview {
  migrationId: string;
  detectedLessons: number;
  validLessons: number;
  existingLessons: number;
  invalidLessons: number;
  convertedProgress: number;
  warningCount: number;
  items: MigrationPreviewItem[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !["id", "schemaVersion", "createdAt", "updatedAt"].includes(key))
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function lessonFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function deterministicUuid(seed: string): () => string {
  let sequence = 0;
  return () => {
    const hex = createHash("sha256")
      .update(`${seed}:${sequence++}`)
      .digest("hex")
      .slice(0, 32)
      .split("");
    hex[12] = "5";
    hex[16] = (["8", "9", "a", "b"] as const)[Number.parseInt(hex[16], 16) % 4];
    return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
  };
}

function existingContent(database: DatabaseSync): Map<string, { id: string; lesson: Lesson }> {
  const rows = database
    .prepare("SELECT id, lesson_json FROM lessons WHERE deleted_at IS NULL")
    .all() as Array<{ id: string; lesson_json: string }>;
  const result = new Map<string, { id: string; lesson: Lesson }>();
  for (const row of rows) {
    const lesson = JSON.parse(row.lesson_json) as Lesson;
    result.set(lessonFingerprint(lesson), { id: row.id, lesson });
  }
  return result;
}

export function previewLegacyMigration(
  database: DatabaseSync,
  records: LegacyMigrationRecord[],
): MigrationPreview {
  const mappings = new Map(
    (
      database
        .prepare(
          "SELECT legacy_fingerprint, lesson_id FROM legacy_migration_items WHERE migration_id = ?",
        )
        .all(LEGACY_MIGRATION_ID) as Array<{ legacy_fingerprint: string; lesson_id: string }>
    ).map((row) => [row.legacy_fingerprint, row.lesson_id]),
  );
  const content = existingContent(database);
  const seen = new Set<string>();
  const items = records.map((source, index): MigrationPreviewItem => {
    if (!record(source.lesson))
      return {
        index,
        outcome: "invalid",
        progressConverted: false,
        diagnostics: [
          {
            code: "INVALID_LESSON",
            path: `$.records[${index}].lesson`,
            message: "Lesson legacy không hợp lệ.",
            severity: "error",
          },
        ],
      };
    const fingerprint = lessonFingerprint(source.lesson);
    if (seen.has(fingerprint))
      return {
        index,
        fingerprint,
        outcome: "existing",
        progressConverted: false,
        diagnostics: [
          {
            code: "DUPLICATE_IN_PAYLOAD",
            path: `$.records[${index}]`,
            message: "Bài trùng trong payload; chỉ migrate một lần.",
            severity: "warning",
          },
        ],
      };
    seen.add(fingerprint);
    const contentMatch = content.get(fingerprint);
    const knownId = mappings.get(fingerprint) ?? contentMatch?.id;
    const generateId = deterministicUuid(fingerprint);
    const lessonId = knownId ?? generateId();
    const normalized = normalizeLesson(source.lesson, {
      id: lessonId,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      generateId,
    });
    if (!normalized.success || !normalized.data)
      return {
        index,
        fingerprint,
        lessonId,
        outcome: "invalid",
        progressConverted: false,
        diagnostics: normalized.diagnostics,
      };
    // Missing IDs are the expected legacy shape. Keep repairs and validation
    // diagnostics, but do not turn every normal import into a warning result.
    const diagnostics = normalized.diagnostics.filter((item) => item.code !== "ASSIGNED_ITEM_ID");
    if (source.progressUnreadable) {
      diagnostics.push({
        code: "MALFORMED_LEGACY_PROGRESS",
        path: `$.records[${index}].progress`,
        message:
          "Progress legacy không đọc được; lesson vẫn được kiểm tra nhưng progress bị bỏ qua.",
        severity: "warning",
      });
    }
    let canonicalLesson = normalized.data;
    if (knownId) {
      const row = database
        .prepare("SELECT lesson_json FROM lessons WHERE id=? AND deleted_at IS NULL")
        .get(knownId) as { lesson_json: string } | undefined;
      if (!row)
        return {
          index,
          fingerprint,
          lessonId,
          outcome: "invalid",
          progressConverted: false,
          diagnostics: [
            {
              code: "MISSING_MAPPED_LESSON",
              path: `$.records[${index}]`,
              message: "Receipt migration trỏ tới lesson không còn tồn tại.",
              severity: "error",
            },
          ],
        };
      canonicalLesson = JSON.parse(row.lesson_json) as Lesson;
    }
    let progress: LessonProgress | undefined;
    if (source.progress !== undefined) {
      const canonical = normalizeLessonProgress(source.progress, lessonId);
      if (canonical.success && canonical.data && canonical.data.lessonId === lessonId)
        progress = canonical.data;
      else {
        const migrated = migrateLegacyProgress(
          source.progress,
          canonicalLesson,
          source.updatedAt ?? source.createdAt ?? canonicalLesson.createdAt,
        );
        diagnostics.push(...migrated.diagnostics);
        if (migrated.success) progress = migrated.data;
        else diagnostics.push(...migrated.diagnostics);
      }
    }
    return {
      index,
      fingerprint,
      lessonId,
      title: canonicalLesson.title,
      outcome: knownId ? "existing" : "valid",
      progressConverted: Boolean(progress),
      diagnostics,
      lesson: canonicalLesson,
      progress,
    };
  });
  return {
    migrationId: LEGACY_MIGRATION_ID,
    detectedLessons: records.length,
    validLessons: items.filter((item) => item.outcome === "valid").length,
    existingLessons: items.filter((item) => item.outcome === "existing").length,
    invalidLessons: items.filter((item) => item.outcome === "invalid").length,
    convertedProgress: items.filter((item) => item.progressConverted).length,
    warningCount: items
      .flatMap((item) => item.diagnostics)
      .filter((item) => item.severity === "warning").length,
    items,
  };
}

function writeStatus(database: DatabaseSync, status: MigrationStatus, now: string): void {
  database
    .prepare(
      `INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    )
    .run(METADATA_KEY, JSON.stringify(status), now);
}

export function getLegacyMigrationStatus(database: DatabaseSync): MigrationStatus {
  const row = database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(METADATA_KEY) as
    { value: string } | undefined;
  if (row) return JSON.parse(row.value) as MigrationStatus;
  return {
    migrationId: LEGACY_MIGRATION_ID,
    version: 1,
    status: "not-started",
    detectedLessons: 0,
    migratedLessons: 0,
    skippedLessons: 0,
    warningCount: 0,
    fingerprintCount: 0,
  };
}

export function commitLegacyMigration(
  database: DatabaseSync,
  records: LegacyMigrationRecord[],
): { preview: MigrationPreview; status: MigrationStatus } {
  const startedAt = new Date().toISOString();
  let preview: MigrationPreview | undefined;
  database.exec("BEGIN IMMEDIATE");
  try {
    // Preview under the write lock so concurrent retries observe committed receipts.
    preview = previewLegacyMigration(database, records);
    const current = getLegacyMigrationStatus(database);
    if (current.status === "in-progress")
      throw new StorageError("CONFLICT", "Migration đang được xử lý.");
    writeStatus(
      database,
      { ...current, status: "in-progress", startedAt, detectedLessons: records.length },
      startedAt,
    );
    const insertLesson = database.prepare(
      `INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)`,
    );
    const insertProgress = database.prepare(
      `INSERT INTO lesson_progress(lesson_id,progress_version,progress_json,created_at,updated_at) VALUES(?,1,?,?,?) ON CONFLICT(lesson_id) DO UPDATE SET progress_json=excluded.progress_json,updated_at=excluded.updated_at`,
    );
    const insertReceipt = database.prepare(
      `INSERT INTO legacy_migration_items(migration_id,legacy_fingerprint,lesson_id,status,diagnostics_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(migration_id,legacy_fingerprint) DO UPDATE SET lesson_id=excluded.lesson_id,status=excluded.status,diagnostics_json=excluded.diagnostics_json,updated_at=excluded.updated_at`,
    );
    let migrated = 0;
    for (const item of preview.items) {
      if (!item.fingerprint || !item.lessonId || !item.lesson || item.outcome === "invalid")
        continue;
      if (item.outcome === "valid") {
        insertLesson.run(
          item.lessonId,
          item.lesson.schemaVersion,
          item.lesson.title,
          item.lesson.summary,
          JSON.stringify(item.lesson),
          item.lesson.createdAt,
          item.lesson.updatedAt,
        );
        migrated += 1;
      }
      if (item.progress)
        insertProgress.run(
          item.lessonId,
          JSON.stringify(item.progress),
          item.progress.createdAt,
          item.progress.updatedAt,
        );
      insertReceipt.run(
        LEGACY_MIGRATION_ID,
        item.fingerprint,
        item.lessonId,
        item.outcome === "valid" ? "migrated" : "existing",
        JSON.stringify(item.diagnostics),
        startedAt,
        startedAt,
      );
      const stored = database
        .prepare("SELECT lesson_json FROM lessons WHERE id=? AND deleted_at IS NULL")
        .get(item.lessonId) as { lesson_json: string } | undefined;
      if (!stored || !validateCanonicalLesson(JSON.parse(stored.lesson_json)).success)
        throw new Error(`Verify lesson ${item.lessonId} failed.`);
      const verifiedLesson = JSON.parse(stored.lesson_json) as Lesson;
      if (
        verifiedLesson.title !== item.lesson.title ||
        verifiedLesson.vocabulary.length !== item.lesson.vocabulary.length ||
        verifiedLesson.quiz.length !== item.lesson.quiz.length ||
        verifiedLesson.quiz.some((question, index) => question.id !== item.lesson?.quiz[index]?.id)
      )
        throw new Error(`Verify lesson identity ${item.lessonId} failed.`);
      if (item.progress) {
        const storedProgress = database
          .prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?")
          .get(item.lessonId) as { progress_json: string } | undefined;
        if (
          !storedProgress ||
          !normalizeLessonProgress(JSON.parse(storedProgress.progress_json), item.lessonId).success
        )
          throw new Error(`Verify progress ${item.lessonId} failed.`);
        const verifiedProgress = JSON.parse(storedProgress.progress_json) as LessonProgress;
        if (
          Object.keys(item.progress.quizItems).some(
            (id) =>
              !verifiedProgress.quizItems[id] ||
              !verifiedLesson.quiz.some((question) => question.id === id),
          )
        )
          throw new Error(`Verify answered quiz mapping ${item.lessonId} failed.`);
      }
    }
    const completedAt = new Date().toISOString();
    const skipped = preview.invalidLessons + preview.existingLessons;
    const warningCount = preview.warningCount + preview.invalidLessons;
    const status: MigrationStatus = {
      migrationId: LEGACY_MIGRATION_ID,
      version: 1,
      status: warningCount ? "completed-with-warnings" : "completed",
      startedAt,
      completedAt,
      detectedLessons: records.length,
      migratedLessons: migrated,
      skippedLessons: skipped,
      warningCount,
      fingerprintCount: preview.items.filter((item) => item.fingerprint).length,
    };
    writeStatus(database, status, completedAt);
    database.exec("COMMIT");
    return { preview, status };
  } catch (error) {
    database.exec("ROLLBACK");
    const failedAt = new Date().toISOString();
    writeStatus(
      database,
      {
        migrationId: LEGACY_MIGRATION_ID,
        version: 1,
        status: "failed",
        startedAt,
        completedAt: failedAt,
        detectedLessons: records.length,
        migratedLessons: 0,
        skippedLessons: records.length,
        warningCount: (preview?.warningCount ?? 0) + (preview?.invalidLessons ?? 0),
        fingerprintCount: preview?.items.filter((item) => item.fingerprint).length ?? 0,
      },
      failedAt,
    );
    throw error;
  }
}
