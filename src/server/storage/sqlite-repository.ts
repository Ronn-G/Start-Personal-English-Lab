import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Lesson } from "../../types/lesson";
import {
  LESSON_SCHEMA_VERSION,
  PROGRESS_SCHEMA_VERSION,
  type CreateLessonInput,
  type LessonProgressPayload,
  type LessonSummary,
  type LessonSource,
  type StorageRepository,
  type StoredLesson,
  type StoredLessonProgress,
  type UpdateLessonInput,
} from "./domain";
import { StorageError } from "./errors";
import {
  assertValidId,
  assertValidLesson,
  assertValidProgress,
  normalizeSource,
} from "./validation";

interface LessonRow {
  id: string;
  schema_version: number;
  title: string;
  summary: string;
  lesson_depth: string | null;
  lesson_json: string;
  created_at: string;
  updated_at: string;
  source_title: string | null;
  source_url: string | null;
  source_channel: string | null;
  original_transcript: string | null;
  processed_transcript: string | null;
  was_truncated: number;
  deleted_at: string | null;
}

interface ProgressRow {
  lesson_id: string;
  progress_version: number;
  progress_json: string;
  created_at: string;
  updated_at: string;
}

function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

export function mapLessonRow(row: LessonRow): StoredLesson {
  const lesson = JSON.parse(row.lesson_json) as Lesson;
  assertValidLesson(lesson);
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    title: row.title,
    summary: row.summary,
    lessonDepth: optional(row.lesson_depth),
    lesson,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: {
      title: optional(row.source_title),
      url: optional(row.source_url),
      channel: optional(row.source_channel),
      originalTranscript: optional(row.original_transcript),
      processedTranscript: optional(row.processed_transcript),
      wasTruncated: Boolean(row.was_truncated),
    },
    deletedAt: optional(row.deleted_at),
  };
}

function mapProgressRow(row: ProgressRow): StoredLessonProgress {
  const progress = JSON.parse(row.progress_json) as LessonProgressPayload;
  assertValidProgress(progress);
  return {
    lessonId: row.lesson_id,
    progressVersion: row.progress_version,
    progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sourceParameters(source: LessonSource): unknown[] {
  return [
    source.title ?? null,
    source.url ?? null,
    source.channel ?? null,
    source.originalTranscript ?? null,
    source.processedTranscript ?? null,
    source.wasTruncated ? 1 : 0,
  ];
}

export class SqliteStorageRepository implements StorageRepository {
  constructor(private readonly database: DatabaseSync) {}

  async listLessons(): Promise<LessonSummary[]> {
    const rows = this.database
      .prepare("SELECT id, schema_version, title, summary, created_at, updated_at FROM lessons WHERE deleted_at IS NULL ORDER BY updated_at DESC")
      .all() as Array<{ id: string; schema_version: number; title: string; summary: string; created_at: string; updated_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      schemaVersion: row.schema_version,
      title: row.title,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getLesson(id: string): Promise<StoredLesson | null> {
    assertValidId(id);
    const row = this.database
      .prepare("SELECT * FROM lessons WHERE id = ? AND deleted_at IS NULL")
      .get(id) as LessonRow | undefined;
    return row ? mapLessonRow(row) : null;
  }

  async createLesson(input: CreateLessonInput): Promise<StoredLesson> {
    assertValidLesson(input.lesson);
    const source = normalizeSource(input.source);
    if (input.initialProgress !== undefined) assertValidProgress(input.initialProgress);

    const id = input.id ?? input.lesson.id ?? randomUUID();
    assertValidId(id);
    if (input.lesson.id !== id) throw new StorageError("VALIDATION_ERROR", "Lesson document ID phải khớp database record ID.");
    const now = new Date().toISOString();
    const schemaVersion = input.schemaVersion ?? LESSON_SCHEMA_VERSION;
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw new StorageError("VALIDATION_ERROR", "Lesson schema version không hợp lệ.");
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO lessons(
            id, schema_version, title, summary, lesson_depth, lesson_json,
            created_at, updated_at, source_title, source_url, source_channel,
            original_transcript, processed_transcript, was_truncated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          schemaVersion,
          input.lesson.title.trim(),
          input.lesson.summary.trim(),
          input.lessonDepth ?? null,
          JSON.stringify(input.lesson),
          now,
          now,
          ...sourceParameters(source),
        );

      if (input.initialProgress !== undefined) {
        this.insertProgress(id, input.initialProgress, PROGRESS_SCHEMA_VERSION, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new StorageError("CONFLICT", "Lesson ID đã tồn tại.", { cause: error });
      }
      throw error;
    }

    return (await this.getLesson(id)) as StoredLesson;
  }

  async updateLesson(id: string, input: UpdateLessonInput): Promise<StoredLesson> {
    assertValidId(id);
    const existing = await this.getLesson(id);
    if (!existing) throw new StorageError("NOT_FOUND", "Không tìm thấy lesson.");

    const lesson = input.lesson ?? existing.lesson;
    assertValidLesson(lesson);
    const source = input.source
      ? { ...existing.source, ...normalizeSource(input.source) }
      : existing.source;
    const schemaVersion = input.schemaVersion ?? existing.schemaVersion;
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw new StorageError("VALIDATION_ERROR", "Lesson schema version không hợp lệ.");
    }
    const updatedAt = new Date().toISOString();

    this.database
      .prepare(
        `UPDATE lessons SET
          schema_version = ?, title = ?, summary = ?, lesson_depth = ?, lesson_json = ?,
          updated_at = ?, source_title = ?, source_url = ?, source_channel = ?,
          original_transcript = ?, processed_transcript = ?, was_truncated = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(
        schemaVersion,
        lesson.title.trim(),
        lesson.summary.trim(),
        input.lessonDepth === null
          ? null
          : (input.lessonDepth ?? existing.lessonDepth ?? null),
        JSON.stringify(lesson),
        updatedAt,
        ...sourceParameters(source),
        id,
      );

    return (await this.getLesson(id)) as StoredLesson;
  }

  async deleteLesson(id: string): Promise<void> {
    assertValidId(id);
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        "UPDATE lessons SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now, now, id);
    if (Number(result.changes) === 0) {
      throw new StorageError("NOT_FOUND", "Không tìm thấy lesson.");
    }
  }

  async getLessonProgress(lessonId: string): Promise<StoredLessonProgress | null> {
    assertValidId(lessonId);
    const row = this.database
      .prepare(
        `SELECT p.* FROM lesson_progress p
         JOIN lessons l ON l.id = p.lesson_id
         WHERE p.lesson_id = ? AND l.deleted_at IS NULL`,
      )
      .get(lessonId) as ProgressRow | undefined;
    return row ? mapProgressRow(row) : null;
  }

  async saveLessonProgress(
    lessonId: string,
    progress: LessonProgressPayload,
    progressVersion = PROGRESS_SCHEMA_VERSION,
  ): Promise<StoredLessonProgress> {
    assertValidId(lessonId);
    assertValidProgress(progress);
    if (progress.lessonId !== lessonId) throw new StorageError("VALIDATION_ERROR", "Progress lessonId không khớp lesson.");
    if (!Number.isInteger(progressVersion) || progressVersion < 1) {
      throw new StorageError("VALIDATION_ERROR", "Progress version không hợp lệ.");
    }
    if (!(await this.getLesson(lessonId))) {
      throw new StorageError("NOT_FOUND", "Không tìm thấy lesson.");
    }

    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO lesson_progress(
          lesson_id, progress_version, progress_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(lesson_id) DO UPDATE SET
          progress_version = excluded.progress_version,
          progress_json = excluded.progress_json,
          updated_at = excluded.updated_at`,
      )
      .run(lessonId, progressVersion, JSON.stringify(progress), now, now);
    return (await this.getLessonProgress(lessonId)) as StoredLessonProgress;
  }

  async getSetting(key: string): Promise<string | null> {
    if (!key.trim()) throw new StorageError("VALIDATION_ERROR", "Setting key không hợp lệ.");
    const row = this.database
      .prepare("SELECT value FROM app_metadata WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    if (!key.trim() || typeof value !== "string") {
      throw new StorageError("VALIDATION_ERROR", "Setting không hợp lệ.");
    }
    this.database
      .prepare(
        `INSERT INTO app_metadata(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  private insertProgress(
    lessonId: string,
    progress: LessonProgressPayload,
    progressVersion: number,
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO lesson_progress(
          lesson_id, progress_version, progress_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(lessonId, progressVersion, JSON.stringify(progress), now, now);
  }
}
