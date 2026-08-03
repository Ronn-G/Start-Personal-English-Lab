import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { SentenceCheckResult } from "../src/lib/sentence-check";
import type { LadderStep, PracticeTask } from "../src/lib/speaking-practice";
import { exportBackup, importBackup } from "../src/server/backup/backup";
import { SpeakingService, type SpeakingCommand } from "../src/server/speaking/speaking-service";
import { openStorageDatabase } from "../src/server/storage/database";
import { StorageError } from "../src/server/storage/errors";
import { MIGRATIONS, runMigrations } from "../src/server/storage/migrations";
import type { Lesson } from "../src/types/lesson";

type Session = {
  id: string;
  lessonId: string;
  currentItemIndex: number;
  currentStep: LadderStep;
  revision: number;
  status: "active" | "completed" | "cancelled";
  drafts: Record<string, string>;
  draftVersions: Record<string, number>;
  checks: Record<string, SentenceCheckResult & { inputText: string }>;
  checkVersions: Record<string, number>;
  revealedItemIds: string[];
};

type State = {
  session: Session | null;
  tasks: PracticeTask[];
  lessonTitle: string;
  empty?: boolean;
};

function makeLesson(title = "Speaking correctness test"): Lesson {
  const now = new Date().toISOString();
  const item = <T extends object>(value: T) => ({ id: randomUUID(), ...value });
  return {
    id: randomUUID(),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    title,
    summary: "Temporary speaking service lesson.",
    vocabulary: Array.from({ length: 20 }, (_, index) =>
      item({
        word: `word ${index}`,
        phonetic: "/word/",
        definition: "definition",
        vietnamese: "từ",
        ...(index === 0 ? { context: "I use this word in a real conversation." } : {}),
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
        sentence:
          index === 0
            ? "I need to stop focusing on the end goal and enjoy the process."
            : `I keep practicing English for ${index + 10} minutes every day.`,
        keyPhrase: index === 0 ? "enjoy the process" : "keep practicing",
        vietnamese: "Câu ví dụ",
      }),
    ),
    quiz: Array.from({ length: 5 }, () =>
      item({
        question: "Question?",
        options: ["A", "B", "C", "D"],
        correctAnswer: 0,
        explanation: "Explanation",
      }),
    ),
    deepPractice: {
      shadowingPractice: {
        steps: ["Listen", "Repeat", "Record"],
        lines: [
          item({
            line: "I keep moving forward.",
            focus: "keep moving",
            vietnamese: "Dòng",
          }),
          item({
            line: "Small habits make English feel natural.",
            focus: "small habits",
            vietnamese: "Dòng",
          }),
          item({
            line: "I practice even when motivation is low.",
            focus: "keep practicing",
            vietnamese: "Dòng",
          }),
        ],
      },
      sentenceMining: Array.from({ length: 3 }, (_, index) =>
        item({
          sentence: `Consistency helps me improve step ${index + 1}.`,
          pattern: "helps me",
          whyUseful: "Useful",
          remixPrompt: "Remix",
        }),
      ),
      reviewPlan: [1, 2, 4, 7].map((day) => ({
        day: `Day ${day}`,
        task: "Review",
      })),
      ankiCards: Array.from({ length: 5 }, () => item({ front: "Front", back: "Back" })),
    },
  };
}

function insertLesson(database: DatabaseSync, lesson: Lesson) {
  database
    .prepare(
      `INSERT INTO lessons(
         id,schema_version,title,summary,lesson_json,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?)`,
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

function fixture() {
  const opened = openStorageDatabase(":memory:");
  const lesson = makeLesson();
  insertLesson(opened.database, lesson);
  return {
    database: opened.database,
    lesson,
    service: new SpeakingService(opened.database),
  };
}

function call(service: SpeakingService, command: SpeakingCommand): State {
  return service.execute(command) as State;
}

function bind(state: State) {
  const session = state.session!;
  const task = state.tasks[session.currentItemIndex];
  return {
    lessonId: session.lessonId,
    sessionId: session.id,
    practiceItemId: task.id,
    expectedItemIndex: session.currentItemIndex,
    expectedStep: session.currentStep,
    expectedRevision: session.revision,
  };
}

function advance(service: SpeakingService, state: State): State {
  return call(service, { action: "advance", ...bind(state) });
}

function toFinalStep(service: SpeakingService, initial: State): State {
  let state = initial;
  const task = state.tasks[state.session!.currentItemIndex];
  while (state.session!.currentStep !== task.steps.at(-1)) state = advance(service, state);
  return state;
}

function expectConflict(operation: () => unknown) {
  assert.throws(
    operation,
    (error: unknown) => error instanceof StorageError && error.code === "CONFLICT",
  );
}

const checkResult = (sentence: string): SentenceCheckResult => ({
  understandable: true,
  verdict: "clear",
  correctedSentence: sentence,
  naturalAlternative: null,
  explanationVi: "Câu rõ ràng.",
});

test("speaking server owns transitions and rejects stale or wrong bindings", () => {
  const { database, lesson, service } = fixture();
  try {
    const started = call(service, { action: "start", lessonId: lesson.id });
    assert.equal(started.session!.currentStep, "read");
    assert.equal(started.session!.revision, 0);

    expectConflict(() =>
      call(service, {
        action: "advance",
        ...bind(started),
        step: "free_speak",
      }),
    );
    assert.equal(call(service, { action: "status", lessonId: lesson.id }).session!.revision, 0);

    const advanced = call(service, { action: "advance", ...bind(started) });
    assert.equal(advanced.session!.currentStep, "recall");
    assert.equal(advanced.session!.revision, 1);

    expectConflict(() => call(service, { action: "advance", ...bind(started) }));
    expectConflict(() =>
      call(service, {
        action: "advance",
        ...bind(advanced),
        practiceItemId: started.tasks[1].id,
      }),
    );
    expectConflict(() =>
      call(service, {
        action: "complete_item",
        ...bind(advanced),
        rating: "easy",
      }),
    );
    assert.equal(call(service, { action: "status", lessonId: lesson.id }).session!.revision, 1);
  } finally {
    database.close();
  }
});

test("duplicate reveal, advance, completion, and completed mutation never double counters", () => {
  const { database, lesson, service } = fixture();
  try {
    const full = call(service, { action: "start", lessonId: lesson.id });
    const target = full.tasks[0];
    let state = call(service, {
      action: "practice_item",
      lessonId: lesson.id,
      sourceType: target.sourceType,
      sourceItemId: target.sourceItemId,
    });
    assert.equal(state.tasks.length, 1);
    assert.deepEqual(state.tasks[0].steps, [
      "read",
      "recall",
      "keywords",
      "personalize",
      "free_speak",
    ]);
    state = advance(service, state);
    const revealBinding = bind(state);
    state = call(service, { action: "show_answer", ...revealBinding });
    expectConflict(() => call(service, { action: "show_answer", ...revealBinding }));
    const revealRevision = state.session!.revision;
    state = call(service, { action: "show_answer", ...bind(state) });
    assert.equal(state.session!.revision, revealRevision);

    const afterReveal = database
      .prepare(
        "SELECT help_count,show_answer_count FROM speaking_progress WHERE lesson_id=? AND practice_item_id=?",
      )
      .get(lesson.id, target.id) as {
      help_count: number;
      show_answer_count: number;
    };
    assert.deepEqual({ ...afterReveal }, { help_count: 1, show_answer_count: 1 });

    state = toFinalStep(service, state);
    const completeBinding = bind(state);
    const completed = call(service, {
      action: "complete_item",
      ...completeBinding,
      rating: "hard",
    });
    assert.equal(completed.session!.status, "completed");
    expectConflict(() =>
      call(service, {
        action: "complete_item",
        ...completeBinding,
        rating: "hard",
      }),
    );
    const progress = database
      .prepare(
        `SELECT attempt_count,help_count,show_answer_count,self_rating
         FROM speaking_progress WHERE lesson_id=? AND practice_item_id=?`,
      )
      .get(lesson.id, target.id) as Record<string, unknown>;
    assert.deepEqual(
      { ...progress },
      {
        attempt_count: 1,
        help_count: 1,
        show_answer_count: 1,
        self_rating: "hard",
      },
    );
    expectConflict(() => call(service, { action: "advance", ...completeBinding }));
  } finally {
    database.close();
  }
});

test("start new is atomic and cancelled sessions are immutable", () => {
  const { database, lesson, service } = fixture();
  try {
    const active = call(service, { action: "start", lessonId: lesson.id });
    database.exec(
      "CREATE TRIGGER fail_speaking_insert BEFORE INSERT ON speaking_sessions BEGIN SELECT RAISE(FAIL, 'simulated insert failure'); END",
    );
    assert.throws(() => call(service, { action: "start_new", lessonId: lesson.id }));
    database.exec("DROP TRIGGER fail_speaking_insert");
    const afterFailure = call(service, {
      action: "status",
      lessonId: lesson.id,
    });
    assert.equal(afterFailure.session!.id, active.session!.id);
    assert.equal(afterFailure.session!.status, "active");

    const replacement = call(service, {
      action: "start_new",
      lessonId: lesson.id,
    });
    assert.notEqual(replacement.session!.id, active.session!.id);
    const oldStatus = database
      .prepare("SELECT status FROM speaking_sessions WHERE id=?")
      .get(active.session!.id) as { status: string };
    assert.equal(oldStatus.status, "cancelled");
    expectConflict(() => call(service, { action: "advance", ...bind(active) }));
    assert.equal(
      Number(
        (
          database
            .prepare(
              "SELECT COUNT(*) count FROM speaking_sessions WHERE lesson_id=? AND status='active'",
            )
            .get(lesson.id) as { count: number }
        ).count,
      ),
      1,
    );
  } finally {
    database.close();
  }
});

test("draft binding and versions prevent cross-item and stale overwrites", () => {
  const { database, lesson, service } = fixture();
  try {
    let state = call(service, { action: "start", lessonId: lesson.id });
    state = toFinalStep(service, state);
    assert.equal(state.session!.currentStep, "personalize");
    const itemA = state.tasks[0].id;
    const saved = call(service, {
      action: "save_draft",
      ...bind(state),
      draft: "Draft for item A.",
      clientDraftVersion: 1,
    });
    expectConflict(() =>
      call(service, {
        action: "save_draft",
        ...bind(saved),
        draft: "Older overwrite.",
        clientDraftVersion: 1,
      }),
    );
    const moved = call(service, {
      action: "complete_item",
      ...bind(saved),
      rating: "okay",
    });
    const itemB = moved.tasks[1].id;
    expectConflict(() =>
      call(service, {
        action: "save_draft",
        ...bind(saved),
        draft: "Late draft for item A.",
        clientDraftVersion: 2,
      }),
    );
    const current = call(service, { action: "status", lessonId: lesson.id });
    assert.equal(current.session!.drafts[itemA], "Draft for item A.");
    assert.equal(current.session!.drafts[itemB], undefined);
  } finally {
    database.close();
  }
});

test("sentence checks reject changed state and keep the newest per-item response", () => {
  const { database, lesson, service } = fixture();
  try {
    let state = call(service, { action: "start", lessonId: lesson.id });
    state = toFinalStep(service, state);
    const stale = service.prepareSentenceCheck({
      action: "check_sentence",
      ...bind(state),
      sentence: "I need honest myself about gaming.",
      clientCheckVersion: 1,
    });
    const moved = call(service, {
      action: "complete_item",
      ...bind(state),
      rating: "okay",
    });
    expectConflict(() => service.saveSentenceCheck(stale, checkResult(stale.sentence)));
    assert.deepEqual(moved.session!.checks, {});

    const target = moved.tasks[1];
    state = call(service, {
      action: "practice_item",
      lessonId: lesson.id,
      sourceType: target.sourceType,
      sourceItemId: target.sourceItemId,
    });
    state = toFinalStep(service, state);
    assert.equal(state.session!.currentStep, "free_speak");

    const personalizeTarget = moved.tasks[0];
    state = call(service, {
      action: "practice_item",
      lessonId: lesson.id,
      sourceType: personalizeTarget.sourceType,
      sourceItemId: personalizeTarget.sourceItemId,
    });
    state = advance(service, advance(service, advance(service, state)));
    assert.equal(state.session!.currentStep, "personalize");
    const older = service.prepareSentenceCheck({
      action: "check_sentence",
      ...bind(state),
      sentence: "I practice English every day.",
      clientCheckVersion: 1,
    });
    const newer = service.prepareSentenceCheck({
      action: "check_sentence",
      ...bind(state),
      sentence: "I practice spoken English every day.",
      clientCheckVersion: 2,
    });
    service.saveSentenceCheck(newer, checkResult(newer.sentence));
    expectConflict(() => service.saveSentenceCheck(older, checkResult(older.sentence)));
    const latest = call(service, { action: "status", lessonId: lesson.id });
    assert.equal(latest.session!.checks[personalizeTarget.id].inputText, newer.sentence);
    assert.equal(latest.session!.checkVersions[personalizeTarget.id], 2);
  } finally {
    database.close();
  }
});

test("full, targeted, review, and daily subsets preserve exactly one final Free Speak", () => {
  const { database, lesson, service } = fixture();
  try {
    const full = call(service, { action: "start", lessonId: lesson.id });
    assert.equal(full.tasks.filter((task) => task.steps.includes("free_speak")).length, 1);
    const target = full.tasks[0];
    let targeted = call(service, {
      action: "practice_item",
      lessonId: lesson.id,
      sourceType: target.sourceType,
      sourceItemId: target.sourceItemId,
    });
    assert.equal(targeted.tasks.length, 1);
    assert.equal(targeted.tasks[0].steps.at(-1), "free_speak");
    targeted = toFinalStep(service, targeted);
    targeted = call(service, {
      action: "complete_item",
      ...bind(targeted),
      rating: "hard",
    });
    const review = call(service, { action: "review", lessonId: lesson.id });
    assert.equal(review.tasks.length, 1);
    assert.equal(review.tasks[0].steps.at(-1), "free_speak");

    database
      .prepare("UPDATE lessons SET deleted_at=? WHERE id=?")
      .run(new Date().toISOString(), lesson.id);
    assert.deepEqual(service.execute({ action: "daily" }), { lessonId: null });
  } finally {
    database.close();
  }
});

test("schema v13 preserves migrated speaking sessions with safe concurrency defaults", () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.equal(
      runMigrations(
        database,
        MIGRATIONS.filter((migration) => migration.version <= 11),
      ),
      11,
    );
    const lesson = makeLesson("Migration test");
    insertLesson(database, lesson);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO speaking_sessions(
           id,lesson_id,item_ids_json,current_item_index,current_step,status,created_at,updated_at
         ) VALUES(?,?,?,0,'read','active',?,?)`,
      )
      .run(randomUUID(), lesson.id, JSON.stringify([]), now, now);
    assert.equal(runMigrations(database), 13);
    const row = database
      .prepare(
        "SELECT revision,revealed_item_ids_json,draft_versions_json,check_versions_json FROM speaking_sessions",
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...row },
      {
        revision: 0,
        revealed_item_ids_json: "[]",
        draft_versions_json: "{}",
        check_versions_json: "{}",
      },
    );
  } finally {
    database.close();
  }
});

test("schema v12 failure rolls back every concurrency column and version marker", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const legacyMigrations = MIGRATIONS.filter((migration) => migration.version <= 11);
    assert.equal(runMigrations(database, legacyMigrations), 11);
    const failingV12 = {
      version: 12,
      name: "failing_speaking_session_concurrency",
      up(target: DatabaseSync) {
        target.exec("ALTER TABLE speaking_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
        throw new Error("simulated schema v12 failure");
      },
    };

    assert.throws(
      () => runMigrations(database, [...legacyMigrations, failingV12]),
      (error: unknown) => error instanceof StorageError && error.code === "STORAGE_UNAVAILABLE",
    );
    assert.equal(
      Number(
        (
          database.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
      11,
    );
    assert.equal(
      (
        database.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get() as {
          value: string;
        }
      ).value,
      "11",
    );
    const columns = database.prepare("PRAGMA table_info(speaking_sessions)").all() as Array<{
      name: string;
    }>;
    assert.equal(
      columns.some((column) => column.name === "revision"),
      false,
    );
  } finally {
    database.close();
  }
});

test("backup round trip preserves speaking concurrency state and merge never lowers it", () => {
  const source = fixture();
  const target = openStorageDatabase(":memory:").database;
  try {
    const full = call(source.service, {
      action: "start",
      lessonId: source.lesson.id,
    });
    const firstTask = full.tasks[0];
    let state = call(source.service, {
      action: "practice_item",
      lessonId: source.lesson.id,
      sourceType: firstTask.sourceType,
      sourceItemId: firstTask.sourceItemId,
    });
    state = advance(source.service, state);
    state = call(source.service, { action: "show_answer", ...bind(state) });
    const backup = exportBackup(source.database, "0.1.0");
    importBackup(target, backup, "replace");
    const restored = target
      .prepare(
        `SELECT revision,revealed_item_ids_json,draft_versions_json,check_versions_json,status
         FROM speaking_sessions WHERE id=?`,
      )
      .get(state.session!.id) as Record<string, unknown>;
    assert.equal(restored.revision, state.session!.revision);
    assert.deepEqual(JSON.parse(String(restored.revealed_item_ids_json)), [firstTask.id]);

    const now = new Date().toISOString();
    target
      .prepare(
        `UPDATE speaking_sessions
         SET status='completed',current_step='free_speak',revision=10,completed_at=?,updated_at=?
         WHERE id=?`,
      )
      .run(now, now, state.session!.id);
    importBackup(target, backup, "merge", true);
    const merged = target
      .prepare("SELECT status,revision,current_step FROM speaking_sessions WHERE id=?")
      .get(state.session!.id) as Record<string, unknown>;
    assert.deepEqual(
      { ...merged },
      { status: "completed", revision: 10, current_step: "free_speak" },
    );
  } finally {
    source.database.close();
    target.close();
  }
});
