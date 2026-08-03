import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = await mkdtemp(join(tmpdir(), "pel-speaking-e2e-"));
const port = "3226";
const base = `http://127.0.0.1:${port}`;
const serverPath = resolve(".next", "standalone", "server.js");
const server = spawn(process.execPath, [serverPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: port,
    PERSONAL_ENGLISH_LAB_DATA_DIR: join(root, "data"),
    SENTENCE_CHECK_MOCK: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
server.stderr.on("data", (chunk) => (stderr += chunk));

const uuid = () => crypto.randomUUID();
const item = (extra) => ({ id: uuid(), ...extra });

function makeLesson(title, updatedAt = new Date().toISOString()) {
  const lessonId = uuid();
  return {
    id: lessonId,
    schemaVersion: 1,
    createdAt: updatedAt,
    updatedAt,
    title,
    summary: "Temporary speaking smoke lesson.",
    vocabulary: Array.from({ length: 20 }, (_, index) =>
      item({
        word: `word ${index}`,
        phonetic: "/word/",
        definition: "definition",
        vietnamese: "từ",
        ...(index === 0 ? { context: "I use this word in a real conversation." } : {}),
      }),
    ),
    idiomsAndSlang: [item({ phrase: "keep going", meaning: "continue", vietnamese: "tiếp tục" })],
    exampleSentences: Array.from({ length: 5 }, (_, index) =>
      item({
        sentence:
          index === 0
            ? "I need to stop focusing on the end goal and enjoy the process."
            : `I keep practicing English for ${index + 10} minutes every day.`,
        keyPhrase: index === 0 ? "enjoy the process" : "keep practicing",
        vietnamese: "Câu",
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
          item({ line: "I keep moving forward.", focus: "keep moving", vietnamese: "Dòng" }),
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
          whyUseful: "useful",
          remixPrompt: "remix",
        }),
      ),
      reviewPlan: [1, 2, 4, 7].map((day) => ({ day: `Day ${day}`, task: "review" })),
      ankiCards: Array.from({ length: 5 }, () => item({ front: "Front", back: "Back" })),
    },
  };
}

const lesson = makeLesson("Speaking correctness smoke");
const deletedLesson = makeLesson(
  "Speaking deleted candidate",
  new Date(Date.now() + 1_000).toISOString(),
);

async function jsonRequest(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function binding(state) {
  const session = state.session;
  const task = state.tasks[session.currentItemIndex];
  return {
    sessionId: session.id,
    practiceItemId: task.id,
    expectedItemIndex: session.currentItemIndex,
    expectedStep: session.currentStep,
    expectedRevision: session.revision,
  };
}

async function raw(action, extra = {}, state) {
  return jsonRequest("/api/speaking", {
    action,
    lessonId: lesson.id,
    ...(state ? binding(state) : {}),
    ...extra,
  });
}

async function ok(action, extra = {}, state) {
  const result = await raw(action, extra, state);
  if (result.status >= 400) {
    throw new Error(`${action} failed ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function latest() {
  return ok("status");
}

function progress(itemId) {
  const database = new DatabaseSync(join(root, "data", "personal-english-lab.sqlite3"), {
    timeout: 5_000,
  });
  const row = database
    .prepare(
      `SELECT attempt_count,help_count,show_answer_count
       FROM speaking_progress WHERE lesson_id=? AND practice_item_id=?`,
    )
    .get(lesson.id, itemId);
  database.close();
  return row;
}

try {
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/storage/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  if (!health) throw new Error(`server failed ${stderr}`);
  if (health.schemaVersion !== 13) throw new Error("schema is not v13");

  for (const currentLesson of [lesson, deletedLesson]) {
    const created = await jsonRequest("/api/storage/lessons", { lesson: currentLesson });
    if (created.status !== 201) {
      throw new Error(`lesson create ${created.status}: ${JSON.stringify(created.body)}`);
    }
  }

  const first = await ok("start");
  const resumed = await ok("start");
  if (first.session.id !== resumed.session.id) throw new Error("active session did not resume");

  const skip = await raw("advance", { step: "free_speak" }, first);
  if (skip.status !== 409 || (await latest()).session.currentStep !== "read") {
    throw new Error("skip-step was not rejected");
  }

  const duplicateAdvance = await Promise.all([
    raw("advance", { step: "recall" }, first),
    raw("advance", { step: "recall" }, first),
  ]);
  if (
    duplicateAdvance
      .map((result) => result.status)
      .sort()
      .join(",") !== "200,409"
  ) {
    throw new Error("duplicate advance did not produce one success and one conflict");
  }
  let state = await latest();
  if (state.session.currentStep !== "recall") throw new Error("valid advance failed");

  const firstItemId = state.tasks[0].id;
  const beforeRevealProgress = progress(firstItemId);
  const beforeReveal = beforeRevealProgress?.help_count ?? 0;
  const beforeShowAnswer = beforeRevealProgress?.show_answer_count ?? 0;
  const duplicateReveal = await Promise.all([
    raw("show_answer", {}, state),
    raw("show_answer", {}, state),
  ]);
  if (
    duplicateReveal
      .map((result) => result.status)
      .sort()
      .join(",") !== "200,409"
  ) {
    throw new Error("duplicate Show Answer did not conflict");
  }
  state = await latest();
  const afterReveal = progress(firstItemId);
  if (
    afterReveal.help_count - beforeReveal !== 1 ||
    afterReveal.show_answer_count - beforeShowAnswer !== 1
  ) {
    throw new Error("Show Answer counters changed more than once");
  }

  state = await ok("advance", { step: "keywords" }, state);
  state = await ok("advance", { step: "personalize" }, state);
  const itemABinding = binding(state);
  state = await ok("save_draft", { draft: "Draft bound to item A.", clientDraftVersion: 1 }, state);
  const savedA = state;
  state = await ok("complete_item", { rating: "hard" }, state);
  const staleDraft = await raw(
    "save_draft",
    { ...itemABinding, draft: "Late draft for A.", clientDraftVersion: 2 },
    undefined,
  );
  if (staleDraft.status !== 409 || state.session.drafts[state.tasks[1].id]) {
    throw new Error("stale draft crossed into item B");
  }

  const target = state.tasks[1];
  let targeted = await ok("practice_item", {
    sourceType: target.sourceType,
    sourceItemId: target.sourceItemId,
  });
  if (targeted.tasks.length !== 1 || targeted.tasks[0].steps.at(-1) !== "free_speak") {
    throw new Error("targeted session is missing Free Speak");
  }
  targeted = await ok("advance", { step: "recall" }, targeted);
  targeted = await ok("advance", { step: "keywords" }, targeted);
  targeted = await ok("advance", { step: "personalize" }, targeted);
  const staleCheckBinding = binding(targeted);
  targeted = await ok(
    "save_draft",
    { draft: "I practice spoken English every day.", clientDraftVersion: 1 },
    targeted,
  );
  const staleCheck = await jsonRequest("/api/speaking/check-sentence", {
    lessonId: lesson.id,
    ...staleCheckBinding,
    sentence: "I practice spoken English every day.",
    clientCheckVersion: 1,
  });
  if (staleCheck.status !== 409) throw new Error("stale sentence check was not rejected");

  const rollbackSessionId = targeted.session.id;
  const triggerDatabase = new DatabaseSync(join(root, "data", "personal-english-lab.sqlite3"), {
    timeout: 5_000,
  });
  triggerDatabase.exec(
    "CREATE TRIGGER fail_speaking_insert BEFORE INSERT ON speaking_sessions BEGIN SELECT RAISE(FAIL, 'simulated insert failure'); END",
  );
  triggerDatabase.close();
  const failedStart = await raw("start_new");
  const cleanupDatabase = new DatabaseSync(join(root, "data", "personal-english-lab.sqlite3"));
  cleanupDatabase.exec("DROP TRIGGER fail_speaking_insert");
  cleanupDatabase.close();
  if (failedStart.status < 400 || (await latest()).session.id !== rollbackSessionId) {
    throw new Error("start-new rollback did not preserve the active session");
  }

  targeted = await latest();
  targeted = await ok("advance", { step: "free_speak" }, targeted);
  const targetId = targeted.tasks[0].id;
  const attemptsBefore = progress(targetId)?.attempt_count ?? 0;
  const completeBinding = binding(targeted);
  const duplicateComplete = await Promise.all([
    raw("complete_item", { rating: "easy" }, targeted),
    raw("complete_item", { rating: "easy" }, targeted),
  ]);
  if (
    duplicateComplete
      .map((result) => result.status)
      .sort()
      .join(",") !== "200,409"
  ) {
    throw new Error("duplicate complete did not produce one success and one conflict");
  }
  state = await latest();
  if (progress(targetId).attempt_count - attemptsBefore !== 1) {
    throw new Error("duplicate complete increased attempt count more than once");
  }
  const completedMutation = await raw(
    "complete_item",
    { ...completeBinding, rating: "easy" },
    undefined,
  );
  if (completedMutation.status !== 409) throw new Error("completed session accepted mutation");

  const attemptsBeforeBackup = progress(targetId).attempt_count;
  const exportedResponse = await fetch(`${base}/api/backup/export`);
  if (!exportedResponse.ok) throw new Error(`backup export failed ${exportedResponse.status}`);
  const backup = await exportedResponse.json();
  const replace = await jsonRequest("/api/backup/import", {
    action: "replace",
    backup,
    confirmReplace: true,
    allowRepeat: true,
  });
  if (replace.status !== 200) throw new Error(`backup replace failed ${replace.status}`);
  const restored = await latest();
  if (
    restored.session.id !== state.session.id ||
    restored.session.revision !== state.session.revision ||
    progress(targetId).attempt_count !== attemptsBeforeBackup
  ) {
    throw new Error("backup round trip did not preserve speaking state");
  }

  const deleteDatabase = new DatabaseSync(join(root, "data", "personal-english-lab.sqlite3"));
  deleteDatabase
    .prepare("UPDATE lessons SET deleted_at=? WHERE id=?")
    .run(new Date().toISOString(), deletedLesson.id);
  deleteDatabase.close();
  const daily = await ok("daily");
  if (daily.lessonId === deletedLesson.id || daily.lessonId !== lesson.id) {
    throw new Error("daily selected a soft-deleted lesson");
  }

  const databaseFile = await stat(join(root, "data", "personal-english-lab.sqlite3"));
  console.log(
    JSON.stringify(
      {
        health,
        resume: true,
        validLadderProgression: true,
        skipStepRejected: true,
        duplicateAdvanceConflict: true,
        duplicateCompleteSafe: true,
        completedMutationRejected: true,
        showAnswerIdempotent: true,
        targetedFreeSpeak: true,
        draftStableBinding: true,
        staleSentenceCheckRejected: true,
        startNewRollback: true,
        softDeletedDailyExcluded: true,
        backupRoundTrip: true,
        databaseBytes: databaseFile.size,
        savedDraftRevision: savedA.session.revision,
      },
      null,
      2,
    ),
  );
} finally {
  server.kill();
  await Promise.race([
    new Promise((resolveExit) => server.once("exit", resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  await rm(root, { recursive: true, force: true });
}
