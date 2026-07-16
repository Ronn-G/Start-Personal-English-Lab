import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const port = "3217";
const temporaryRoot = await mkdtemp(join(tmpdir(), "pel-storage-smoke-"));
const dataDirectory = join(temporaryRoot, "data");
const serverPath = resolve(".next", "standalone", "server.js");
let stderr = "";
const lessonId = crypto.randomUUID();
const item = (extra) => ({ id: crypto.randomUUID(), ...extra });
const now = new Date().toISOString();
const canonicalLesson = {
  id: lessonId, schemaVersion: 1, createdAt: now, updatedAt: now,
  title: "Storage smoke lesson", summary: "Temporary standalone storage check.",
  vocabulary: Array.from({ length: 20 }, (_, i) => item({ word: `word ${i}`, phonetic: "/wɜːd/", definition: "definition", vietnamese: "từ" })),
  idiomsAndSlang: [item({ phrase: "break the ice", meaning: "start talking", vietnamese: "bắt chuyện" })],
  exampleSentences: Array.from({ length: 5 }, (_, i) => item({ sentence: `Sentence ${i}`, keyPhrase: "phrase", vietnamese: "Câu" })),
  quiz: Array.from({ length: 5 }, (_, i) => item({ question: `Question ${i}`, options: ["A", "B", "C", "D"], correctAnswer: 0, explanation: "Explanation" })),
  deepPractice: { shadowingPractice: { steps: ["1", "2", "3"], lines: Array.from({ length: 3 }, (_, i) => item({ line: `Line ${i}`, focus: "focus", vietnamese: "dòng" })) }, sentenceMining: Array.from({ length: 3 }, (_, i) => item({ sentence: `Mine ${i}`, pattern: "pattern", whyUseful: "useful", remixPrompt: "remix" })), reviewPlan: [1, 2, 4, 7].map((day) => ({ day: `Day ${day}`, task: "review" })), ankiCards: Array.from({ length: 5 }, (_, i) => item({ front: `Front ${i}`, back: "Back" })) },
};
const legacyLesson = structuredClone(canonicalLesson);
const stripIds = (value) => {
  if (Array.isArray(value)) return value.forEach(stripIds);
  if (!value || typeof value !== "object") return;
  delete value.id; delete value.schemaVersion; delete value.createdAt; delete value.updatedAt;
  Object.values(value).forEach(stripIds);
};
stripIds(legacyLesson);

const server = spawn(process.execPath, [serverPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: port,
    PERSONAL_ENGLISH_LAB_DATA_DIR: dataDirectory,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  let health;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/storage/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }

  if (!health) {
    throw new Error(`Standalone storage health failed. ${stderr}`.trim());
  }

  const migrationRecords = [{ legacyId: "smoke-legacy", lesson: legacyLesson, createdAt: now, updatedAt: now, progress: { answeredQuestions: [0, 3, 99] } }];
  const migrationRequest = (action) => fetch(`http://127.0.0.1:${port}/api/storage/migration`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, migrationId: "localstorage-lessons-v1", records: migrationRecords }) });
  const dryResponse = await migrationRequest("dry-run");
  if (!dryResponse.ok) throw new Error(`Migration dry-run failed (${dryResponse.status}).`);
  const dryRun = await dryResponse.json();
  const commitResponse = await migrationRequest("commit");
  if (!commitResponse.ok) throw new Error(`Migration commit failed (${commitResponse.status}).`);
  const migration = await commitResponse.json();
  const retryResponse = await migrationRequest("commit");
  if (!retryResponse.ok) throw new Error(`Migration retry failed (${retryResponse.status}).`);
  const migrationRetry = await retryResponse.json();

  const lessonResponse = await fetch(`http://127.0.0.1:${port}/api/storage/lessons`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lesson: canonicalLesson,
    }),
  });
  if (lessonResponse.status !== 201) {
    throw new Error(`Create lesson smoke failed (${lessonResponse.status}).`);
  }
  const { lesson } = await lessonResponse.json();

  const progressResponse = await fetch(
    `http://127.0.0.1:${port}/api/storage/lessons/${lesson.id}/progress`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress: { lessonId, progressVersion: 1, quizItems: { [canonicalLesson.quiz[0].id]: { itemId: canonicalLesson.quiz[0].id, selectedAnswer: 0, correct: true, attemptCount: 1, answeredAt: now, completed: true } }, learningItems: {}, visitedSections: ["quiz"], practiceHistory: [], createdAt: now, updatedAt: now } }),
    },
  );
  if (!progressResponse.ok) {
    throw new Error(`Save progress smoke failed (${progressResponse.status}).`);
  }
  const { progress } = await progressResponse.json();
  const listResponse = await fetch(`http://127.0.0.1:${port}/api/storage/lessons`);
  const { lessons } = await listResponse.json();

  const deleteResponse = await fetch(
    `http://127.0.0.1:${port}/api/storage/lessons/${lesson.id}`,
    { method: "DELETE" },
  );
  if (deleteResponse.status !== 204) {
    throw new Error(`Delete lesson smoke failed (${deleteResponse.status}).`);
  }

  const database = await stat(join(dataDirectory, "personal-english-lab.sqlite3"));
  console.log(
    JSON.stringify(
      {
        health,
        migrationDryRunDidNotWrite: dryRun.preview.validLessons === 1,
        migrationCommitted: migration.status.migratedLessons === 1,
        migrationRetryIdempotent: migrationRetry.preview.existingLessons === 1,
        lessonCreatedWithStableId: /^[0-9a-f-]{36}$/.test(lesson.id),
        progressRoundTrip: progress.progress.lessonId === lessonId && Boolean(progress.progress.quizItems[canonicalLesson.quiz[0].id]),
        listReturnsSummaries: lessons.length === 2 && lessons.every((item) => !("lesson" in item)),
        lessonSoftDeleted: deleteResponse.status === 204,
        databaseCreated: database.isFile(),
        databaseBytes: database.size,
      },
      null,
      2,
    ),
  );
} finally {
  server.kill();
  await Promise.race([
    new Promise((resolveExit) => server.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  await rm(temporaryRoot, { recursive: true, force: true });
}
