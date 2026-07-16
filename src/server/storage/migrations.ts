import type { DatabaseSync } from "node:sqlite";
import { migrateLegacyProgress, validateLessonProgress } from "../../lib/lesson-progress";
import { normalizeLesson } from "../../lib/lesson-schema";

import { StorageError } from "./errors";

export interface Migration {
  version: number;
  name: string;
  up(database: DatabaseSync): void;
}

export const CURRENT_DATABASE_VERSION = 4;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_storage_schema",
    up(database) {
      database.exec(`
        CREATE TABLE app_metadata (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE lessons (
          id TEXT PRIMARY KEY NOT NULL,
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          lesson_depth TEXT,
          lesson_json TEXT NOT NULL CHECK (json_valid(lesson_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          source_title TEXT,
          source_url TEXT,
          source_channel TEXT,
          original_transcript TEXT,
          processed_transcript TEXT,
          was_truncated INTEGER NOT NULL DEFAULT 0 CHECK (was_truncated IN (0, 1)),
          deleted_at TEXT
        ) STRICT;

        CREATE INDEX lessons_updated_at_idx
          ON lessons(deleted_at, updated_at DESC);

        CREATE TABLE lesson_progress (
          lesson_id TEXT PRIMARY KEY NOT NULL,
          progress_version INTEGER NOT NULL CHECK (progress_version > 0),
          progress_json TEXT NOT NULL CHECK (json_valid(progress_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    name: "canonical_lesson_and_progress_documents",
    up(database) {
      const rows = database.prepare("SELECT id, lesson_json, created_at, updated_at FROM lessons").all() as Array<{ id: string; lesson_json: string; created_at: string; updated_at: string }>;
      const updateLesson = database.prepare("UPDATE lessons SET schema_version = 1, lesson_json = ? WHERE id = ?");
      const updateProgress = database.prepare("UPDATE lesson_progress SET progress_version = 1, progress_json = ? WHERE lesson_id = ?");
      for (const row of rows) {
        const normalized = normalizeLesson(JSON.parse(row.lesson_json), { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at });
        if (!normalized.success || !normalized.data) throw new Error(`Không thể migrate lesson ${row.id}: ${normalized.diagnostics.map((d) => d.message).join("; ")}`);
        updateLesson.run(JSON.stringify(normalized.data), row.id);
        const progressRow = database.prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id = ?").get(row.id) as { progress_json: string } | undefined;
        if (!progressRow) continue;
        const rawProgress = JSON.parse(progressRow.progress_json) as unknown;
        const canonical = validateLessonProgress(rawProgress);
        if (canonical.success && canonical.data) updateProgress.run(JSON.stringify(canonical.data), row.id);
        else {
          const migrated = migrateLegacyProgress(rawProgress, normalized.data, row.created_at);
          if (!migrated.success || !migrated.data) throw new Error(`Không thể migrate progress ${row.id}.`);
          updateProgress.run(JSON.stringify(migrated.data), row.id);
        }
      }
    },
  },
  {
    version: 3,
    name: "legacy_localstorage_migration_receipts",
    up(database) {
      database.exec(`
        CREATE TABLE legacy_migration_items (
          migration_id TEXT NOT NULL,
          legacy_fingerprint TEXT NOT NULL,
          lesson_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('migrated', 'existing', 'failed')),
          diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (migration_id, legacy_fingerprint),
          FOREIGN KEY (lesson_id) REFERENCES lessons(id)
        ) STRICT;

        CREATE UNIQUE INDEX legacy_migration_lesson_idx
          ON legacy_migration_items(migration_id, lesson_id);
      `);
    },
  },
  {
    version: 4,
    name: "backup_import_receipts",
    up(database) {
      database.exec(`
        CREATE TABLE import_receipts (
          import_id TEXT PRIMARY KEY NOT NULL,
          imported_at TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('merge', 'replace')),
          lesson_count INTEGER NOT NULL,
          progress_count INTEGER NOT NULL,
          result TEXT NOT NULL CHECK (result IN ('success', 'failed')),
          warning_count INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX import_receipts_fingerprint_idx
          ON import_receipts(source_fingerprint, imported_at DESC);
      `);
    },
  },
];

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return Number(row?.user_version ?? 0);
}

export function runMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  const supportedVersion = migrations.at(-1)?.version ?? 0;
  const currentVersion = readUserVersion(database);

  if (currentVersion > supportedVersion) {
    throw new StorageError(
      "UNSUPPORTED_DATABASE_VERSION",
      `Database schema version ${currentVersion} mới hơn version ${supportedVersion} mà ứng dụng hỗ trợ.`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      migration.up(database);
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO app_metadata(key, value, updated_at)
           VALUES ('schema_version', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(String(migration.version), now);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new StorageError(
        "STORAGE_UNAVAILABLE",
        `Migration ${migration.version} (${migration.name}) thất bại.`,
        { cause: error },
      );
    }
  }

  return readUserVersion(database);
}
