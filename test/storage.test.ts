import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import {
  PRACTICE_HISTORY_LIMIT,
  applyLessonProgressCommand,
  migrateLegacyProgress,
  normalizeLessonProgress,
  validateLessonProgress,
  type LessonProgress,
} from "../src/lib/lesson-progress";
import {
  normalizeLesson,
  parseLessonText,
  validateCanonicalLesson,
} from "../src/lib/lesson-schema";
import {
  LEGACY_LESSONS_KEY,
  LEGACY_PROGRESS_PREFIX,
  readLegacyStorage,
} from "../src/lib/legacy-storage-reader";
import { openStorageDatabase } from "../src/server/storage/database";
import { StorageError } from "../src/server/storage/errors";
import {
  CURRENT_DATABASE_VERSION,
  MIGRATIONS,
  runMigrations,
} from "../src/server/storage/migrations";
import { SqliteStorageRepository } from "../src/server/storage/sqlite-repository";
import {
  commitLegacyMigration,
  getLegacyMigrationStatus,
  lessonFingerprint,
  previewLegacyMigration,
} from "../src/server/storage/legacy-migration";
import type { Lesson } from "../src/types/lesson";
import {
  BACKUP_FORMAT,
  MAX_BACKUP_BYTES,
  MAX_IMPORT_REQUEST_BYTES,
  MAX_LESSON_COUNT,
  MAX_LISTENING_PROGRESS_COUNT,
  MAX_LISTENING_SESSION_COUNT,
  MAX_SPEAKING_PROGRESS_COUNT,
  MAX_SPEAKING_SESSION_COUNT,
  checksum,
  exportBackup,
  importBackup,
  mergeProgress,
  previewImport,
  isBackupByteLengthAllowed,
  isBackupCollectionCountAllowed,
  validateBackup,
} from "../src/server/backup/backup";
import {
  AUDIO_DEFAULTS,
  AudioQueue,
  canFallbackFromAudioError,
  canUseBrowserFallback,
  canonicalAudioInput,
  normalizeAudioText,
  selectLessonAudioPreloadItems,
} from "../src/lib/audio-domain";
import {
  AudioCacheService,
  AudioServiceError,
  ServerSynthesisQueue,
  audioCacheKey,
  cleanupPlan,
  resolveKokoroBaseUrl,
  validWav,
} from "../src/server/audio/audio-cache";
import {
  buildRecallMask,
  buildSpeakingSession,
  extractKeywords,
  extractPracticeCandidates,
  normalizeSpeakingText,
  personalizationPattern,
  personalizationScore,
} from "../src/lib/speaking-practice";
import { mergeSpeakingProgress } from "../src/server/backup/backup";
import { extractListeningItems } from "../src/lib/listening-practice";
import {
  isSentenceFeedbackStale,
  parseSentenceCheck,
  sentenceInputHash,
  validateSentenceInput,
} from "../src/lib/sentence-check";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "pel-test-"));
  dirs.push(path);
  return path;
};
const uuid = (group: number, index = 0) =>
  `${String(group).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;

function legacyLesson(): Record<string, unknown> {
  return {
    title: "BÃ i kiá»ƒm thá»­",
    summary: "TÃ³m táº¯t bÃ i kiá»ƒm thá»­.",
    vocabulary: Array.from({ length: 20 }, (_, i) => ({
      word: `word ${i}`,
      phonetic: "/wÉœËd/",
      definition: "Ä‘á»‹nh nghÄ©a",
      vietnamese: "tá»«",
    })),
    idiomsAndSlang: [
      { phrase: "break the ice", meaning: "báº¯t chuyá»‡n", vietnamese: "phÃ¡ tan im láº·ng" },
    ],
    exampleSentences: Array.from({ length: 5 }, (_, i) => ({
      sentence: `Sentence ${i}`,
      keyPhrase: "phrase",
      vietnamese: "CÃ¢u",
    })),
    quiz: Array.from({ length: 5 }, (_, i) => ({
      question: `Question ${i}`,
      options: ["A", "B", "C", "D"],
      correctAnswer: i % 4,
      explanation: "Giáº£i thÃ­ch",
    })),
    deepPractice: {
      shadowingPractice: {
        steps: ["one", "two", "three"],
        lines: Array.from({ length: 3 }, (_, i) => ({
          line: `Line ${i}`,
          focus: "focus",
          vietnamese: "dÃ²ng",
        })),
      },
      sentenceMining: Array.from({ length: 3 }, (_, i) => ({
        sentence: `Mine ${i}`,
        pattern: "pattern",
        whyUseful: "useful",
        remixPrompt: "remix",
      })),
      reviewPlan: [1, 2, 4, 7].map((day) => ({ day: `Day ${day}`, task: "review" })),
      ankiCards: Array.from({ length: 5 }, (_, i) => ({ front: `Front ${i}`, back: "Back" })),
    },
  };
}
function lesson(): Lesson {
  const result = normalizeLesson(legacyLesson(), {
    id: uuid(9),
    createdAt: "2026-01-01T00:00:00.000Z",
    generateId: (() => {
      let i = 1;
      return () => uuid(8, i++);
    })(),
  });
  assert.ok(result.data);
  return result.data;
}
function progress(item: Lesson, lessonId = item.id): LessonProgress {
  return {
    lessonId,
    progressVersion: 1 as const,
    quizItems: {},
    learningItems: {},
    visitedSections: [],
    practiceHistory: [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function resignBackup<T extends { integrity: { algorithm: "SHA-256"; checksum: string } }>(
  document: T,
): T {
  const payload = structuredClone(document) as Record<string, unknown>;
  delete payload.integrity;
  document.integrity = { algorithm: "SHA-256", checksum: checksum(payload as never) };
  return document;
}

function practiceRecord(item: Lesson, id = uuid(3, 1), occurredAt = item.updatedAt) {
  return {
    id,
    itemId: item.exampleSentences[0].id,
    mode: "writing" as const,
    prompt: item.exampleSentences[0].sentence,
    userAnswer: "This is my complete practice answer.",
    feedback: {
      score: 8,
      overall: "Clear and natural.",
      strengths: ["Good structure"],
      corrections: ["Use a more specific verb"],
      improvedVersion: "This is my improved practice answer.",
      nextStep: "Say it once more.",
    },
    occurredAt,
  };
}

test("canonical Lesson validation and legacy normalization assign stable IDs", () => {
  const normalized = normalizeLesson(legacyLesson(), {
    id: uuid(9),
    createdAt: "2026-01-01T00:00:00.000Z",
    generateId: (() => {
      let i = 1;
      return () => uuid(7, i++);
    })(),
  });
  assert.equal(normalized.success, true);
  assert.equal(validateCanonicalLesson(normalized.data).success, true);
  const again = normalizeLesson(normalized.data);
  assert.deepEqual(again.data, normalized.data);
});
test("duplicate item IDs are repaired while valid IDs are preserved", () => {
  const raw = legacyLesson();
  const shared = uuid(6);
  (raw.vocabulary as Array<Record<string, unknown>>)[0].id = shared;
  (raw.vocabulary as Array<Record<string, unknown>>)[1].id = shared;
  let next = 1;
  const result = normalizeLesson(raw, {
    id: uuid(9),
    createdAt: "2026-01-01T00:00:00Z",
    generateId: () => uuid(5, next++),
  });
  assert.equal(result.data?.vocabulary[0].id, shared);
  assert.equal(result.data?.vocabulary[1].id, uuid(5, 1));
  assert.ok(result.diagnostics.some((d) => d.code === "REPAIRED_ITEM_ID"));
});
test("parser handles fenced JSON and reports malformed or unsupported documents", () => {
  assert.equal(
    parseLessonText(`ÄÃ¢y lÃ  JSON:\n\`\`\`json\n${JSON.stringify(legacyLesson())}\n\`\`\`\nHáº¿t.`)
      .success,
    true,
  );
  assert.equal(parseLessonText("{broken").diagnostics[0].code, "MALFORMED_JSON");
  assert.equal(
    parseLessonText(JSON.stringify({ ...legacyLesson(), schemaVersion: 99 })).diagnostics[0].code,
    "UNSUPPORTED_SCHEMA_VERSION",
  );
});
test("legacy quiz indexes migrate to IDs, deduplicate, and warn out of range", () => {
  const item = lesson();
  const result = migrateLegacyProgress(
    { answeredQuestions: [0, 0, 3, 99, "x"], visitedTabs: ["quiz"] },
    item,
  );
  assert.equal(result.success, true);
  assert.deepEqual(Object.keys(result.data!.quizItems), [item.quiz[0].id, item.quiz[3].id]);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(validateLessonProgress(result.data).success, true);
});
test("canonical Progress rejects index-based shape", () => {
  assert.equal(validateLessonProgress({ answeredQuestions: [0] }).success, false);
});
test("legacy canonical progress defaults optional activity collections", () => {
  const item = lesson();
  const result = normalizeLessonProgress({
    lessonId: item.id,
    progressVersion: 1,
    quizItems: {},
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.data?.learningItems, {});
  assert.deepEqual(result.data?.visitedSections, []);
  assert.deepEqual(result.data?.practiceHistory, []);
});
test("progress commands use stable IDs, preserve updates and reject foreign content", () => {
  const item = lesson();
  const vocabularyId = item.vocabulary[0].id;
  let state = applyLessonProgressCommand(progress(item), item, {
    type: "mark_learning_item_reviewed",
    itemId: vocabularyId,
  });
  state = applyLessonProgressCommand(state, item, {
    type: "mark_section_visited",
    section: "grammar",
  });
  state = applyLessonProgressCommand(state, item, {
    type: "record_quiz_answer",
    itemId: item.quiz[0].id,
    selectedAnswer: item.quiz[0].correctAnswer,
  });
  state = applyLessonProgressCommand(state, item, {
    type: "append_practice_history",
    record: practiceRecord(item),
  });
  assert.equal(state.learningItems[vocabularyId].status, "learned");
  assert.deepEqual(state.visitedSections, ["grammar"]);
  assert.equal(state.quizItems[item.quiz[0].id].completed, true);
  assert.equal(state.practiceHistory.length, 1);
  assert.throws(() =>
    applyLessonProgressCommand(state, item, {
      type: "mark_learning_item_reviewed",
      itemId: uuid(99),
    }),
  );
  assert.throws(() =>
    applyLessonProgressCommand(state, item, {
      type: "mark_section_visited",
      section: "unknown" as never,
    }),
  );
  assert.throws(() =>
    applyLessonProgressCommand(state, item, {
      type: "append_practice_history",
      record: { ...practiceRecord(item), id: "not-a-uuid" },
    }),
  );
});
test("practice history deduplicates and remains capped at the newest records", () => {
  const item = lesson();
  let state = progress(item);
  for (let index = 0; index < PRACTICE_HISTORY_LIMIT + 5; index++) {
    state = applyLessonProgressCommand(state, item, {
      type: "append_practice_history",
      record: practiceRecord(
        item,
        uuid(3, index + 1),
        new Date(Date.parse(item.updatedAt) + index * 1_000).toISOString(),
      ),
    });
  }
  assert.equal(state.practiceHistory.length, PRACTICE_HISTORY_LIMIT);
  const duplicate = state.practiceHistory[0];
  state = applyLessonProgressCommand(state, item, {
    type: "append_practice_history",
    record: duplicate,
  });
  assert.equal(state.practiceHistory.filter((entry) => entry.id === duplicate.id).length, 1);
});
test("database migrates 1 through 4 without losing legacy content and rejects newer versions", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, [MIGRATIONS[0]]);
  const id = uuid(4);
  const legacy = JSON.stringify({ ...legacyLesson(), unknownLegacyField: "kept" });
  db.prepare(
    "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  ).run(id, 1, "title", "summary", legacy, "2026-01-01", "2026-01-01");
  db.prepare(
    "INSERT INTO lesson_progress(lesson_id,progress_version,progress_json,created_at,updated_at) VALUES(?,?,?,?,?)",
  ).run(id, 1, JSON.stringify({ answeredQuestions: [0, 99] }), "2026-01-01", "2026-01-01");
  assert.equal(runMigrations(db), CURRENT_DATABASE_VERSION);
  const migrated = JSON.parse(
    (db.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as { lesson_json: string })
      .lesson_json,
  );
  assert.equal(migrated.title, "BÃ i kiá»ƒm thá»­");
  assert.equal(migrated.unknownLegacyField, "kept");
  assert.equal(validateCanonicalLesson(migrated).success, true);
  const migratedProgress = JSON.parse(
    (
      db.prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?").get(id) as {
        progress_json: string;
      }
    ).progress_json,
  );
  assert.equal(validateLessonProgress(migratedProgress).success, true);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_migration_items'").get());
  db.close();
  const future = new DatabaseSync(":memory:");
  future.exec("PRAGMA user_version=99");
  assert.throws(
    () => runMigrations(future),
    (e) => e instanceof StorageError && e.code === "UNSUPPORTED_DATABASE_VERSION",
  );
  future.close();
});
test("new database v3 repository lists summaries and preserves canonical IDs and progress", async () => {
  const opened = openStorageDatabase(join(temp(), "db.sqlite3"));
  assert.equal(opened.schemaVersion, CURRENT_DATABASE_VERSION);
  const repo = new SqliteStorageRepository(opened.database);
  const source = lesson();
  const created = await repo.createLesson({ id: source.id, lesson: source });
  assert.deepEqual(created.lesson, source);
  const summaries = await repo.listLessons();
  assert.equal(summaries[0].title, source.title);
  assert.equal("lesson" in summaries[0], false);
  const saved = await repo.saveLessonProgress(source.id, progress(source));
  assert.deepEqual((await repo.getLesson(source.id))?.lesson, source);
  assert.deepEqual(await repo.getLessonProgress(source.id), saved);
  opened.database.close();
});
test("repository rejects an update that would make the database too large to back up and rolls back", async () => {
  const database = new DatabaseSync(":memory:");
  runMigrations(database);
  const repository = new SqliteStorageRepository(database);
  const item = lesson();
  await repository.createLesson({
    id: item.id,
    lesson: item,
    source: { originalTranscript: "original", processedTranscript: "processed" },
  });

  const maximumUtf8Transcript = "é".repeat(2_000_000);
  await assert.rejects(
    () =>
      repository.updateLesson(item.id, {
        source: {
          originalTranscript: maximumUtf8Transcript,
          processedTranscript: maximumUtf8Transcript,
        },
      }),
    (error) =>
      error instanceof StorageError &&
      error.code === "VALIDATION_ERROR" &&
      error.message.includes(String(MAX_BACKUP_BYTES)),
  );

  assert.deepEqual((await repository.getLesson(item.id))?.source, {
    title: undefined,
    url: undefined,
    channel: undefined,
    originalTranscript: "original",
    processedTranscript: "processed",
    wasTruncated: false,
  });
  assert.doesNotThrow(() => exportBackup(database, "0.1.0"));
  database.close();
});
test("transactional progress commands survive sequential cross-feature updates and reload", async () => {
  const opened = openStorageDatabase(join(temp(), "commands.sqlite3"));
  const repo = new SqliteStorageRepository(opened.database);
  const item = lesson();
  await repo.createLesson({ id: item.id, lesson: item });
  await repo.updateLessonProgress(item.id, {
    type: "mark_learning_item_reviewed",
    itemId: item.vocabulary[0].id,
  });
  await repo.updateLessonProgress(item.id, {
    type: "mark_section_visited",
    section: "practice",
  });
  await repo.updateLessonProgress(item.id, {
    type: "record_quiz_answer",
    itemId: item.quiz[0].id,
    selectedAnswer: item.quiz[0].correctAnswer,
  });
  await repo.updateLessonProgress(item.id, {
    type: "append_practice_history",
    record: practiceRecord(item),
  });
  const reloaded = await repo.getLessonProgress(item.id);
  assert.equal(reloaded?.progress.learningItems[item.vocabulary[0].id].status, "learned");
  assert.deepEqual(reloaded?.progress.visitedSections, ["practice"]);
  assert.equal(reloaded?.progress.quizItems[item.quiz[0].id].attemptCount, 1);
  assert.equal(reloaded?.progress.practiceHistory.length, 1);
  await assert.rejects(() =>
    repo.updateLessonProgress(item.id, {
      type: "mark_learning_item_reviewed",
      itemId: uuid(77),
    }),
  );
  assert.equal((await repo.getLessonProgress(item.id))?.progress.practiceHistory.length, 1);
  opened.database.close();
});
test("failed migration rolls back", () => {
  const db = new DatabaseSync(":memory:");
  assert.throws(() =>
    runMigrations(db, [
      {
        version: 1,
        name: "fail",
        up(d) {
          d.exec("CREATE TABLE nope(id TEXT)");
          throw new Error("boom");
        },
      },
    ]),
  );
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='nope'").get(), undefined);
  db.close();
});

test("legacy reader only reads app lesson/progress keys and never mutates storage", () => {
  const values = new Map<string, string>();
  const wrapper = {
    id: "legacy-1",
    lesson: legacyLesson(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
  values.set(LEGACY_LESSONS_KEY, JSON.stringify([wrapper]));
  values.set(`${LEGACY_PROGRESS_PREFIX}legacy-1`, JSON.stringify({ answeredQuestions: [0, 99] }));
  values.set("unrelated-secret", "do-not-read");
  const reads: string[] = [];
  const storage = {
    getItem(key: string) {
      reads.push(key);
      return values.get(key) ?? null;
    },
  };
  const before = new Map(values);
  const result = readLegacyStorage(storage as Storage);
  assert.equal(result.records.length, 1);
  assert.deepEqual(values, before);
  assert.ok(!reads.includes("unrelated-secret"));
  assert.deepEqual(result.records[0].progress, { answeredQuestions: [0, 99] });
});

test("fingerprint is stable, ignores generated IDs, and distinguishes same title with different content", () => {
  const first = legacyLesson();
  const second = structuredClone(first);
  (second as { summary: string }).summary = "Different content";
  assert.equal(lessonFingerprint(first), lessonFingerprint(structuredClone(first)));
  assert.equal(
    lessonFingerprint({ ...first, id: uuid(1), createdAt: "2025-01-01" }),
    lessonFingerprint(first),
  );
  assert.notEqual(lessonFingerprint(first), lessonFingerprint(second));
});

test("dry-run writes nothing; commit verifies progress; retry is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const records = [
    {
      legacyId: "old",
      lesson: legacyLesson(),
      createdAt: "2026-01-01T00:00:00.000Z",
      progress: { answeredQuestions: [0, 0, 3, 99] },
    },
  ];
  const before = db.prepare("SELECT total_changes() AS count").get() as { count: number };
  const preview = previewLegacyMigration(db, records);
  const after = db.prepare("SELECT total_changes() AS count").get() as { count: number };
  assert.equal(before.count, after.count);
  assert.equal(preview.validLessons, 1);
  assert.equal(preview.convertedProgress, 1);
  const first = commitLegacyMigration(db, records);
  assert.equal(first.status.migratedLessons, 1);
  assert.equal(
    validateLessonProgress(
      JSON.parse(
        (db.prepare("SELECT progress_json FROM lesson_progress").get() as { progress_json: string })
          .progress_json,
      ),
    ).success,
    true,
  );
  const count1 = (db.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number })
    .count;
  const second = commitLegacyMigration(db, records);
  const count2 = (db.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number })
    .count;
  assert.equal(count1, count2);
  assert.equal(second.preview.existingLessons, 1);
  assert.ok(["completed", "completed-with-warnings"].includes(getLegacyMigrationStatus(db).status));
  db.close();
});

test("partial invalid batch keeps valid lesson and reports warning", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const result = commitLegacyMigration(db, [
    { lesson: legacyLesson() },
    { lesson: { title: "broken" } },
  ]);
  assert.equal(result.preview.validLessons, 1);
  assert.equal(result.preview.invalidLessons, 1);
  assert.equal(result.status.status, "completed-with-warnings");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number }).count,
    1,
  );
  db.close();
});

test("existing SQLite fingerprint reuses stored quiz UUIDs for migrated progress", async () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const repo = new SqliteStorageRepository(db);
  const existing = lesson();
  await repo.createLesson({ id: existing.id, lesson: existing });
  const result = commitLegacyMigration(db, [
    { lesson: legacyLesson(), progress: { answeredQuestions: [1] } },
  ]);
  assert.equal(result.preview.existingLessons, 1);
  const stored = await repo.getLessonProgress(existing.id);
  assert.ok(stored?.progress.quizItems[existing.quiz[1].id]);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number }).count,
    1,
  );
  db.close();
});

test("critical commit failure rolls back lessons/receipts and records failed status", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  db.exec(
    "CREATE TRIGGER fail_legacy_insert BEFORE INSERT ON lessons BEGIN SELECT RAISE(ABORT, 'forced'); END",
  );
  assert.throws(() => commitLegacyMigration(db, [{ lesson: legacyLesson() }]));
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number }).count,
    0,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM legacy_migration_items").get() as { count: number })
      .count,
    0,
  );
  assert.equal(getLegacyMigrationStatus(db).status, "failed");
  db.close();
});

test("malformed legacy stores and progress remain visible as diagnostics", () => {
  const malformedStore = readLegacyStorage({
    getItem(key: string) {
      return key === LEGACY_LESSONS_KEY ? "{broken" : null;
    },
  } as Storage);
  assert.equal(malformedStore.records.length, 0);
  assert.equal(malformedStore.diagnostics[0].code, "MALFORMED_LESSON_STORE");
  const wrapper = { id: "legacy-bad-progress", lesson: legacyLesson() };
  const values = new Map([
    [LEGACY_LESSONS_KEY, JSON.stringify([wrapper])],
    [`${LEGACY_PROGRESS_PREFIX}legacy-bad-progress`, "{broken"],
  ]);
  const result = readLegacyStorage({
    getItem(key: string) {
      return values.get(key) ?? null;
    },
  } as Storage);
  assert.equal(result.records[0].progressUnreadable, true);
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const preview = previewLegacyMigration(db, result.records);
  assert.ok(preview.items[0].diagnostics.some((item) => item.code === "MALFORMED_LEGACY_PROGRESS"));
  assert.equal(preview.warningCount, 1);
  db.close();
});

test("backup export validates checksum and excludes deleted lessons and secrets", async () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const repo = new SqliteStorageRepository(db);
  const item = lesson();
  await repo.createLesson({ id: item.id, lesson: item });
  await repo.saveLessonProgress(item.id, progress(item));
  await repo.setSetting("GEMINI_API_KEY", "secret");
  const backup = exportBackup(db, "0.1.0");
  assert.equal(validateBackup(backup).diagnostics.length, 0);
  assert.equal(validateBackup(JSON.parse(JSON.stringify(backup)) as unknown).diagnostics.length, 0);
  assert.equal(JSON.stringify(backup).includes("secret"), false);
  assert.equal(backup.lessons.length, 1);
  const damaged = structuredClone(backup);
  damaged.lessons[0].summary = "tampered";
  assert.equal(validateBackup(damaged).diagnostics[0].code, "CHECKSUM_MISMATCH");
  db.close();
});
test("backup validation returns readable Vietnamese diagnostics without mojibake", () => {
  const cases: Array<{ value: unknown; code: string; message: string }> = [
    {
      value: "not-an-object",
      code: "INVALID_BACKUP",
      message: "Backup phải là một đối tượng JSON.",
    },
    { value: {}, code: "INVALID_FORMAT", message: "Sai định dạng backup." },
    {
      value: { backupFormat: BACKUP_FORMAT },
      code: "UNSUPPORTED_BACKUP_VERSION",
      message: "Chỉ hỗ trợ backup version 1 hoặc 2.",
    },
  ];
  const mojibake = /Ã|Â|Ä|áº|á»/;
  for (const item of cases) {
    const diagnostics = validateBackup(item.value).diagnostics;
    assert.ok(
      diagnostics.some(
        (diagnostic) => diagnostic.code === item.code && diagnostic.message === item.message,
      ),
    );
    assert.equal(
      diagnostics.some((diagnostic) => mojibake.test(diagnostic.message)),
      false,
    );
  }
});
test("backup dry-run is read-only; merge retry is idempotent; replace rolls back", () => {
  const source = new DatabaseSync(":memory:");
  runMigrations(source);
  const item = lesson();
  source
    .prepare(
      "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)",
    )
    .run(
      item.id,
      1,
      item.title,
      item.summary,
      JSON.stringify(item),
      item.createdAt,
      item.updatedAt,
    );
  const backup = exportBackup(source, "0.1.0");
  const target = new DatabaseSync(":memory:");
  runMigrations(target);
  const before = (target.prepare("SELECT total_changes() count").get() as { count: number }).count;
  assert.equal(previewImport(target, backup).valid, true);
  assert.equal(
    (target.prepare("SELECT total_changes() count").get() as { count: number }).count,
    before,
  );
  importBackup(target, backup, "merge");
  assert.equal(
    (target.prepare("SELECT COUNT(*) count FROM lessons").get() as { count: number }).count,
    1,
  );
  importBackup(target, backup, "merge", true);
  assert.equal(
    (target.prepare("SELECT COUNT(*) count FROM lessons").get() as { count: number }).count,
    1,
  );
  target.exec(
    "CREATE TRIGGER fail_replace BEFORE INSERT ON lessons BEGIN SELECT RAISE(ABORT,'forced'); END",
  );
  assert.throws(() => importBackup(target, backup, "replace", true));
  assert.equal(
    (target.prepare("SELECT COUNT(*) count FROM lessons").get() as { count: number }).count,
    1,
  );
  source.close();
  target.close();
});
test("backup merge progress never loses attempts or completion", () => {
  const item = lesson();
  const older = progress(item);
  const id = item.quiz[0].id;
  older.quizItems[id] = {
    itemId: id,
    selectedAnswer: 0,
    correct: false,
    attemptCount: 4,
    answeredAt: "2026-01-01T00:00:00.000Z",
    completed: true,
  };
  older.learningItems[item.vocabulary[0].id] = {
    itemId: item.vocabulary[0].id,
    status: "learned",
    updatedAt: older.updatedAt,
    userSelected: true,
  };
  older.practiceHistory = [practiceRecord(item)];
  const newer: LessonProgress = {
    ...progress(item),
    updatedAt: "2026-02-01T00:00:00.000Z",
    quizItems: {
      [id]: {
        itemId: id,
        selectedAnswer: 1,
        correct: true,
        attemptCount: 1,
        answeredAt: "2026-02-01T00:00:00.000Z",
        completed: false,
      },
    },
  };
  const merged = mergeProgress(older, newer);
  assert.equal(merged.quizItems[id].attemptCount, 4);
  assert.equal(merged.quizItems[id].completed, true);
  assert.equal(merged.learningItems[item.vocabulary[0].id].status, "learned");
  assert.equal(merged.practiceHistory.length, 1);
});
test("backup v1 accepts legacy progress without learning activity fields", async () => {
  const database = new DatabaseSync(":memory:");
  runMigrations(database);
  const item = lesson();
  const repo = new SqliteStorageRepository(database);
  await repo.createLesson({ id: item.id, lesson: item });
  await repo.saveLessonProgress(item.id, progress(item));
  const backup = exportBackup(database, "0.1.0");
  const legacy = structuredClone(backup) as unknown as {
    backupVersion: 1 | 2;
    lessonSources?: unknown;
    progress: Array<Record<string, unknown>>;
    integrity: { algorithm: "SHA-256"; checksum: string };
  } & Record<string, unknown>;
  delete legacy.progress[0].learningItems;
  delete legacy.progress[0].visitedSections;
  delete legacy.progress[0].practiceHistory;
  legacy.backupVersion = 1;
  delete legacy.lessonSources;
  const payload = structuredClone(legacy);
  delete (payload as Record<string, unknown>).integrity;
  legacy.integrity.checksum = checksum(payload as never);
  const checked = validateBackup(legacy);
  assert.equal(checked.diagnostics.length, 0);
  assert.deepEqual(checked.document?.progress[0].learningItems, {});
  const preview = previewImport(database, legacy);
  assert.ok(preview.warnings.some((warning) => warning.includes("không chứa dữ liệu nguồn")));
  const target = new DatabaseSync(":memory:");
  runMigrations(target);
  importBackup(target, legacy, "replace");
  assert.deepEqual((await new SqliteStorageRepository(target).getLesson(item.id))?.source, {
    title: undefined,
    url: undefined,
    channel: undefined,
    originalTranscript: undefined,
    processedTranscript: undefined,
    wasTruncated: false,
  });
  target.close();
  database.close();
});

test("audio cache key is stable, normalizes whitespace and changes with config", () => {
  const c = { ...AUDIO_DEFAULTS };
  assert.equal(normalizeAudioText(" Hello\n world "), "Hello world");
  assert.equal(audioCacheKey("Hello  world", c), audioCacheKey("Hello world", c));
  assert.notEqual(audioCacheKey("Hello", c), audioCacheKey("Hello", { ...c, voice: "af_heart" }));
  assert.notEqual(audioCacheKey("Hello", c), audioCacheKey("Hello", { ...c, speed: 0.8 }));
  assert.equal(audioCacheKey("secret sentence", c).includes("secret"), false);
  assert.ok(canonicalAudioInput("x", c).includes("model=kokoro-v1.0"));
});
test("Kokoro base URL is configurable and rejects unsafe protocols", () => {
  assert.equal(resolveKokoroBaseUrl(undefined), "http://127.0.0.1:5050");
  assert.equal(resolveKokoroBaseUrl("http://127.0.0.1:6060/"), "http://127.0.0.1:6060");
  assert.throws(() => resolveKokoroBaseUrl("file:///tmp/kokoro"), /INVALID_KOKORO_BASE_URL/);
});
test("audio preload prioritizes and deduplicates without exceeding limit", () => {
  const items = selectLessonAudioPreloadItems(lesson(), 10);
  assert.ok(items.length <= 10);
  assert.equal(items[0].sourceType, "shadowing");
  assert.equal(new Set(items.map((x) => normalizeAudioText(x.text))).size, items.length);
});
test("audio queue coalesces duplicates and runs concurrency one", async () => {
  const queue = new AudioQueue(1);
  let calls = 0,
    active = 0,
    max = 0;
  const request = async () => {
    calls++;
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return "ok";
  };
  const a = queue.enqueue({ key: "same", request, priority: 5, lessonId: "l" });
  const b = queue.enqueue({ key: "same", request, priority: 0, lessonId: "l" });
  const c = queue.enqueue({ key: "other", request, priority: 2, lessonId: "l" });
  assert.deepEqual(await Promise.all([a, b, c]), ["ok", "ok", "ok"]);
  assert.equal(calls, 2);
  assert.equal(max, 1);
});
test("audio queue keeps a shared request alive for another lesson consumer", async () => {
  const queue = new AudioQueue(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = async () => {
    await gate;
    return "ready";
  };
  const first = queue.enqueue({ key: "shared", request, priority: 3, lessonId: "lesson-a" });
  const second = queue.enqueue({ key: "shared", request, priority: 3, lessonId: "lesson-b" });
  queue.cancelLesson("lesson-a");
  release();
  assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);
});
test("audio server synthesis queue serializes different cache keys and coalesces duplicates", async () => {
  const queue = new ServerSynthesisQueue();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const task = async () => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return {
      cacheKey: "a".repeat(64),
      url: "/api/audio/test",
      cacheHit: false,
      sizeBytes: 64,
      provider: "kokoro" as const,
      status: "ready" as const,
    };
  };
  await Promise.all([
    queue.enqueue("one", 2, task),
    queue.enqueue("one", 0, task),
    queue.enqueue("two", 1, task),
  ]);
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
});
test("audio server synthesis queue continues after a provider failure", async () => {
  const queue = new ServerSynthesisQueue();
  const failure = queue.enqueue("failed", 0, async () => {
    throw new Error("provider failed");
  });
  await assert.rejects(() => failure, /provider failed/);
  const recovered = await queue.enqueue("next", 0, async () => ({
    cacheKey: "b".repeat(64),
    url: "/api/audio/next",
    cacheHit: false,
    sizeBytes: 64,
    provider: "kokoro",
    status: "ready",
  }));
  assert.equal(recovered.status, "ready");
  assert.deepEqual(queue.info(), { concurrency: 1, active: 0, queued: 0 });
});
test("audio preparation only permits fallback after a real failure", async () => {
  for (const status of ["queued", "generating", "ready", "cancelled"] as const) {
    assert.equal(canUseBrowserFallback(status), false);
  }
  assert.equal(canUseBrowserFallback("failed"), true);
  for (const code of [
    "KOKORO_UNAVAILABLE",
    "KOKORO_TIMEOUT",
    "KOKORO_INVALID_RESPONSE",
    "KOKORO_INVALID_WAV",
    "AUDIO_RETRY_COOLDOWN",
    "AUDIO_RETRY_REQUIRED",
  ] as const) {
    assert.equal(canFallbackFromAudioError(code), true);
  }
  for (const code of [
    "INVALID_AUDIO_REQUEST",
    "AUDIO_REQUEST_CANCELLED",
    "AUDIO_STORAGE_FAILED",
    "AUDIO_PLAYBACK_FAILED",
  ] as const) {
    assert.equal(canFallbackFromAudioError(code), false);
  }

  const queue = new AudioQueue(1);
  const firstStatuses: string[] = [];
  const duplicateStatuses: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = async () => {
    await gate;
    return "/api/audio/ready";
  };
  const first = queue.enqueue({
    key: "shared",
    request,
    priority: 4,
    lessonId: "lesson",
    onStatus: (status) => firstStatuses.push(status),
  });
  const duplicate = queue.enqueue({
    key: "shared",
    request,
    priority: 0,
    lessonId: "lesson",
    onStatus: (status) => duplicateStatuses.push(status),
  });
  assert.deepEqual(firstStatuses, ["queued", "generating"]);
  assert.deepEqual(duplicateStatuses, ["generating"]);
  assert.equal(canUseBrowserFallback(duplicateStatuses.at(-1) as "generating"), false);
  release();
  assert.deepEqual(await Promise.all([first, duplicate]), ["/api/audio/ready", "/api/audio/ready"]);
  assert.equal(firstStatuses.at(-1), "ready");
  assert.equal(duplicateStatuses.at(-1), "ready");
});
test("audio cache service creates atomic WAV, hits cache, repairs missing metadata and clears safely", async () => {
  const root = temp();
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  let calls = 0;
  const wav = Buffer.alloc(64);
  wav.write("RIFF", 0);
  wav.write("WAVE", 8);
  assert.equal(validWav(wav), true);
  const fetcher = async () => {
    calls++;
    return new Response(wav, { headers: { "content-type": "audio/wav" } });
  };
  const service = new AudioCacheService({
    database: db,
    root,
    fetcher: fetcher as typeof fetch,
    limit: 1000,
  });
  const first = await service.prepare("Hello world");
  assert.equal(first.cacheHit, false);
  assert.equal((await service.prepare("Hello world")).cacheHit, true);
  assert.equal(calls, 1);
  assert.equal((await service.info()).count, 1);
  await service.clear();
  assert.equal((await service.info()).count, 0);
  db.close();
});
test("audio cache types failures, cools down automatic retry, and permits manual recovery", async () => {
  const root = temp();
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const wav = Buffer.alloc(64);
  wav.write("RIFF", 0);
  wav.write("WAVE", 8);
  let shouldFail = true;
  let calls = 0;
  let now = new Date("2026-07-27T00:00:00.000Z");
  const service = new AudioCacheService({
    database: db,
    root,
    fetcher: (async () => {
      calls += 1;
      if (shouldFail) throw new TypeError("fetch failed");
      return new Response(wav, { headers: { "content-type": "audio/wav" } });
    }) as typeof fetch,
    now: () => now,
  });

  await assert.rejects(
    () => service.prepare(" \n "),
    (error: unknown) =>
      error instanceof AudioServiceError &&
      error.code === "INVALID_AUDIO_REQUEST" &&
      error.retryable === false,
  );
  await assert.rejects(
    () => service.prepare("Retry this sentence.", { voice: undefined }),
    (error: unknown) =>
      error instanceof AudioServiceError && error.code === "KOKORO_UNAVAILABLE" && error.retryable,
  );
  assert.equal(
    (
      db.prepare("SELECT status FROM audio_cache").get() as {
        status: string;
      }
    ).status,
    "failed",
  );
  shouldFail = false;
  await assert.rejects(
    () => service.prepare("Retry this sentence.", { voice: undefined }),
    (error: unknown) => error instanceof AudioServiceError && error.code === "AUDIO_RETRY_COOLDOWN",
  );
  assert.equal(calls, 1);
  now = new Date("2026-07-27T00:00:01.000Z");
  const retried = await service.prepare(
    "Retry this sentence.",
    { voice: undefined },
    { retryMode: "manual" },
  );
  assert.equal(retried.cacheHit, false);
  assert.equal(calls, 2);
  assert.equal(
    (
      db.prepare("SELECT status FROM audio_cache").get() as {
        status: string;
      }
    ).status,
    "ready",
  );
  db.close();
});
test("audio cache validates WAV files and repairs only invalid ready entries", async () => {
  const root = temp();
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const wav = Buffer.alloc(64);
  wav.write("RIFF", 0);
  wav.write("WAVE", 8);
  const service = new AudioCacheService({
    database: db,
    root,
    fetcher: (async () =>
      new Response(wav, { headers: { "content-type": "audio/wav" } })) as typeof fetch,
  });
  const result = await service.prepare("Validate this file.");
  writeFileSync(join(root, `${result.cacheKey}.wav`), Buffer.from("broken"));
  const repaired = await service.repairInvalidEntries();
  assert.equal(repaired.repaired, 1);
  assert.equal(
    (db.prepare("SELECT status FROM audio_cache").get() as { status: string }).status,
    "stale",
  );
  const regenerated = await service.prepare("Validate this file.", {}, { retryMode: "manual" });
  assert.equal(regenerated.cacheHit, false);
  db.close();
});
test("audio cache reports an invalid WAV separately from provider HTTP failure", async () => {
  const root = temp();
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const service = new AudioCacheService({
    database: db,
    root,
    fetcher: (async () =>
      new Response(Buffer.from("not a wav"), {
        headers: { "content-type": "audio/wav" },
      })) as typeof fetch,
  });
  await assert.rejects(
    () => service.prepare("Return invalid audio."),
    (error: unknown) => error instanceof AudioServiceError && error.code === "KOKORO_INVALID_WAV",
  );
  assert.equal(
    (db.prepare("SELECT error_code FROM audio_cache").get() as { error_code: string }).error_code,
    "KOKORO_INVALID_WAV",
  );
  db.close();
});
test("audio health response is bounded to safe provider state", async () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const ready = await new AudioCacheService({
    database: db,
    fetcher: (async () =>
      Response.json({ status: "ok", modelLoaded: true, modelPath: "private" })) as typeof fetch,
  }).health();
  assert.equal(ready.configured, true);
  assert.equal(ready.reachable, true);
  assert.equal(ready.status, "ready");
  assert.equal("modelPath" in ready, false);

  const unavailable = await new AudioCacheService({
    database: db,
    fetcher: (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as typeof fetch,
  }).health();
  assert.equal(unavailable.reachable, false);
  assert.equal(unavailable.error, "KOKORO_UNAVAILABLE");
  assert.equal(JSON.stringify(unavailable).includes("ECONNREFUSED"), false);
  db.close();
});
test("audio cleanup plan is LRU and protects current/generating files", () => {
  const rows = [
    { cache_key: "old", size_bytes: 60, last_accessed_at: "2020", status: "ready" },
    { cache_key: "new", size_bytes: 60, last_accessed_at: "2022", status: "ready" },
    { cache_key: "busy", size_bytes: 60, last_accessed_at: "2019", status: "generating" },
  ];
  assert.deepEqual(cleanupPlan(rows, 120, "new"), ["old"]);
});
test("audio cache metadata and paths never enter backup", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  db.prepare(
    "INSERT INTO audio_cache(cache_key,status,relative_path,size_bytes,voice,speed,language,model_version,normalization_version,format,updated_at,failure_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)",
  ).run(
    "a".repeat(64),
    "ready",
    "private.wav",
    64,
    "af_sarah",
    1,
    "en-us",
    "kokoro-v1.0",
    1,
    "wav",
    new Date().toISOString(),
  );
  const json = JSON.stringify(exportBackup(db, "0.1.0"));
  assert.equal(json.includes("private.wav"), false);
  assert.equal(json.includes("audio_cache"), false);
  db.close();
});
test("Kokoro launcher and audio UI avoid personal paths and expose source recovery", () => {
  const files = [
    "tools/kokoro_config.ps1",
    "tools/start_kokoro.ps1",
    "tools/start_dev.ps1",
    "src/server/audio/audio-cache.ts",
    "src/components/lesson/SpeakButton.tsx",
    "src/hooks/useAppAudio.ts",
    "src/app/api/audio/health/route.ts",
    "tools/kokoro_server.py",
  ];
  const source = files.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
  assert.equal(source.includes("L:\\\\tts_tool"), false);
  assert.equal(source.includes("C:\\\\Users\\\\long"), false);
  assert.ok(source.includes(".env.local"));
  assert.ok(source.includes("modelLoaded"));
  assert.ok(source.includes("Kokoro audio ready"));
  assert.ok(source.includes("Using browser voice"));
  assert.ok(source.includes("Retry Kokoro"));
  assert.ok(source.includes("kokoro_lock"));
  assert.ok(source.includes("request_queue_size = 64"));
  assert.ok(source.includes("repairInvalidEntries"));
});
test("all browser playback and browser voice fallback live in the shared audio hook", () => {
  const hook = readFileSync(join(process.cwd(), "src/hooks/useAppAudio.ts"), "utf8");
  const otherSources = [
    "src/components/ListeningPractice.tsx",
    "src/components/LessonGenerator.tsx",
    "src/components/lesson/SpeakButton.tsx",
    "src/lib/audio-client.ts",
  ]
    .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
    .join("\n");
  assert.ok(hook.includes("new Audio(url)"));
  assert.ok(hook.includes("speechSynthesis"));
  assert.equal(otherSources.includes("new Audio("), false);
  assert.equal(otherSources.includes("speechSynthesis"), false);
  assert.ok(hook.includes("AUDIO_PLAYBACK_FAILED"));
});
function speakingLesson(): Lesson {
  const item = lesson();
  item.deepPractice.shadowingPractice.lines[0].line = "I_keep / moving forward.";
  item.deepPractice.shadowingPractice.lines[0].focus = "keep moving";
  item.deepPractice.shadowingPractice.lines[1].line = "Small habits make English feel natural.";
  item.deepPractice.shadowingPractice.lines[2].line = "I practice even when motivation is low.";
  item.exampleSentences.forEach((x, i) => {
    x.sentence = `I keep practicing English for ${i + 10} minutes every day.`;
    x.keyPhrase = "keep practicing";
  });
  item.deepPractice.sentenceMining.forEach(
    (x, i) => (x.sentence = `Consistency helps me improve step ${i + 1}.`),
  );
  item.vocabulary[0].context = "I use this word in a real conversation.";
  return item;
}
function speakingPoisonFixture() {
  const database = new DatabaseSync(":memory:");
  runMigrations(database);
  const first = speakingLesson();
  let generated = 1;
  const secondResult = normalizeLesson(legacyLesson(), {
    id: uuid(50),
    createdAt: first.createdAt,
    generateId: () => uuid(51, generated++),
  });
  assert.ok(secondResult.data);
  const second = secondResult.data;
  for (const item of [first, second])
    database
      .prepare(
        "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)",
      )
      .run(
        item.id,
        1,
        item.title,
        item.summary,
        JSON.stringify(item),
        item.createdAt,
        item.updatedAt,
      );
  const task = buildSpeakingSession(first)[0];
  database
    .prepare(
      `INSERT INTO speaking_progress(
         lesson_id,practice_item_id,source_type,source_item_id,status,attempt_count,
         help_count,show_answer_count,recalled_count,personalized_count,updated_at
       ) VALUES(?,?,?,?,?,1,0,0,1,0,?)`,
    )
    .run(first.id, task.id, task.sourceType, task.sourceItemId, "recalled", first.updatedAt);
  database
    .prepare(
      `INSERT INTO speaking_sessions(
         id,lesson_id,item_ids_json,current_item_index,current_step,status,created_at,updated_at
       ) VALUES(?,?,?,0,'keywords','active',?,?)`,
    )
    .run(uuid(52), first.id, JSON.stringify([task.id]), first.createdAt, first.updatedAt);
  const backup = exportBackup(database, "0.1.0");
  database.close();
  return {
    backup,
    first,
    second,
    task,
    secondSource: {
      sourceType: "example" as const,
      sourceItemId: second.exampleSentences[0].id,
    },
  };
}
test("backup rejects poisoned speaking progress and sessions with precise paths", () => {
  const { backup, secondSource, task } = speakingPoisonFixture();
  const cases: Array<{
    name: string;
    path: string;
    mutate: (document: typeof backup) => void;
  }> = [
    {
      name: "invalid currentStep",
      path: "$.speakingSessions[0].currentStep",
      mutate(document) {
        (document.speakingSessions![0] as unknown as Record<string, unknown>).currentStep =
          "poison";
      },
    },
    {
      name: "negative currentItemIndex",
      path: "$.speakingSessions[0].currentItemIndex",
      mutate(document) {
        document.speakingSessions![0].currentItemIndex = -1;
      },
    },
    {
      name: "out-of-range currentItemIndex",
      path: "$.speakingSessions[0].currentItemIndex",
      mutate(document) {
        document.speakingSessions![0].currentItemIndex = 9;
      },
    },
    {
      name: "negative counter",
      path: "$.speakingProgress[0].attemptCount",
      mutate(document) {
        document.speakingProgress![0].attemptCount = -1;
      },
    },
    {
      name: "invalid status",
      path: "$.speakingProgress[0].status",
      mutate(document) {
        (document.speakingProgress![0] as unknown as Record<string, unknown>).status = "poison";
      },
    },
    {
      name: "completed inconsistency",
      path: "$.speakingSessions[0].completedAt",
      mutate(document) {
        document.speakingSessions![0].status = "completed";
      },
    },
    {
      name: "source from another lesson",
      path: "$.speakingProgress[0].sourceItemId",
      mutate(document) {
        document.speakingProgress![0].sourceType = secondSource.sourceType;
        document.speakingProgress![0].sourceItemId = secondSource.sourceItemId;
      },
    },
    {
      name: "duplicate session ID",
      path: "$.speakingSessions[1].id",
      mutate(document) {
        document.speakingSessions!.push(structuredClone(document.speakingSessions![0]));
      },
    },
    {
      name: "two active sessions",
      path: "$.speakingSessions[1].status",
      mutate(document) {
        document.speakingSessions!.push({
          ...structuredClone(document.speakingSessions![0]),
          id: uuid(53),
        });
      },
    },
    {
      name: "orphan draft",
      path: "$.speakingSessions[0].drafts.foreign-item",
      mutate(document) {
        document.speakingSessions![0].drafts = { "foreign-item": "Draft" };
      },
    },
    {
      name: "malformed check",
      path: `$.speakingSessions[0].checks.${task.id}`,
      mutate(document) {
        document.speakingSessions![0].checks = { [task.id]: { inputHash: "short" } };
      },
    },
  ];
  const target = new DatabaseSync(":memory:");
  runMigrations(target);
  for (const item of cases) {
    const poisoned = structuredClone(backup);
    item.mutate(poisoned);
    resignBackup(poisoned);
    const validation = validateBackup(poisoned);
    assert.equal(validation.document, undefined, `${item.name} was accepted`);
    assert.ok(
      validation.diagnostics.some((diagnostic) => diagnostic.path === item.path),
      `${item.name} missing ${item.path}: ${JSON.stringify(validation.diagnostics)}`,
    );
    assert.equal(previewImport(target, poisoned).valid, false);
  }
  target.close();
});
test("backup validates lesson source shape, identity, URL, transcript and safe content", () => {
  const { backup } = speakingPoisonFixture();
  assert.equal(
    backup.lessonSources?.every((source) => source.title === null),
    true,
  );
  assert.equal(validateBackup(backup).diagnostics.length, 0);
  const cases: Array<{
    path: string;
    mutate: (document: typeof backup) => void;
  }> = [
    {
      path: "$.lessonSources[0]",
      mutate(document) {
        (document.lessonSources![0] as unknown as Record<string, unknown>).audioPath =
          "C:\\private\\voice.wav";
      },
    },
    {
      path: "$.lessonSources[0].lessonId",
      mutate(document) {
        document.lessonSources![0].lessonId = uuid(99);
      },
    },
    {
      path: "$.lessonSources[1].lessonId",
      mutate(document) {
        document.lessonSources![1].lessonId = document.lessonSources![0].lessonId;
      },
    },
    {
      path: "$.lessonSources[0].title",
      mutate(document) {
        (document.lessonSources![0] as unknown as Record<string, unknown>).title = 7;
      },
    },
    {
      path: "$.lessonSources[0].url",
      mutate(document) {
        document.lessonSources![0].url = "file:///C:/private/source.txt";
      },
    },
    {
      path: "$.lessonSources[0].originalTranscript",
      mutate(document) {
        document.lessonSources![0].originalTranscript = "x".repeat(2_000_001);
      },
    },
    {
      path: "$.lessonSources[0].processedTranscript",
      mutate(document) {
        document.lessonSources![0].processedTranscript = "data:audio/wav;base64,AAAA";
      },
    },
    {
      path: "$.lessonSources[0].wasTruncated",
      mutate(document) {
        (document.lessonSources![0] as unknown as Record<string, unknown>).wasTruncated = "yes";
      },
    },
  ];
  for (const item of cases) {
    const poisoned = structuredClone(backup);
    item.mutate(poisoned);
    resignBackup(poisoned);
    const diagnostics = validateBackup(poisoned).diagnostics;
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.path === item.path),
      `missing ${item.path}: ${JSON.stringify(diagnostics)}`,
    );
    assert.equal(
      diagnostics.some((diagnostic) => diagnostic.message.includes("Original transcript")),
      false,
    );
  }
});
test("speaking normalization preserves words and removes shadowing markup", () => {
  assert.equal(normalizeSpeakingText("I_keep / moving *forward*."), "I keep, moving forward.");
});
test("speaking candidates are prioritized, deduplicated and stable", () => {
  const item = speakingLesson();
  item.exampleSentences[1].sentence = item.exampleSentences[0].sentence;
  const a = extractPracticeCandidates(item),
    b = extractPracticeCandidates(structuredClone(item));
  assert.deepEqual(a, b);
  assert.equal(a[0].sourceType, "shadowing");
  assert.equal(new Set(a.map((x) => x.text.toLowerCase())).size, a.length);
  assert.notEqual(a[0].id, a[1].id);
});
test("recall, keywords and personalization are deterministic and conservative", () => {
  const c = extractPracticeCandidates(speakingLesson()).find((x) => x.sourceType === "example")!;
  assert.equal(buildRecallMask(c), buildRecallMask(c));
  assert.ok(buildRecallMask(c).includes("______"));
  assert.ok(!buildRecallMask(c).toLowerCase().includes("keep practicing"));
  const words = extractKeywords(c);
  assert.ok(words.length <= 5);
  assert.notEqual(words.join(" ").toLowerCase(), c.text.toLowerCase());
  assert.ok(personalizationPattern(c).includes("______"));
  const fallback = { ...c, targetPhrase: undefined };
  assert.ok(personalizationPattern(fallback).includes("because ______"));
});
test("speaking session is bounded, survives missing sections, and includes free speak", () => {
  const full = buildSpeakingSession(speakingLesson());
  assert.ok(full.length > 0 && full.length <= 7);
  assert.ok(full.some((x) => x.steps.includes("free_speak")));
  const sparse = speakingLesson();
  sparse.deepPractice.shadowingPractice.lines = [];
  sparse.deepPractice.sentenceMining = [];
  sparse.vocabulary.forEach((x) => delete x.context);
  assert.ok(buildSpeakingSession(sparse).length > 0);
});
test("speaking merge never lowers counters or status", () => {
  const a = {
    lessonId: "l",
    practiceItemId: "p",
    sourceType: "example",
    sourceItemId: "s",
    status: "personalized" as const,
    attemptCount: 5,
    helpCount: 2,
    showAnswerCount: 2,
    recalledCount: 4,
    personalizedCount: 2,
    selfRating: "hard" as const,
    firstPracticedAt: "2026-01-01",
    lastPracticedAt: "2026-02-01",
    updatedAt: "2026-02-01",
  };
  const b = {
    ...a,
    status: "practicing" as const,
    attemptCount: 1,
    helpCount: 0,
    updatedAt: "2026-03-01",
    selfRating: "easy" as const,
  };
  const m = mergeSpeakingProgress(a, b);
  assert.equal(m.status, "personalized");
  assert.equal(m.attemptCount, 5);
  assert.equal(m.selfRating, "easy");
});
test("backup round trip preserves speaking progress and active session", () => {
  const source = new DatabaseSync(":memory:");
  runMigrations(source);
  const item = speakingLesson();
  source
    .prepare(
      "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)",
    )
    .run(
      item.id,
      1,
      item.title,
      item.summary,
      JSON.stringify(item),
      item.createdAt,
      item.updatedAt,
    );
  const task = buildSpeakingSession(item)[0];
  source
    .prepare(
      "INSERT INTO speaking_progress(lesson_id,practice_item_id,source_type,source_item_id,status,attempt_count,help_count,show_answer_count,recalled_count,personalized_count,self_rating,first_practiced_at,last_practiced_at,updated_at) VALUES(?,?,?,?,?,3,2,2,1,1,'hard',?,?,?)",
    )
    .run(
      item.id,
      task.id,
      task.sourceType,
      task.sourceItemId,
      "recalled_with_help",
      item.createdAt,
      item.updatedAt,
      item.updatedAt,
    );
  source
    .prepare(
      "INSERT INTO speaking_sessions(id,lesson_id,item_ids_json,current_item_index,current_step,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)",
    )
    .run(
      uuid(3),
      item.id,
      JSON.stringify([task.id]),
      0,
      "keywords",
      item.createdAt,
      item.updatedAt,
    );
  const backup = exportBackup(source, "0.1.0"),
    target = new DatabaseSync(":memory:");
  runMigrations(target);
  importBackup(target, backup, "replace");
  assert.equal(
    (target.prepare("SELECT self_rating FROM speaking_progress").get() as { self_rating: string })
      .self_rating,
    "hard",
  );
  assert.equal(
    (
      target.prepare("SELECT current_step FROM speaking_sessions WHERE status='active'").get() as {
        current_step: string;
      }
    ).current_step,
    "keywords",
  );
  source.close();
  target.close();
});
test("backup v2 Replace restores full lesson source, progress, speaking, listening and bookmarks", async () => {
  const source = new DatabaseSync(":memory:");
  runMigrations(source);
  const repository = new SqliteStorageRepository(source);
  const item = speakingLesson();
  const sourceMetadata = {
    title: "Source title",
    url: "https://example.com/watch?v=backup-v2",
    channel: "Source channel",
    originalTranscript: "Original transcript for the recovery drill.",
    processedTranscript: "Processed transcript for the recovery drill.",
    wasTruncated: true,
  };
  const lessonProgress = progress(item);
  lessonProgress.visitedSections = ["vocabulary", "practice"];
  lessonProgress.learningItems[item.vocabulary[0].id] = {
    itemId: item.vocabulary[0].id,
    status: "learned",
    updatedAt: item.updatedAt,
    userSelected: true,
  };
  await repository.createLesson({
    id: item.id,
    lesson: item,
    source: sourceMetadata,
    initialProgress: lessonProgress,
  });
  const speakingTask = buildSpeakingSession(item)[0];
  source
    .prepare(
      `INSERT INTO speaking_progress(
         lesson_id,practice_item_id,source_type,source_item_id,status,attempt_count,
         help_count,show_answer_count,recalled_count,personalized_count,self_rating,
         first_practiced_at,last_practiced_at,updated_at
       ) VALUES(?,?,?,?,?,3,2,1,2,1,'hard',?,?,?)`,
    )
    .run(
      item.id,
      speakingTask.id,
      speakingTask.sourceType,
      speakingTask.sourceItemId,
      "personalized",
      item.createdAt,
      item.updatedAt,
      item.updatedAt,
    );
  const check = {
    understandable: true,
    verdict: "clear",
    correctedSentence: "I practice English every day.",
    naturalAlternative: null,
    explanationVi: "Câu rõ ràng.",
    inputHash: sentenceInputHash("I practice English every day."),
    inputText: "I practice English every day.",
    checkedAt: item.updatedAt,
  };
  source
    .prepare(
      `INSERT INTO speaking_sessions(
         id,lesson_id,item_ids_json,drafts_json,checks_json,current_item_index,current_step,
         status,created_at,updated_at
       ) VALUES(?,?,?,?,?,0,'keywords','active',?,?)`,
    )
    .run(
      uuid(40),
      item.id,
      JSON.stringify([speakingTask.id]),
      JSON.stringify({ [speakingTask.id]: "I practice English every day." }),
      JSON.stringify({ [speakingTask.id]: check }),
      item.createdAt,
      item.updatedAt,
    );
  const listeningItem = extractListeningItems(item)[0];
  source
    .prepare(
      `INSERT INTO listening_sessions(
         id,lesson_id,status,current_step,first_listen_comprehension,first_listen_note,
         final_note,revealed_item_ids_json,started_at,updated_at
       ) VALUES(?,?,'active','check_meaning','some_parts','Main idea','',?,?,?)`,
    )
    .run(uuid(41), item.id, JSON.stringify([listeningItem.id]), item.createdAt, item.updatedAt);
  source
    .prepare(
      `INSERT INTO listening_item_progress(
         id,lesson_id,source_type,source_item_id,listen_count,loop_count,
         transcript_revealed,recognition_status,difficult,saved_for_relisten,
         last_listened_at,updated_at
       ) VALUES(?,?,?,?,4,3,1,'heard',1,1,?,?)`,
    )
    .run(
      listeningItem.id,
      item.id,
      listeningItem.sourceType,
      listeningItem.sourceItemId,
      item.updatedAt,
      item.updatedAt,
    );

  const backup = exportBackup(source, "0.1.0");
  const previewDatabase = new DatabaseSync(":memory:");
  runMigrations(previewDatabase);
  const preview = previewImport(previewDatabase, backup);
  assert.equal(backup.backupVersion, 2);
  assert.deepEqual(backup.lessonSources?.[0], {
    lessonId: item.id,
    ...sourceMetadata,
    updatedAt: backup.lessonSources?.[0].updatedAt,
  });
  assert.equal(validateBackup(backup).diagnostics.length, 0);
  assert.equal(preview.lessonSourceCount, 1);
  assert.equal(preview.speakingProgressCount, 1);
  assert.equal(preview.speakingSessionCount, 1);
  assert.equal(preview.listeningSessionCount, 1);
  assert.equal(preview.listeningItemProgressCount, 1);
  previewDatabase.close();

  const target = new DatabaseSync(":memory:");
  runMigrations(target);
  importBackup(target, backup, "replace");
  const restored = await new SqliteStorageRepository(target).getLesson(item.id);
  assert.deepEqual(restored?.lesson, item);
  assert.deepEqual(restored?.source, sourceMetadata);
  assert.deepEqual(
    JSON.parse(
      (
        target.prepare("SELECT progress_json FROM lesson_progress").get() as {
          progress_json: string;
        }
      ).progress_json,
    ),
    lessonProgress,
  );
  assert.equal(
    (target.prepare("SELECT status FROM speaking_progress").get() as { status: string }).status,
    "personalized",
  );
  assert.equal(
    (target.prepare("SELECT id FROM speaking_sessions").get() as { id: string }).id,
    uuid(40),
  );
  assert.equal(
    (
      target.prepare("SELECT saved_for_relisten FROM listening_item_progress").get() as {
        saved_for_relisten: number;
      }
    ).saved_for_relisten,
    1,
  );
  assert.equal(
    (target.prepare("SELECT COUNT(*) count FROM listening_sessions").get() as { count: number })
      .count,
    1,
  );
  source.close();
  target.close();
});
test("backup merge conflict remaps source, speaking and listening idempotently", () => {
  const { backup, first } = speakingPoisonFixture();
  const firstSource = backup.lessonSources!.find((source) => source.lessonId === first.id)!;
  Object.assign(firstSource, {
    title: "Imported source",
    url: "https://example.com/imported-source",
    channel: "Imported channel",
    originalTranscript: "Imported original transcript",
    processedTranscript: "Imported processed transcript",
    wasTruncated: true,
  });
  const listeningItem = extractListeningItems(first)[0];
  backup.listeningItemProgress = [
    {
      id: listeningItem.id,
      lessonId: first.id,
      sourceType: listeningItem.sourceType,
      sourceItemId: listeningItem.sourceItemId,
      listenCount: 2,
      loopCount: 1,
      transcriptRevealed: true,
      recognitionStatus: "heard",
      difficult: true,
      savedForRelisten: true,
      lastListenedAt: first.updatedAt,
      updatedAt: first.updatedAt,
    },
  ];
  backup.listeningSessions = [
    {
      id: uuid(54),
      lessonId: first.id,
      status: "active",
      currentStep: "check_meaning",
      firstListenComprehension: "some_parts",
      firstListenNote: "Main idea",
      finalNote: "",
      revealedItemIds: [listeningItem.id],
      startedAt: first.createdAt,
      updatedAt: first.updatedAt,
    },
  ];
  resignBackup(backup);
  assert.equal(validateBackup(backup).diagnostics.length, 0);

  const target = new DatabaseSync(":memory:");
  runMigrations(target);
  const conflicting = { ...structuredClone(first), summary: "Destination content differs." };
  target
    .prepare(
      "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)",
    )
    .run(
      conflicting.id,
      1,
      conflicting.title,
      conflicting.summary,
      JSON.stringify(conflicting),
      conflicting.createdAt,
      conflicting.updatedAt,
    );
  const firstPreview = previewImport(target, backup);
  assert.equal(firstPreview.conflicts, 1);
  assert.ok(firstPreview.remaps >= 1);
  importBackup(target, backup, "merge");
  const importedRow = (
    target.prepare("SELECT id,lesson_json FROM lessons WHERE id<>?").all(first.id) as Array<{
      id: string;
      lesson_json: string;
    }>
  ).find((row) => (JSON.parse(row.lesson_json) as Lesson).summary === first.summary)!;
  assert.ok(importedRow);
  assert.notEqual(importedRow.id, first.id);
  const sourceRow = target
    .prepare("SELECT * FROM lessons WHERE id=?")
    .get(importedRow.id) as Record<string, unknown>;
  assert.equal(sourceRow.original_transcript, "Imported original transcript");
  assert.equal(sourceRow.processed_transcript, "Imported processed transcript");
  assert.equal(sourceRow.source_url, "https://example.com/imported-source");
  assert.equal(
    (target.prepare("SELECT lesson_id FROM speaking_progress").get() as { lesson_id: string })
      .lesson_id,
    importedRow.id,
  );
  assert.equal(
    (target.prepare("SELECT lesson_id FROM speaking_sessions").get() as { lesson_id: string })
      .lesson_id,
    importedRow.id,
  );
  assert.equal(
    (target.prepare("SELECT lesson_id FROM listening_sessions").get() as { lesson_id: string })
      .lesson_id,
    importedRow.id,
  );
  assert.equal(
    (
      target.prepare("SELECT saved_for_relisten FROM listening_item_progress").get() as {
        saved_for_relisten: number;
      }
    ).saved_for_relisten,
    1,
  );
  assert.equal(target.prepare("PRAGMA foreign_key_check").get(), undefined);
  const countsBeforeRetry = [
    "lessons",
    "speaking_progress",
    "speaking_sessions",
    "listening_sessions",
    "listening_item_progress",
  ].map(
    (table) =>
      (
        target.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as {
          count: number;
        }
      ).count,
  );
  importBackup(target, backup, "merge", true);
  const countsAfterRetry = [
    "lessons",
    "speaking_progress",
    "speaking_sessions",
    "listening_sessions",
    "listening_item_progress",
  ].map(
    (table) =>
      (
        target.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as {
          count: number;
        }
      ).count,
  );
  assert.deepEqual(countsAfterRetry, countsBeforeRetry);
  target.close();
});
test("backup Replace rolls back for invalid source, invalid speaking and post-import verification", () => {
  const { backup } = speakingPoisonFixture();
  const target = new DatabaseSync(":memory:");
  runMigrations(target);
  const old = speakingLesson();
  const oldId = uuid(60);
  old.id = oldId;
  target
    .prepare(
      "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,original_transcript,was_truncated) VALUES(?,?,?,?,?,?,?,?,0)",
    )
    .run(
      old.id,
      1,
      old.title,
      old.summary,
      JSON.stringify(old),
      old.createdAt,
      old.updatedAt,
      "old transcript remains",
    );
  const assertOldState = () => {
    const rows = target.prepare("SELECT id,original_transcript FROM lessons").all() as Array<{
      id: string;
      original_transcript: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, oldId);
    assert.equal(rows[0].original_transcript, "old transcript remains");
  };

  const badSource = structuredClone(backup);
  (badSource.lessonSources![0] as unknown as Record<string, unknown>).machinePath =
    "C:\\private\\audio.wav";
  resignBackup(badSource);
  assert.throws(() => importBackup(target, badSource, "replace"));
  assertOldState();

  const badSpeaking = structuredClone(backup);
  badSpeaking.speakingProgress![0].attemptCount = -1;
  resignBackup(badSpeaking);
  assert.throws(() => importBackup(target, badSpeaking, "replace"));
  assertOldState();

  target.exec(`
    CREATE TRIGGER corrupt_restored_source
    AFTER INSERT ON lessons
    BEGIN
      UPDATE lessons SET original_transcript='corrupted after insert' WHERE id=NEW.id;
    END;
  `);
  assert.throws(() => importBackup(target, backup, "replace"), /Verify lesson source/);
  assertOldState();
  target.close();
});
test("backup byte and lesson count limits enforce minus-one, exact and plus-one boundaries", async () => {
  assert.ok(MAX_IMPORT_REQUEST_BYTES >= MAX_BACKUP_BYTES + 64_000);
  assert.equal(isBackupByteLengthAllowed(MAX_BACKUP_BYTES - 1), true);
  assert.equal(isBackupByteLengthAllowed(MAX_BACKUP_BYTES), true);
  assert.equal(isBackupByteLengthAllowed(MAX_BACKUP_BYTES + 1), false);
  for (const limit of [
    MAX_LESSON_COUNT,
    MAX_SPEAKING_PROGRESS_COUNT,
    MAX_SPEAKING_SESSION_COUNT,
    MAX_LISTENING_SESSION_COUNT,
    MAX_LISTENING_PROGRESS_COUNT,
  ]) {
    assert.equal(isBackupCollectionCountAllowed(limit - 1, limit), true);
    assert.equal(isBackupCollectionCountAllowed(limit, limit), true);
    assert.equal(isBackupCollectionCountAllowed(limit + 1, limit), false);
  }
  assert.ok(
    validateBackup({ payload: "x".repeat(MAX_BACKUP_BYTES) }).diagnostics.some(
      (diagnostic) => diagnostic.code === "BACKUP_TOO_LARGE",
    ),
  );

  const database = new DatabaseSync(":memory:");
  runMigrations(database);
  const template = lesson();
  const insert = database.prepare(
    "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)",
  );
  database.exec("BEGIN");
  for (let index = 0; index < MAX_LESSON_COUNT - 1; index++) {
    const id = uuid(100 + index);
    const item = { ...template, id };
    insert.run(
      id,
      1,
      item.title,
      item.summary,
      JSON.stringify(item),
      item.createdAt,
      item.updatedAt,
    );
  }
  database.exec("COMMIT");
  const repository = new SqliteStorageRepository(database);
  const atLimit = { ...template, id: uuid(700) };
  await repository.createLesson({ id: atLimit.id, lesson: atLimit });
  assert.equal(
    (database.prepare("SELECT COUNT(*) count FROM lessons").get() as { count: number }).count,
    MAX_LESSON_COUNT,
  );
  const overLimit = { ...template, id: uuid(701) };
  await assert.rejects(
    () => repository.createLesson({ id: overLimit.id, lesson: overLimit }),
    /tối đa 500 bài học/,
  );
  database.close();
});
test("Merge rolls back when individually valid databases would exceed backup capacity together", async () => {
  const source = new DatabaseSync(":memory:");
  const target = new DatabaseSync(":memory:");
  runMigrations(source);
  runMigrations(target);
  const sourceRepository = new SqliteStorageRepository(source);
  const targetRepository = new SqliteStorageRepository(target);
  const transcript = "é".repeat(1_999_500);
  const sourceLesson = { ...lesson(), id: uuid(801), title: "Incoming capacity lesson" };
  const targetLesson = { ...lesson(), id: uuid(802), title: "Existing capacity lesson" };
  await sourceRepository.createLesson({
    id: sourceLesson.id,
    lesson: sourceLesson,
    source: { originalTranscript: transcript },
  });
  await targetRepository.createLesson({
    id: targetLesson.id,
    lesson: targetLesson,
    source: { originalTranscript: transcript },
  });
  const backup = exportBackup(source, "0.1.0");

  assert.throws(
    () => importBackup(target, backup, "merge"),
    (error) =>
      error instanceof StorageError &&
      error.code === "VALIDATION_ERROR" &&
      error.message.includes(String(MAX_BACKUP_BYTES)),
  );
  assert.equal(
    (target.prepare("SELECT COUNT(*) count FROM lessons").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (await targetRepository.getLesson(targetLesson.id))?.lesson.title,
    targetLesson.title,
  );
  assert.doesNotThrow(() => exportBackup(target, "0.1.0"));
  source.close();
  target.close();
});
test("backup UI shows version, source availability, per-type counts and clear Replace warning", () => {
  const source = readFileSync(join(process.cwd(), "src/components/BackupRestorePanel.tsx"), "utf8");
  for (const text of [
    "Backup v{preview.backupVersion}",
    "có snapshot nguồn và transcript",
    "không có dữ liệu nguồn/transcript",
    "Speaking progress:",
    "Speaking sessions:",
    "Listening sessions:",
    "Listening item progress:",
    "Xung đột:",
    "Remap:",
    "Record lỗi:",
    "thay thế toàn bộ bài học, nguồn/transcript và tiến độ hiện tại",
    "diagnostic.path",
  ])
    assert.ok(source.includes(text), `missing backup UI copy: ${text}`);
  assert.equal(source.includes("stack"), false);
});
test("personalization selection prefers reusable personal sentences", () => {
  const candidates = extractPracticeCandidates(speakingLesson());
  const useful = candidates.find((x) => x.text.includes("every day"))!,
    abstract = { ...useful, text: "The catch-22 intensifies self-loathing through abstraction." };
  assert.ok(personalizationScore(useful) > personalizationScore(abstract));
  const session = buildSpeakingSession(speakingLesson());
  assert.ok(
    personalizationScore(session.at(-1)!) >=
      Math.max(...session.slice(0, -1).map(personalizationScore)),
  );
});
test("speaking UI exposes actionable Personalize and rating guidance without autoplay", () => {
  const source = readFileSync(join(process.cwd(), "src/components/SpeakingPractice.tsx"), "utf8");
  for (const text of [
    "Make it about you",
    "Keep the useful pattern, but change the details.",
    "Say your new sentence aloud.",
    "Useful pattern",
    "Try this",
    "recording videos",
    "I needed the sentence or answer",
    "I could say it with some pauses",
    "I could say it without much help.",
  ])
    assert.ok(source.includes(text), `missing UI copy: ${text}`);
  assert.equal(source.includes("autoplay"), false);
});
test("short personalization rules and fallback are useful", () => {
  const base = extractPracticeCandidates(speakingLesson())[0];
  assert.equal(
    personalizationPattern({ ...base, text: "Be honest with yourself.", targetPhrase: undefined }),
    "I need to be honest with myself about ______.",
  );
  assert.equal(
    personalizationPattern({
      ...base,
      text: "Complexity emerges beyond context.",
      targetPhrase: undefined,
    }),
    "Say the same idea using something from your real life.",
  );
});
test("sentence-check schema, hash and stale detection are strict", () => {
  const valid = JSON.stringify({
    understandable: true,
    verdict: "clear",
    correctedSentence: "I practice English every day.",
    naturalAlternative: null,
    explanationVi: "Câu rõ ràng và tự nhiên.",
  });
  assert.equal(parseSentenceCheck(valid).verdict, "clear");
  assert.throws(() => parseSentenceCheck(valid.replace('"clear"', '"wrong"')));
  assert.throws(() => parseSentenceCheck(valid.replace("I practice English every day.", "")));
  assert.throws(() =>
    parseSentenceCheck(valid.replace("Câu rõ ràng và tự nhiên.", "x".repeat(501))),
  );
  assert.equal(
    sentenceInputHash("  I practice   English. "),
    sentenceInputHash("I practice English."),
  );
  assert.equal(
    isSentenceFeedbackStale("I practice English.", sentenceInputHash("I practice English.")),
    false,
  );
  assert.equal(
    isSentenceFeedbackStale("I practice daily.", sentenceInputHash("I practice English.")),
    true,
  );
});
test("sentence-check local validation rejects unsafe input but permits imperfect English", () => {
  assert.ok(validateSentenceInput("  ", "I ______.", "Original."));
  assert.ok(validateSentenceInput("two words", "I ______.", "Original."));
  assert.ok(validateSentenceInput("x".repeat(501), "I ______.", "Original."));
  assert.ok(validateSentenceInput("I _____ English.", "I _____ English.", "Original."));
  assert.equal(
    validateSentenceInput("I practice English yesterday.", "I practice ______.", "Original."),
    null,
  );
});
test("speaking schema v11 preserves valid legacy rows and enforces integrity checks", () => {
  const database = new DatabaseSync(":memory:");
  runMigrations(
    database,
    MIGRATIONS.filter((migration) => migration.version <= 10),
  );
  const item = speakingLesson();
  database
    .prepare(
      "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)",
    )
    .run(
      item.id,
      1,
      item.title,
      item.summary,
      JSON.stringify(item),
      item.createdAt,
      item.updatedAt,
    );
  const task = buildSpeakingSession(item)[0];
  database
    .prepare(
      `INSERT INTO speaking_progress(
         lesson_id,practice_item_id,source_type,source_item_id,status,attempt_count,
         help_count,show_answer_count,recalled_count,personalized_count,updated_at
       ) VALUES(?,?,?,?,?,2,1,1,1,0,?)`,
    )
    .run(item.id, task.id, task.sourceType, task.sourceItemId, "recalled", item.updatedAt);
  database
    .prepare(
      "INSERT INTO speaking_sessions(id,lesson_id,item_ids_json,current_item_index,current_step,status,created_at,updated_at) VALUES(?,?,?,0,'keywords','active',?,?)",
    )
    .run(uuid(70), item.id, JSON.stringify([task.id]), item.createdAt, item.updatedAt);
  assert.equal(runMigrations(database), 11);
  assert.equal(
    (
      database.prepare("SELECT attempt_count FROM speaking_progress").get() as {
        attempt_count: number;
      }
    ).attempt_count,
    2,
  );
  assert.equal(
    (
      database.prepare("SELECT current_step FROM speaking_sessions").get() as {
        current_step: string;
      }
    ).current_step,
    "keywords",
  );
  const indexes = (
    database.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  for (const index of [
    "speaking_progress_last_idx",
    "speaking_one_active_session",
    "speaking_session_active_idx",
  ])
    assert.ok(indexes.includes(index));
  assert.equal(
    (
      database.prepare("PRAGMA foreign_key_list(speaking_sessions)").get() as {
        table: string;
      }
    ).table,
    "lessons",
  );
  assert.throws(() =>
    database
      .prepare(
        "UPDATE speaking_progress SET attempt_count=-1 WHERE lesson_id=? AND practice_item_id=?",
      )
      .run(item.id, task.id),
  );
  assert.throws(() =>
    database.prepare("UPDATE speaking_sessions SET current_step='poison' WHERE id=?").run(uuid(70)),
  );
  assert.throws(() =>
    database.prepare("UPDATE speaking_sessions SET current_item_index=-1 WHERE id=?").run(uuid(70)),
  );
  database.close();
});
test("speaking schema v11 rolls back when legacy rows are invalid", () => {
  const database = new DatabaseSync(":memory:");
  runMigrations(
    database,
    MIGRATIONS.filter((migration) => migration.version <= 10),
  );
  const item = speakingLesson();
  database
    .prepare(
      "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)",
    )
    .run(
      item.id,
      1,
      item.title,
      item.summary,
      JSON.stringify(item),
      item.createdAt,
      item.updatedAt,
    );
  const task = buildSpeakingSession(item)[0];
  database
    .prepare(
      `INSERT INTO speaking_progress(
         lesson_id,practice_item_id,source_type,source_item_id,status,attempt_count,
         help_count,show_answer_count,recalled_count,personalized_count,updated_at
       ) VALUES(?,?,?,?,?,-1,0,0,0,0,?)`,
    )
    .run(item.id, task.id, task.sourceType, task.sourceItemId, "new", item.updatedAt);
  assert.throws(() => runMigrations(database), /speaking_integrity_checks/);
  assert.equal(
    (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    10,
  );
  assert.equal(
    (
      database.prepare("SELECT attempt_count FROM speaking_progress").get() as {
        attempt_count: number;
      }
    ).attempt_count,
    -1,
  );
  assert.equal(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='speaking_progress_v11'")
      .get(),
    undefined,
  );
  database.close();
});
test("speaking compatibility migration repairs an intermediate v6 database", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE speaking_progress(lesson_id TEXT,practice_item_id TEXT);CREATE TABLE speaking_sessions(id TEXT);INSERT INTO speaking_progress VALUES('lesson','item');INSERT INTO speaking_sessions VALUES('session')",
  );
  MIGRATIONS.find((x) => x.version === 7)!.up(db);
  const progressColumns = (
      db.prepare("PRAGMA table_info(speaking_progress)").all() as Array<{ name: string }>
    ).map((x) => x.name),
    sessionColumns = (
      db.prepare("PRAGMA table_info(speaking_sessions)").all() as Array<{ name: string }>
    ).map((x) => x.name);
  assert.ok(progressColumns.includes("source_item_id"));
  assert.ok(sessionColumns.includes("drafts_json"));
  assert.ok(sessionColumns.includes("checks_json"));
  assert.equal(
    (db.prepare("SELECT source_item_id FROM speaking_progress").get() as { source_item_id: string })
      .source_item_id,
    "item",
  );
  db.close();
});
test("keyword chunks preserve meaning, target phrases and sentence order", () => {
  const candidate = {
    id: "p",
    lessonId: "l",
    sourceType: "example" as const,
    sourceItemId: "s",
    sourceText: "",
    text: "I need to stop focusing on the end goal and enjoy the process.",
    targetPhrase: "enjoy the process",
  };
  const expected = ["stop focusing", "end goal", "enjoy the process"];
  assert.deepEqual(extractKeywords(candidate), expected);
  assert.deepEqual(extractKeywords(candidate), expected);
  assert.equal(extractKeywords(candidate).includes("need"), false);
  assert.ok(extractKeywords(candidate).join(" ").length < candidate.text.length);
  assert.ok(
    extractKeywords({ ...candidate, text: "Keep going.", targetPhrase: "keep going" }).length > 0,
  );
});
test("personalize uses specific replaceable blanks before general rules", () => {
  const base = {
    id: "p",
    lessonId: "l",
    sourceType: "example" as const,
    sourceItemId: "s",
    sourceText: "",
    targetPhrase: undefined,
  };
  assert.equal(
    personalizationPattern({
      ...base,
      text: "I need to stop focusing on the end goal and enjoy the process.",
    }),
    "I need to stop focusing on ______ and start ______.",
  );
  assert.equal(
    personalizationPattern({ ...base, text: "I need to finish my work." }),
    "I need to ______.",
  );
  assert.equal(
    personalizationPattern({ ...base, text: "I want to travel more." }),
    "I want to ______ because ______.",
  );
  assert.equal(
    personalizationPattern({ ...base, text: "I’m trying to practice daily." }),
    "I’m trying to ______ by ______.",
  );
  for (const text of ["I need to finish my work.", "I want to travel more."])
    assert.equal(
      personalizationPattern({ ...base, text }).includes(`${text.slice(0, -1)} ______`),
      false,
    );
});
test("speaking UI names sentence and step progress and uses spoken-action labels", () => {
  const source = readFileSync(join(process.cwd(), "src/components/SpeakingPractice.tsx"), "utf8");
  for (const text of [
    "Sentence {index+1} of {data.tasks.length}",
    "Step {stepNumber} of {activeSteps.length}",
    "Read the sentence aloud.",
    "I read it aloud",
    "Say the complete sentence aloud before showing the answer.",
    "Say the idea again using only these keywords.",
    "You do not need to use the exact original words.",
    "I added one more sentence",
    "Explain why this matters to you or give a real example.",
  ])
    assert.ok(source.includes(text), `missing ladder UX: ${text}`);
  assert.equal(source.includes(">Next<"), false);
});
test("lesson deletion requires confirmation before the storage call", () => {
  const source = readFileSync(join(process.cwd(), "src/components/LessonGenerator.tsx"), "utf8");
  const confirmation = source.indexOf("const confirmed = window.confirm(");
  const cancellation = source.indexOf("if (!confirmed) return;", confirmation);
  const deletion = source.indexOf("await storageClient.deleteLesson(id);", cancellation);
  assert.ok(confirmation >= 0 && cancellation > confirmation && deletion > cancellation);
  assert.ok(source.includes("tiến độ liên quan sẽ không còn hiển thị"));
});
test("legacy migration UI keeps diagnostic codes out of user-facing text", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/LegacyMigrationPanel.tsx"),
    "utf8",
  );
  assert.equal(source.includes("{diagnostic.code}: {diagnostic.message}"), false);
  assert.ok(source.includes("{diagnostic.message}"));
});
