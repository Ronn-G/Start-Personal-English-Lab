import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { buildAudioPreparationRequest } from "../src/lib/audio-client";
import {
  assertListeningTransition,
  extractListeningItems,
  getComprehensionRank,
  isComprehensionLevel,
  listeningItemId,
  mergeNonDecreasingCounter,
  selectSourceDiverseListeningItems,
} from "../src/lib/listening-practice";
import {
  checksum,
  exportBackup,
  importBackup,
  mergeListeningItemProgress,
  mergeListeningSession,
  validateBackup,
  type BackupDocument,
  type ListeningItemProgressBackup,
  type ListeningSessionBackup,
} from "../src/server/backup/backup";
import { ListeningService } from "../src/server/listening/listening-service";
import {
  CURRENT_DATABASE_VERSION,
  MIGRATIONS,
  runMigrations,
  type Migration,
} from "../src/server/storage/migrations";
import type { Lesson } from "../src/types/lesson";

function fixtureLesson(title = "Listening lesson", id: string = randomUUID()): Lesson {
  const item = <T extends object>(value: T) => ({ id: randomUUID(), ...value });
  const now = new Date().toISOString();
  return {
    id,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    title,
    summary: "Small daily listening habits make spoken English easier to follow.",
    vocabulary: Array.from({ length: 20 }, (_, index) =>
      item({
        word: `word ${index}`,
        definition: "A useful word.",
        vietnamese: "từ",
        ...(index < 2 ? { context: `I notice useful word ${index} when I listen carefully.` } : {}),
      }),
    ),
    idiomsAndSlang: [
      item({
        phrase: "keep going",
        meaning: "continue",
        vietnamese: "tiếp tục",
      }),
    ],
    exampleSentences: Array.from({ length: 5 }, (_, index) =>
      item({
        sentence: `I practice listening for ${index + 10} minutes every day.`,
        keyPhrase: "practice listening",
        vietnamese: "Tôi luyện nghe mỗi ngày.",
      }),
    ),
    quiz: Array.from({ length: 5 }, () =>
      item({
        question: "What is the main idea?",
        options: ["A", "B", "C", "D"],
        correctAnswer: 0,
        explanation: "The lesson recommends daily practice.",
      }),
    ),
    deepPractice: {
      shadowingPractice: {
        steps: ["Listen", "Repeat", "Shadow"],
        lines: [
          item({
            line: "Small habits make listening feel natural.",
            focus: "small habits",
            vietnamese: "Thói quen nhỏ giúp việc nghe tự nhiên hơn.",
          }),
          item({
            line: "I follow the main idea before every detail.",
            focus: "main idea",
            vietnamese: "Tôi theo ý chính trước mọi chi tiết.",
          }),
          item({
            line: "Familiar phrases become easier to hear.",
            focus: "familiar phrases",
            vietnamese: "Cụm từ quen thuộc trở nên dễ nghe hơn.",
          }),
        ],
      },
      sentenceMining: Array.from({ length: 3 }, (_, index) =>
        item({
          sentence: `Listening loop number ${index + 1} helps me notice more.`,
          pattern: "helps me notice",
          whyUseful: "A reusable cause-and-effect pattern.",
          remixPrompt: "Make it personal.",
        }),
      ),
      reviewPlan: [1, 2, 4, 7].map((day) => ({
        day: `Day ${day}`,
        task: "Listen again.",
      })),
      ankiCards: Array.from({ length: 5 }, () => item({ front: "listen", back: "nghe" })),
    },
  };
}

function databaseAt(version = CURRENT_DATABASE_VERSION): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  runMigrations(database, MIGRATIONS.slice(0, version));
  return database;
}

function insertLesson(database: DatabaseSync, lesson: Lesson): void {
  database
    .prepare(
      `INSERT INTO lessons(
        id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated
      ) VALUES(?,?,?,?,?,?,?,0)`,
    )
    .run(
      lesson.id,
      lesson.schemaVersion,
      lesson.title,
      lesson.summary,
      JSON.stringify(lesson),
      lesson.createdAt,
      lesson.updatedAt,
    );
}

interface TestListeningResponse {
  session: {
    id: string;
    lessonId: string;
    status: string;
    currentStep: string;
  } | null;
  items: Array<{
    id: string;
    sourceType: string;
    sourceItemId: string;
    progress: {
      listenCount: number;
      loopCount: number;
      transcriptRevealed: boolean;
      savedForRelisten: boolean;
    };
  }>;
}

function execute(
  service: ListeningService,
  command: Parameters<ListeningService["execute"]>[0],
): TestListeningResponse {
  return service.execute(command) as TestListeningResponse;
}

test("listening comprehension ranks and stable item IDs are strict and deterministic", () => {
  assert.equal(isComprehensionLevel("main_idea"), true);
  assert.equal(isComprehensionLevel("Main idea"), false);
  assert.ok(getComprehensionRank("some_parts") < getComprehensionRank("main_idea"));
  const lessonId = randomUUID();
  const sourceItemId = randomUUID();
  assert.equal(
    listeningItemId(lessonId, "example", sourceItemId),
    listeningItemId(lessonId, "example", sourceItemId),
  );
  assert.notEqual(
    listeningItemId(lessonId, "example", sourceItemId),
    listeningItemId(lessonId, "example", randomUUID()),
  );
  assert.equal(mergeNonDecreasingCounter(8, 3), 8);
  assert.throws(() => mergeNonDecreasingCounter(0, -1), /non-negative/);
  assert.doesNotThrow(() => assertListeningTransition("first_listen", "check_meaning"));
  assert.throws(
    () => assertListeningTransition("first_listen", "sentence_review"),
    /Invalid listening transition/,
  );
});

test("schema v9 migrates through v11 without losing legacy listening data and rolls back", () => {
  const database = databaseAt(9);
  const lesson = fixtureLesson();
  insertLesson(database, lesson);
  const item = extractListeningItems(lesson)[0];
  database
    .prepare(
      `INSERT INTO listening_item_progress(
        id,lesson_id,source_type,source_item_id,listen_count,loop_count,
        transcript_revealed,recognition_status,difficult,last_listened_at,updated_at
      ) VALUES(?,?,?,?,2,1,1,'recognized',1,?,?)`,
    )
    .run(
      item.id,
      lesson.id,
      item.sourceType,
      item.sourceItemId,
      lesson.updatedAt,
      lesson.updatedAt,
    );
  assert.equal(runMigrations(database), 11);
  assert.equal(
    (
      database.prepare("SELECT title FROM lessons WHERE id=?").get(lesson.id) as {
        title: string;
      }
    ).title,
    lesson.title,
  );
  assert.equal(
    (
      database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version,
    11,
  );
  const audioColumns = database
    .prepare("PRAGMA table_info(audio_cache)")
    .all()
    .map((column) => (column as { name: string }).name);
  for (const name of ["retryable", "last_attempt_at", "next_retry_at", "error_summary"]) {
    assert.ok(audioColumns.includes(name));
  }
  assert.equal(
    (
      database
        .prepare(
          "SELECT recognition_status,difficult,saved_for_relisten FROM listening_item_progress WHERE id=?",
        )
        .get(item.id) as {
        recognition_status: string;
        difficult: number;
        saved_for_relisten: number;
      }
    ).saved_for_relisten,
    0,
  );
  const legacy = database
    .prepare("SELECT recognition_status,difficult FROM listening_item_progress WHERE id=?")
    .get(item.id) as { recognition_status: string; difficult: number };
  assert.equal(legacy.recognition_status, "recognized");
  assert.equal(legacy.difficult, 1);
  database.close();

  const failing = databaseAt(9);
  const brokenMigration: Migration = {
    version: 10,
    name: "broken_typed_audio_failures",
    up(db) {
      db.exec("CREATE TABLE should_rollback(id TEXT PRIMARY KEY) STRICT");
      throw new Error("intentional failure");
    },
  };
  assert.throws(
    () => runMigrations(failing, [...MIGRATIONS.slice(0, 9), brokenMigration]),
    /broken_typed_audio_failures/,
  );
  assert.equal(
    (
      failing.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version,
    9,
  );
  assert.equal(
    failing
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='should_rollback'")
      .get(),
    undefined,
  );
  failing.close();
});

test("listening service creates, resumes, isolates, validates, completes, and practices again", () => {
  const database = databaseAt();
  const lesson = fixtureLesson();
  const otherLesson = fixtureLesson("Other lesson");
  insertLesson(database, lesson);
  insertLesson(database, otherLesson);
  const service = new ListeningService(database);

  const first = execute(service, { action: "start", lessonId: lesson.id });
  const resumed = execute(service, { action: "start", lessonId: lesson.id });
  assert.equal(first.session?.id, resumed.session?.id);
  assert.equal(first.session?.currentStep, "first_listen");
  const sessionId = first.session!.id;
  const item = first.items[0];

  assert.throws(
    () =>
      execute(service, {
        action: "save_first_listen",
        lessonId: lesson.id,
        sessionId,
        comprehension: "invalid",
      }),
    /không hợp lệ/,
  );
  let state = execute(service, {
    action: "save_first_listen",
    lessonId: lesson.id,
    sessionId,
    comprehension: "some_parts",
    note: "I heard the main topic.",
  });
  assert.equal(state.session?.currentStep, "check_meaning");
  assert.throws(
    () =>
      execute(service, {
        action: "advance_step",
        lessonId: lesson.id,
        sessionId,
        nextStep: "final_relisten",
      }),
    /bỏ qua/,
  );
  assert.throws(
    () =>
      execute(service, {
        action: "reveal_item",
        lessonId: otherLesson.id,
        sessionId,
        itemId: item.id,
      }),
    /Không tìm thấy phiên/,
  );
  assert.throws(
    () =>
      execute(service, {
        action: "reveal_item",
        lessonId: lesson.id,
        sessionId,
        itemId: "li-not-a-real-item",
      }),
    /không thuộc bài học/,
  );

  state = execute(service, {
    action: "reveal_item",
    lessonId: lesson.id,
    sessionId,
    itemId: item.id,
  });
  assert.equal(state.items[0].progress.transcriptRevealed, true);
  state = execute(service, {
    action: "record_listen",
    lessonId: lesson.id,
    sessionId,
    itemId: item.id,
  });
  state = execute(service, {
    action: "record_loop",
    lessonId: lesson.id,
    sessionId,
    itemId: item.id,
    count: 3,
  });
  assert.equal(state.items[0].progress.listenCount, 4);
  assert.equal(state.items[0].progress.loopCount, 3);
  const legacyAfterListening = database
    .prepare(
      "SELECT recognition_status,difficult FROM listening_item_progress WHERE lesson_id=? AND id=?",
    )
    .get(lesson.id, item.id) as { recognition_status: string; difficult: number };
  assert.equal(legacyAfterListening.recognition_status, "not_started");
  assert.equal(legacyAfterListening.difficult, 0);
  state = execute(service, {
    action: "set_saved_for_relisten",
    lessonId: lesson.id,
    itemId: item.id,
    saved: true,
  });
  assert.equal(state.items[0].progress.savedForRelisten, true);
  assert.equal(state.items[0].progress.listenCount, 4);
  assert.equal(state.items[0].progress.loopCount, 3);

  state = execute(service, {
    action: "advance_step",
    lessonId: lesson.id,
    sessionId,
    nextStep: "second_listen",
  });
  assert.equal(state.session?.currentStep, "second_listen");
  state = execute(service, {
    action: "save_second_listen",
    lessonId: lesson.id,
    sessionId,
    comprehension: "main_idea",
  });
  assert.equal(state.session?.currentStep, "sentence_review");
  state = execute(service, {
    action: "advance_step",
    lessonId: lesson.id,
    sessionId,
    nextStep: "final_relisten",
  });
  assert.equal(state.session?.currentStep, "final_relisten");

  database.exec(`
    CREATE TRIGGER fail_listening_complete
    BEFORE UPDATE OF status ON listening_sessions
    WHEN NEW.status='completed'
    BEGIN
      SELECT RAISE(ABORT,'forced rollback');
    END;
  `);
  assert.throws(
    () =>
      execute(service, {
        action: "complete",
        lessonId: lesson.id,
        sessionId,
      }),
    /forced rollback/,
  );
  assert.equal(
    (
      database.prepare("SELECT status FROM listening_sessions WHERE id=?").get(sessionId) as {
        status: string;
      }
    ).status,
    "active",
  );
  database.exec("DROP TRIGGER fail_listening_complete");
  state = execute(service, {
    action: "complete",
    lessonId: lesson.id,
    sessionId,
    note: "Familiar phrases were clearer.",
  });
  assert.equal(state.session?.status, "completed");
  assert.throws(
    () =>
      execute(service, {
        action: "record_listen",
        lessonId: lesson.id,
        sessionId,
        itemId: item.id,
      }),
    /đã kết thúc/,
  );

  assert.throws(
    () =>
      execute(service, {
        action: "mark_difficult",
        lessonId: lesson.id,
        sessionId,
        itemId: item.id,
      }),
    /không được hỗ trợ/,
  );

  const again = execute(service, { action: "practice_again", lessonId: lesson.id });
  assert.notEqual(again.session?.id, sessionId);
  assert.equal(again.session?.currentStep, "first_listen");
  assert.equal(again.items[0].progress.listenCount, 4);
  assert.equal(again.items[0].progress.savedForRelisten, true);
  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) count FROM listening_sessions WHERE lesson_id=?")
        .get(lesson.id) as { count: number }
    ).count,
    2,
  );
  assert.equal(execute(service, { action: "status", lessonId: otherLesson.id }).session, null);
  database.close();
});

test("listening backup is optional, merges without lowering state, remaps conflicts, and replace rolls back", () => {
  const source = databaseAt();
  const lesson = fixtureLesson();
  insertLesson(source, lesson);
  const service = new ListeningService(source);
  let state = execute(service, { action: "start", lessonId: lesson.id });
  const sessionId = state.session!.id;
  const item = state.items[0];
  state = execute(service, {
    action: "save_first_listen",
    lessonId: lesson.id,
    sessionId,
    comprehension: "some_parts",
  });
  state = execute(service, {
    action: "record_loop",
    lessonId: lesson.id,
    sessionId,
    itemId: item.id,
    count: 3,
  });
  state = execute(service, {
    action: "set_saved_for_relisten",
    lessonId: lesson.id,
    itemId: item.id,
    saved: true,
  });
  const backup = exportBackup(source, "0.1.0");
  assert.equal(backup.listeningSessions?.length, 1);
  assert.equal(backup.listeningItemProgress?.length, 1);
  assert.equal(backup.listeningItemProgress?.[0].savedForRelisten, true);
  assert.equal(validateBackup(backup).diagnostics.length, 0);

  const legacyPayload = {
    backupFormat: backup.backupFormat,
    backupVersion: 1 as const,
    exportedAt: backup.exportedAt,
    appVersion: backup.appVersion,
    databaseSchemaVersion: backup.databaseSchemaVersion,
    lessonSchemaVersion: backup.lessonSchemaVersion,
    progressSchemaVersion: backup.progressSchemaVersion,
    lessons: backup.lessons,
    progress: backup.progress,
    settings: backup.settings,
    speakingProgress: backup.speakingProgress,
    speakingSessions: backup.speakingSessions,
  };
  const legacy = {
    ...legacyPayload,
    integrity: { algorithm: "SHA-256" as const, checksum: checksum(legacyPayload) },
  } as BackupDocument;
  assert.equal(validateBackup(legacy).diagnostics.length, 0);

  const currentPayload = Object.fromEntries(
    Object.entries(backup).filter(([key]) => key !== "integrity"),
  ) as Omit<BackupDocument, "integrity">;
  const oldListeningProgress: ListeningItemProgressBackup = {
    ...backup.listeningItemProgress![0],
  };
  delete oldListeningProgress.savedForRelisten;
  const oldListeningPayload = {
    ...currentPayload,
    listeningItemProgress: [oldListeningProgress],
  };
  const oldListeningBackup = {
    ...oldListeningPayload,
    integrity: {
      algorithm: "SHA-256" as const,
      checksum: checksum(oldListeningPayload),
    },
  } as BackupDocument;
  assert.equal(validateBackup(oldListeningBackup).diagnostics.length, 0);
  const oldListeningTarget = databaseAt();
  importBackup(oldListeningTarget, oldListeningBackup, "merge");
  assert.equal(
    (
      oldListeningTarget
        .prepare("SELECT saved_for_relisten FROM listening_item_progress")
        .get() as { saved_for_relisten: number }
    ).saved_for_relisten,
    0,
  );

  const currentProgress: ListeningItemProgressBackup = {
    ...backup.listeningItemProgress![0],
    listenCount: 9,
    loopCount: 5,
    recognitionStatus: "recognized",
    difficult: false,
    savedForRelisten: false,
    updatedAt: new Date(Date.parse(backup.exportedAt) + 10_000).toISOString(),
  };
  const mergedProgress = mergeListeningItemProgress(
    currentProgress,
    backup.listeningItemProgress![0],
  );
  assert.equal(mergedProgress.listenCount, 9);
  assert.equal(mergedProgress.loopCount, 5);
  assert.equal(mergedProgress.recognitionStatus, "recognized");
  assert.equal(mergedProgress.difficult, false);
  assert.equal(mergedProgress.savedForRelisten, false);

  const completedSession: ListeningSessionBackup = {
    ...backup.listeningSessions![0],
    status: "completed",
    currentStep: "complete",
    completedAt: new Date().toISOString(),
  };
  assert.equal(
    mergeListeningSession(completedSession, backup.listeningSessions![0]).status,
    "completed",
  );

  const conflictTarget = databaseAt();
  const conflictingLesson = fixtureLesson("Different content", lesson.id);
  insertLesson(conflictTarget, conflictingLesson);
  importBackup(conflictTarget, backup, "merge");
  const importedListening = conflictTarget
    .prepare("SELECT lesson_id,source_item_id,saved_for_relisten FROM listening_item_progress")
    .all() as Array<{ lesson_id: string; source_item_id: string; saved_for_relisten: number }>;
  assert.equal(importedListening.length, 1);
  assert.notEqual(importedListening[0].lesson_id, lesson.id);
  assert.equal(importedListening[0].source_item_id, item.sourceItemId);
  assert.equal(importedListening[0].saved_for_relisten, 1);

  const replaceTarget = databaseAt();
  const retainedLesson = fixtureLesson("Retained after rollback");
  insertLesson(replaceTarget, retainedLesson);
  replaceTarget.exec(`
    CREATE TRIGGER fail_listening_restore
    BEFORE INSERT ON listening_item_progress
    BEGIN
      SELECT RAISE(ABORT,'restore rollback');
    END;
  `);
  assert.throws(() => importBackup(replaceTarget, backup, "replace"), /restore rollback/);
  assert.ok(replaceTarget.prepare("SELECT 1 FROM lessons WHERE id=?").get(retainedLesson.id));

  source.close();
  oldListeningTarget.close();
  conflictTarget.close();
  replaceTarget.close();
});

test("re-listen bookmarks persist independently for all source types and roll back", () => {
  const database = databaseAt();
  const lesson = fixtureLesson();
  const otherLesson = fixtureLesson("Bookmark isolation");
  insertLesson(database, lesson);
  insertLesson(database, otherLesson);
  const service = new ListeningService(database);
  let state = execute(service, { action: "start", lessonId: lesson.id });
  const sessionId = state.session!.id;
  state = execute(service, {
    action: "save_first_listen",
    lessonId: lesson.id,
    sessionId,
    comprehension: "some_parts",
  });

  const sourceTypes = ["shadowing", "example", "sentence_mining", "vocabulary"];
  const selected = sourceTypes.map((sourceType) => {
    const item = state.items.find((candidate) => candidate.sourceType === sourceType);
    assert.ok(item, `missing ${sourceType} listening item`);
    return item;
  });

  for (const item of selected) {
    execute(service, {
      action: "record_listen",
      lessonId: lesson.id,
      sessionId,
      itemId: item.id,
    });
    state = execute(service, {
      action: "set_saved_for_relisten",
      lessonId: lesson.id,
      itemId: item.id,
      saved: true,
    });
    const saved = state.items.find((candidate) => candidate.id === item.id)!.progress;
    assert.equal(saved.listenCount, 1);
    assert.equal(saved.loopCount, 0);
    assert.equal(saved.savedForRelisten, true);
  }

  const reloaded = execute(service, { action: "status", lessonId: lesson.id });
  for (const item of selected) {
    const saved = reloaded.items.find((candidate) => candidate.id === item.id)!.progress;
    assert.equal(saved.listenCount, 1);
    assert.equal(saved.savedForRelisten, true);
  }

  const dashboard = service.execute({ action: "dashboard" }) as {
    review: Array<{ lessonId: string; itemId: string }>;
  };
  assert.equal(dashboard.review.length, selected.length);
  assert.ok(dashboard.review.every((entry) => entry.lessonId === lesson.id));
  assert.deepEqual(
    new Set(dashboard.review.map((entry) => entry.itemId)),
    new Set(selected.map((item) => item.id)),
  );

  assert.throws(
    () =>
      execute(service, {
        action: "set_saved_for_relisten",
        lessonId: otherLesson.id,
        itemId: selected[0].id,
        saved: true,
      }),
    /không thuộc bài học/,
  );

  state = execute(service, {
    action: "set_saved_for_relisten",
    lessonId: lesson.id,
    itemId: selected[0].id,
    saved: false,
  });
  const removed = state.items.find((candidate) => candidate.id === selected[0].id)!.progress;
  assert.equal(removed.savedForRelisten, false);
  assert.equal(removed.listenCount, 1);

  const rollbackItem = selected[1];
  database.exec(`
    CREATE TRIGGER fail_listening_item_action
    BEFORE UPDATE ON listening_item_progress
    WHEN OLD.id='${rollbackItem.id}'
    BEGIN
      SELECT RAISE(ABORT,'forced item action rollback');
    END;
  `);
  assert.throws(
    () =>
      execute(service, {
        action: "set_saved_for_relisten",
        lessonId: lesson.id,
        itemId: rollbackItem.id,
        saved: false,
      }),
    /forced item action rollback/,
  );
  const afterRollback = execute(service, { action: "status", lessonId: lesson.id }).items.find(
    (candidate) => candidate.id === rollbackItem.id,
  )!.progress;
  assert.equal(afterRollback.listenCount, 1);
  assert.equal(afterRollback.savedForRelisten, true);
  assert.equal(execute(service, { action: "status", lessonId: otherLesson.id }).session, null);
  database.close();
});

test("extractListeningItems validates source identity and produces a bounded practice track set", () => {
  const lesson = fixtureLesson();
  const items = extractListeningItems(lesson);
  assert.ok(items.length >= 11);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.ok(
    items.every(
      (item) =>
        item.lessonId === lesson.id &&
        item.id === listeningItemId(lesson.id, item.sourceType, item.sourceItemId),
    ),
  );
  const expected = new Map<string, Array<[sourceItemId: string, text: string]>>([
    [
      "shadowing",
      lesson.deepPractice.shadowingPractice.lines.map((item) => [item.id, item.line.trim()]),
    ],
    ["example", lesson.exampleSentences.map((item) => [item.id, item.sentence.trim()])],
    [
      "sentence_mining",
      lesson.deepPractice.sentenceMining.map((item) => [item.id, item.sentence.trim()]),
    ],
    [
      "vocabulary",
      lesson.vocabulary
        .filter((item) => item.context)
        .map((item) => [item.id, item.context!.trim()]),
    ],
  ]);
  for (const [sourceType, sourceItems] of expected) {
    assert.ok(sourceItems.length > 0, `missing fixture source type ${sourceType}`);
    for (const [sourceItemId, text] of sourceItems) {
      const resolved = items.find(
        (item) => item.sourceType === sourceType && item.sourceItemId === sourceItemId,
      );
      assert.equal(resolved?.text, text);
      assert.equal(
        resolved?.id,
        listeningItemId(
          lesson.id,
          sourceType as "shadowing" | "example" | "sentence_mining" | "vocabulary",
          sourceItemId,
        ),
      );
    }
  }
  const ranked = [...items].sort((left, right) => left.id.localeCompare(right.id));
  const review = selectSourceDiverseListeningItems(ranked, 8);
  assert.equal(review.length, 8);
  assert.deepEqual(
    new Set(review.map((item) => item.sourceType)),
    new Set(["shadowing", "example", "sentence_mining", "vocabulary"]),
  );
  assert.equal(new Set(review.map((item) => item.id)).size, review.length);
});

test("Check Meaning and Sentence Review use the same canonical audio request", () => {
  const checkMeaningRequest = buildAudioPreparationRequest(
    "  Small   habits make listening feel natural. ",
    1,
  );
  const sentenceReviewRequest = buildAudioPreparationRequest(
    "Small habits make listening feel natural.",
    1,
  );
  assert.deepEqual(checkMeaningRequest, sentenceReviewRequest);
  assert.equal(checkMeaningRequest.body.text, "Small habits make listening feel natural.");
  assert.equal(checkMeaningRequest.body.voice, "af_sarah");
  assert.equal(checkMeaningRequest.body.language, "en-us");
  assert.equal(checkMeaningRequest.body.modelVersion, "kokoro-v1.0");
});

test("listening UI removes sentence assessments and keeps objective practice actions", () => {
  const listeningUi = readFileSync("src/components/ListeningPractice.tsx", "utf8");
  const lessonUi = readFileSync("src/components/LessonDisplay.tsx", "utf8");
  const dashboardUi = readFileSync("src/components/LessonGenerator.tsx", "utf8");
  assert.match(listeningUi, /Transcript hidden/);
  assert.match(listeningUi, /Reveal sentence/);
  assert.match(listeningUi, /How much did you understand/);
  assert.match(listeningUi, /: "Play"/);
  assert.match(listeningUi, /Loop 3/);
  assert.match(listeningUi, /Loop 5/);
  assert.match(listeningUi, />\s*Stop\s*</);
  assert.match(listeningUi, /Audio First review/);
  assert.match(listeningUi, /Preparing Kokoro audio/);
  assert.match(listeningUi, /Kokoro audio ready/);
  assert.match(listeningUi, /Using browser voice/);
  assert.match(listeningUi, /Audio failed/);
  assert.match(listeningUi, /Retry Kokoro/);
  assert.equal((listeningUi.match(/<ListeningAudioControls/g) ?? []).length, 2);
  assert.match(listeningUi, /Practice this sentence/);
  assert.match(listeningUi, /Save for re-listen/);
  assert.match(listeningUi, /Remove from re-listen/);
  assert.match(listeningUi, /aria-pressed=\{item\.progress\.savedForRelisten\}/);
  assert.doesNotMatch(
    listeningUi,
    /I can hear it now|I could hear it|understood it after reading|understand it after reading|Heard clearly|Still difficult|Marked difficult/i,
  );
  assert.doesNotMatch(listeningUi, /mark_recognized|mark_difficult|mark_understood_after_reading/);
  assert.match(listeningUi, /Practice Again/);
  assert.match(lessonUi, /Continue Listening Practice/);
  assert.match(dashboardUi, /Continue Listening/);
  assert.match(dashboardUi, /Re-listen/);
  assert.match(dashboardUi, /Sentences you explicitly saved for later/);
  assert.match(dashboardUi, /Open lesson/);
  assert.match(dashboardUi, /Remove from re-listen/);
  assert.doesNotMatch(dashboardUi, /difficult sentence/i);
});
