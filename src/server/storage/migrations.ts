import type { DatabaseSync } from "node:sqlite";

import { StorageError } from "./errors";

export interface Migration {
  version: number;
  name: string;
  up(database: DatabaseSync): void;
}

export const CURRENT_DATABASE_VERSION = 1;

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
