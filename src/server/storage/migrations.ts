import type { DatabaseSync } from "node:sqlite";
import { createListeningSessionSnapshot } from "../../lib/listening-practice";
import { migrateLegacyProgress, normalizeLessonProgress } from "../../lib/lesson-progress";
import { normalizeLesson } from "../../lib/lesson-schema";
import type { Lesson } from "../../types/lesson";

import { StorageError } from "./errors";

export interface Migration {
  version: number;
  name: string;
  up(database: DatabaseSync): void;
}

export const CURRENT_DATABASE_VERSION = 13;

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
      const rows = database
        .prepare("SELECT id, lesson_json, created_at, updated_at FROM lessons")
        .all() as Array<{
        id: string;
        lesson_json: string;
        created_at: string;
        updated_at: string;
      }>;
      const updateLesson = database.prepare(
        "UPDATE lessons SET schema_version = 1, lesson_json = ? WHERE id = ?",
      );
      const updateProgress = database.prepare(
        "UPDATE lesson_progress SET progress_version = 1, progress_json = ? WHERE lesson_id = ?",
      );
      for (const row of rows) {
        const normalized = normalizeLesson(JSON.parse(row.lesson_json), {
          id: row.id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
        if (!normalized.success || !normalized.data)
          throw new Error(
            `Không thể migrate lesson ${row.id}: ${normalized.diagnostics.map((d) => d.message).join("; ")}`,
          );
        updateLesson.run(JSON.stringify(normalized.data), row.id);
        const progressRow = database
          .prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id = ?")
          .get(row.id) as { progress_json: string } | undefined;
        if (!progressRow) continue;
        const rawProgress = JSON.parse(progressRow.progress_json) as unknown;
        const canonical = normalizeLessonProgress(rawProgress, row.id);
        if (canonical.success && canonical.data)
          updateProgress.run(JSON.stringify(canonical.data), row.id);
        else {
          const migrated = migrateLegacyProgress(rawProgress, normalized.data, row.created_at);
          if (!migrated.success || !migrated.data)
            throw new Error(`Không thể migrate progress ${row.id}.`);
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
  {
    version: 5,
    name: "audio_cache_metadata",
    up(database) {
      database.exec(`CREATE TABLE audio_cache (
        cache_key TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('generating','ready','failed','stale')),
        relative_path TEXT, size_bytes INTEGER,
        voice TEXT NOT NULL, speed REAL NOT NULL, language TEXT NOT NULL,
        model_version TEXT NOT NULL, normalization_version INTEGER NOT NULL,
        format TEXT NOT NULL, created_at TEXT, updated_at TEXT NOT NULL,
        last_accessed_at TEXT, failure_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT
      ) STRICT;
      CREATE INDEX audio_cache_lru_idx ON audio_cache(status,last_accessed_at);`);
    },
  },
  {
    version: 6,
    name: "guided_speaking_ladder",
    up(database) {
      database.exec(`
      CREATE TABLE speaking_progress (
        lesson_id TEXT NOT NULL, practice_item_id TEXT NOT NULL, source_type TEXT NOT NULL, source_item_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('new','practicing','recalled_with_help','recalled','personalized')),
        attempt_count INTEGER NOT NULL DEFAULT 0, help_count INTEGER NOT NULL DEFAULT 0,
        show_answer_count INTEGER NOT NULL DEFAULT 0, recalled_count INTEGER NOT NULL DEFAULT 0,
        personalized_count INTEGER NOT NULL DEFAULT 0, self_rating TEXT CHECK(self_rating IN ('hard','okay','easy')),
        first_practiced_at TEXT, last_practiced_at TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(lesson_id,practice_item_id), FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX speaking_progress_last_idx ON speaking_progress(last_practiced_at);
      CREATE TABLE speaking_sessions (
        id TEXT PRIMARY KEY NOT NULL, lesson_id TEXT NOT NULL, item_ids_json TEXT NOT NULL CHECK(json_valid(item_ids_json)), drafts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(drafts_json)), checks_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(checks_json)),
        current_item_index INTEGER NOT NULL DEFAULT 0, current_step TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled')), created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, completed_at TEXT, FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
      ) STRICT;
      CREATE UNIQUE INDEX speaking_one_active_session ON speaking_sessions(lesson_id) WHERE status='active';
      CREATE INDEX speaking_session_active_idx ON speaking_sessions(lesson_id,status,updated_at);
    `);
    },
  },
  {
    version: 7,
    name: "guided_speaking_ladder_compatibility",
    up(database) {
      const progressColumns = new Set(
        (
          database.prepare("PRAGMA table_info(speaking_progress)").all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      const sessionColumns = new Set(
        (
          database.prepare("PRAGMA table_info(speaking_sessions)").all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      if (!progressColumns.has("source_item_id")) {
        database.exec("ALTER TABLE speaking_progress ADD COLUMN source_item_id TEXT");
      }
      if (!sessionColumns.has("drafts_json")) {
        database.exec(
          "ALTER TABLE speaking_sessions ADD COLUMN drafts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(drafts_json))",
        );
      }
      if (!sessionColumns.has("checks_json")) {
        database.exec(
          "ALTER TABLE speaking_sessions ADD COLUMN checks_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(checks_json))",
        );
      }
      database.exec(
        "UPDATE speaking_progress SET source_item_id = practice_item_id WHERE source_item_id IS NULL OR source_item_id = ''",
      );
    },
  },
  {
    version: 8,
    name: "immersion_listening_loop",
    up(database) {
      database.exec(`
        CREATE TABLE listening_sessions (
          id TEXT PRIMARY KEY NOT NULL,
          lesson_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled')),
          current_step TEXT NOT NULL CHECK(current_step IN (
            'first_listen','check_meaning','second_listen','sentence_review','final_relisten','complete'
          )),
          first_listen_comprehension TEXT CHECK(first_listen_comprehension IN (
            'mostly_lost','some_parts','main_idea','most_of_it'
          )),
          first_listen_note TEXT NOT NULL DEFAULT '' CHECK(length(first_listen_note) <= 1000),
          second_listen_comprehension TEXT CHECK(second_listen_comprehension IN (
            'mostly_lost','some_parts','main_idea','most_of_it'
          )),
          final_relisten_rating TEXT CHECK(final_relisten_rating IN (
            'easier','same','still_difficult'
          )),
          final_note TEXT NOT NULL DEFAULT '' CHECK(length(final_note) <= 1000),
          revealed_item_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(revealed_item_ids_json)),
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
        ) STRICT;

        CREATE UNIQUE INDEX listening_one_active_session
          ON listening_sessions(lesson_id) WHERE status='active';
        CREATE INDEX listening_sessions_recent_idx
          ON listening_sessions(status, completed_at DESC, updated_at DESC);

        CREATE TABLE listening_item_progress (
          id TEXT NOT NULL,
          lesson_id TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK(source_type IN (
            'shadowing','example','sentence_mining','vocabulary'
          )),
          source_item_id TEXT NOT NULL,
          listen_count INTEGER NOT NULL DEFAULT 0 CHECK(listen_count >= 0),
          loop_count INTEGER NOT NULL DEFAULT 0 CHECK(loop_count >= 0),
          transcript_revealed INTEGER NOT NULL DEFAULT 0 CHECK(transcript_revealed IN (0,1)),
          recognition_status TEXT NOT NULL DEFAULT 'not_started' CHECK(recognition_status IN (
            'not_started','heard','recognized'
          )),
          difficult INTEGER NOT NULL DEFAULT 0 CHECK(difficult IN (0,1)),
          last_listened_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(lesson_id,id),
          UNIQUE(lesson_id,source_type,source_item_id),
          FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX listening_item_review_idx
          ON listening_item_progress(difficult DESC, last_listened_at ASC);
      `);
    },
  },
  {
    version: 9,
    name: "saved_listening_items",
    up(database) {
      database.exec(`
        ALTER TABLE listening_item_progress
          ADD COLUMN saved_for_relisten INTEGER NOT NULL DEFAULT 0
          CHECK(saved_for_relisten IN (0,1));

        CREATE INDEX listening_item_saved_idx
          ON listening_item_progress(saved_for_relisten, updated_at DESC);
      `);
    },
  },
  {
    version: 10,
    name: "typed_audio_failures",
    up(database) {
      database.exec(`
        ALTER TABLE audio_cache
          ADD COLUMN retryable INTEGER CHECK(retryable IN (0,1));
        ALTER TABLE audio_cache
          ADD COLUMN last_attempt_at TEXT;
        ALTER TABLE audio_cache
          ADD COLUMN next_retry_at TEXT;
        ALTER TABLE audio_cache
          ADD COLUMN error_summary TEXT;

        UPDATE audio_cache
        SET retryable = 1,
            last_attempt_at = updated_at,
            error_code = 'KOKORO_UNAVAILABLE',
            error_summary = 'Kokoro was unreachable.'
        WHERE status = 'failed';

        CREATE INDEX audio_cache_retry_idx
          ON audio_cache(status,retryable,next_retry_at);
      `);
    },
  },
  {
    version: 11,
    name: "speaking_integrity_checks",
    up(database) {
      const invalidProgress = database
        .prepare(
          `SELECT lesson_id,practice_item_id FROM speaking_progress
           WHERE source_type NOT IN ('shadowing','example','sentence_mining','vocabulary')
              OR status NOT IN ('new','practicing','recalled_with_help','recalled','personalized')
              OR attempt_count < 0 OR help_count < 0 OR show_answer_count < 0
              OR recalled_count < 0 OR personalized_count < 0
           LIMIT 1`,
        )
        .get();
      const invalidSession = database
        .prepare(
          `SELECT id FROM speaking_sessions
           WHERE current_item_index < 0
              OR current_step NOT IN ('read','recall','keywords','personalize','free_speak')
              OR status NOT IN ('active','completed','cancelled')
           LIMIT 1`,
        )
        .get();
      if (invalidProgress || invalidSession)
        throw new Error("Speaking data cũ không đạt ràng buộc schema v11.");

      database.exec(`
        CREATE TABLE speaking_progress_v11 (
          lesson_id TEXT NOT NULL,
          practice_item_id TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK(source_type IN (
            'shadowing','example','sentence_mining','vocabulary'
          )),
          source_item_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'new','practicing','recalled_with_help','recalled','personalized'
          )),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
          help_count INTEGER NOT NULL DEFAULT 0 CHECK(help_count >= 0),
          show_answer_count INTEGER NOT NULL DEFAULT 0 CHECK(show_answer_count >= 0),
          recalled_count INTEGER NOT NULL DEFAULT 0 CHECK(recalled_count >= 0),
          personalized_count INTEGER NOT NULL DEFAULT 0 CHECK(personalized_count >= 0),
          self_rating TEXT CHECK(self_rating IN ('hard','okay','easy')),
          first_practiced_at TEXT,
          last_practiced_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(lesson_id,practice_item_id),
          FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
        ) STRICT;

        INSERT INTO speaking_progress_v11 SELECT * FROM speaking_progress;
        DROP TABLE speaking_progress;
        ALTER TABLE speaking_progress_v11 RENAME TO speaking_progress;
        CREATE INDEX speaking_progress_last_idx ON speaking_progress(last_practiced_at);

        CREATE TABLE speaking_sessions_v11 (
          id TEXT PRIMARY KEY NOT NULL,
          lesson_id TEXT NOT NULL,
          item_ids_json TEXT NOT NULL CHECK(json_valid(item_ids_json)),
          drafts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(drafts_json)),
          checks_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(checks_json)),
          current_item_index INTEGER NOT NULL DEFAULT 0 CHECK(current_item_index >= 0),
          current_step TEXT NOT NULL CHECK(current_step IN (
            'read','recall','keywords','personalize','free_speak'
          )),
          status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
        ) STRICT;

        INSERT INTO speaking_sessions_v11 SELECT * FROM speaking_sessions;
        DROP TABLE speaking_sessions;
        ALTER TABLE speaking_sessions_v11 RENAME TO speaking_sessions;
        CREATE UNIQUE INDEX speaking_one_active_session
          ON speaking_sessions(lesson_id) WHERE status='active';
        CREATE INDEX speaking_session_active_idx
          ON speaking_sessions(lesson_id,status,updated_at);
      `);
    },
  },
  {
    version: 12,
    name: "speaking_session_concurrency",
    up(database) {
      database.exec(`
        ALTER TABLE speaking_sessions
          ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0);
        ALTER TABLE speaking_sessions
          ADD COLUMN revealed_item_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(revealed_item_ids_json) AND json_type(revealed_item_ids_json) = 'array');
        ALTER TABLE speaking_sessions
          ADD COLUMN draft_versions_json TEXT NOT NULL DEFAULT '{}'
          CHECK(json_valid(draft_versions_json) AND json_type(draft_versions_json) = 'object');
        ALTER TABLE speaking_sessions
          ADD COLUMN check_versions_json TEXT NOT NULL DEFAULT '{}'
          CHECK(json_valid(check_versions_json) AND json_type(check_versions_json) = 'object');

        CREATE INDEX speaking_session_revision_idx
          ON speaking_sessions(id,lesson_id,status,current_item_index,current_step,revision);
      `);
    },
  },
  {
    version: 13,
    name: "immutable_listening_session_snapshot",
    up(database) {
      database.exec(`
        ALTER TABLE listening_sessions
          ADD COLUMN selected_item_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK(
            json_valid(selected_item_ids_json) AND
            json_type(selected_item_ids_json) = 'array' AND
            length(selected_item_ids_json) <= 5000
          );
        ALTER TABLE listening_sessions
          ADD COLUMN selected_items_json TEXT NOT NULL DEFAULT '[]'
          CHECK(
            json_valid(selected_items_json) AND
            json_type(selected_items_json) = 'array' AND
            length(selected_items_json) <= 40000
          );
        ALTER TABLE listening_sessions
          ADD COLUMN listening_track TEXT NOT NULL DEFAULT '' CHECK(length(listening_track) <= 650);
        ALTER TABLE listening_sessions
          ADD COLUMN track_hash TEXT NOT NULL DEFAULT '' CHECK(length(track_hash) IN (0,24));
        ALTER TABLE listening_sessions
          ADD COLUMN lesson_content_hash TEXT NOT NULL DEFAULT ''
          CHECK(length(lesson_content_hash) IN (0,24));
        ALTER TABLE listening_sessions
          ADD COLUMN selection_version INTEGER NOT NULL DEFAULT 0
          CHECK(selection_version BETWEEN 0 AND 100);
      `);
      const rows = database
        .prepare(
          `SELECT s.id,s.revealed_item_ids_json,l.lesson_json
           FROM listening_sessions s
           JOIN lessons l ON l.id=s.lesson_id`,
        )
        .all() as Array<{
        id: string;
        revealed_item_ids_json: string;
        lesson_json: string;
      }>;
      const update = database.prepare(
        `UPDATE listening_sessions
         SET revealed_item_ids_json=?,selected_item_ids_json=?,selected_items_json=?,
             listening_track=?,track_hash=?,
             lesson_content_hash=?,selection_version=?
         WHERE id=?`,
      );
      for (const row of rows) {
        const snapshot = createListeningSessionSnapshot(JSON.parse(row.lesson_json) as Lesson);
        const legacyRevealedIds = new Set(JSON.parse(row.revealed_item_ids_json) as unknown[]);
        const revealedIds = snapshot.selectedItemIds.filter((itemId) =>
          legacyRevealedIds.has(itemId),
        );
        const result = update.run(
          JSON.stringify(revealedIds),
          JSON.stringify(snapshot.selectedItemIds),
          JSON.stringify(snapshot.selectedItems),
          snapshot.track,
          snapshot.trackHash,
          snapshot.lessonContentHash,
          snapshot.selectionVersion,
          row.id,
        );
        if (Number(result.changes) !== 1) {
          throw new Error(`Listening snapshot backfill failed for ${row.id}.`);
        }
      }
    },
  },
];

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    { user_version?: number } | undefined;
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
