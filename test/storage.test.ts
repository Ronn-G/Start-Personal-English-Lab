import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { resolveDataDirectory } from "../src/server/storage/data-directory";
import { openStorageDatabase } from "../src/server/storage/database";
import { StorageError } from "../src/server/storage/errors";
import { CURRENT_DATABASE_VERSION, runMigrations } from "../src/server/storage/migrations";
import {
  mapLessonRow,
  SqliteStorageRepository,
} from "../src/server/storage/sqlite-repository";
import type { Lesson } from "../src/types/lesson";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "personal-english-lab-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

function sampleLesson(title = "Bài kiểm thử"): Lesson {
  return {
    title,
    summary: "Tóm tắt bài kiểm thử.",
    vocabulary: [],
    idiomsAndSlang: [],
    exampleSentences: [],
    quiz: [],
  };
}

test("resolveDataDirectory honors configuration and safe fallbacks", () => {
  assert.equal(
    resolveDataDirectory({
      env: { PERSONAL_ENGLISH_LAB_DATA_DIR: "custom-data", NODE_ENV: "development" },
      cwd: "C:\\project",
      platform: "win32",
      homeDirectory: "C:\\Users\\tester",
    }),
    resolve("C:\\project", "custom-data"),
  );
  assert.equal(
    resolveDataDirectory({
      env: { NODE_ENV: "development" },
      cwd: "C:\\project",
      platform: "win32",
    }),
    resolve("C:\\project", ".data"),
  );
  assert.equal(
    resolveDataDirectory({
      env: { NODE_ENV: "production", LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      cwd: "C:\\app",
      platform: "win32",
    }),
    resolve("C:\\Users\\tester\\AppData\\Local", "PersonalEnglishLab"),
  );
});

test("new database migrates once and migration is idempotent", () => {
  const databasePath = join(temporaryDirectory(), "storage.sqlite3");
  const opened = openStorageDatabase(databasePath);
  assert.equal(opened.schemaVersion, CURRENT_DATABASE_VERSION);
  assert.equal(runMigrations(opened.database), CURRENT_DATABASE_VERSION);
  const tables = opened.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tables.map((row) => row.name),
    ["app_metadata", "lesson_progress", "lessons"],
  );
  opened.database.close();
});

test("database newer than the app is rejected without writes", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA user_version = 99");
  assert.throws(
    () => runMigrations(database),
    (error: unknown) =>
      error instanceof StorageError && error.code === "UNSUPPORTED_DATABASE_VERSION",
  );
  const schemaCount = database
    .prepare("SELECT count(*) AS count FROM sqlite_master")
    .get() as { count: number };
  assert.equal(schemaCount.count, 0);
  database.close();
});

test("opening a newer file-backed database does not switch journal mode", () => {
  const databasePath = join(temporaryDirectory(), "future.sqlite3");
  const futureDatabase = new DatabaseSync(databasePath);
  futureDatabase.exec("PRAGMA user_version = 99");
  futureDatabase.close();

  assert.throws(
    () => openStorageDatabase(databasePath),
    (error: unknown) =>
      error instanceof StorageError && error.code === "UNSUPPORTED_DATABASE_VERSION",
  );

  const unchangedDatabase = new DatabaseSync(databasePath);
  const version = unchangedDatabase.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  const journal = unchangedDatabase.prepare("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  assert.equal(version.user_version, 99);
  assert.equal(journal.journal_mode, "delete");
  unchangedDatabase.close();
});

test("failed migration rolls back its schema changes", () => {
  const database = new DatabaseSync(":memory:");
  assert.throws(() =>
    runMigrations(database, [
      {
        version: 1,
        name: "intentional_failure",
        up(db) {
          db.exec("CREATE TABLE should_rollback(id TEXT)");
          throw new Error("boom");
        },
      },
    ]),
  );
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE name = 'should_rollback'")
    .get();
  assert.equal(row, undefined);
  database.close();
});

test("repository supports lesson CRUD and progress round-trip", async () => {
  const opened = openStorageDatabase(join(temporaryDirectory(), "repository.sqlite3"));
  const repository = new SqliteStorageRepository(opened.database);
  const created = await repository.createLesson({
    lesson: sampleLesson(),
    lessonDepth: "standard",
    source: {
      title: "Video title",
      url: "https://example.test/video",
      channel: "Test channel",
      originalTranscript: "Original transcript",
      processedTranscript: "Processed transcript",
      wasTruncated: true,
    },
  });
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal((await repository.listLessons()).length, 1);
  assert.equal((await repository.getLesson(created.id))?.source.channel, "Test channel");

  const updated = await repository.updateLesson(created.id, {
    lesson: sampleLesson("Bài đã cập nhật"),
  });
  assert.equal(updated.title, "Bài đã cập nhật");
  assert.equal(updated.source.originalTranscript, "Original transcript");

  const savedProgress = await repository.saveLessonProgress(created.id, {
    answeredQuestions: [0, 2],
    quizScore: 1,
  });
  assert.deepEqual(savedProgress.progress.answeredQuestions, [0, 2]);
  assert.deepEqual(await repository.getLessonProgress(created.id), savedProgress);

  await repository.deleteLesson(created.id);
  assert.equal(await repository.getLesson(created.id), null);
  assert.deepEqual(await repository.listLessons(), []);
  opened.database.close();
});

test("create lesson and initial progress roll back together", async () => {
  const opened = openStorageDatabase(join(temporaryDirectory(), "transaction.sqlite3"));
  opened.database.exec(`
    CREATE TRIGGER reject_progress BEFORE INSERT ON lesson_progress
    BEGIN
      SELECT RAISE(ABORT, 'progress rejected');
    END;
  `);
  const repository = new SqliteStorageRepository(opened.database);
  await assert.rejects(
    repository.createLesson({
      id: "transaction-test",
      lesson: sampleLesson(),
      initialProgress: { answeredQuestions: [0] },
    }),
  );
  assert.equal(await repository.getLesson("transaction-test"), null);
  opened.database.close();
});

test("mapper preserves every transitional lesson field", () => {
  const mapped = mapLessonRow({
    id: "mapper-test",
    schema_version: 7,
    title: "Title",
    summary: "Summary",
    lesson_depth: "deep",
    lesson_json: JSON.stringify(sampleLesson("Title")),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    source_title: "Source",
    source_url: "https://example.test",
    source_channel: "Channel",
    original_transcript: "Original",
    processed_transcript: "Processed",
    was_truncated: 1,
    deleted_at: "2026-01-03T00:00:00.000Z",
  });
  assert.equal(mapped.schemaVersion, 7);
  assert.equal(mapped.lessonDepth, "deep");
  assert.equal(mapped.source.originalTranscript, "Original");
  assert.equal(mapped.source.processedTranscript, "Processed");
  assert.equal(mapped.source.wasTruncated, true);
  assert.equal(mapped.deletedAt, "2026-01-03T00:00:00.000Z");
});
