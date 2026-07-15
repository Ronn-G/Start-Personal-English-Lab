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
      body: JSON.stringify({ progress: { lessonId, progressVersion: 1, quizItems: {}, learningItems: {}, visitedSections: [], practiceHistory: [], createdAt: now, updatedAt: now } }),
    },
  );
  if (!progressResponse.ok) {
    throw new Error(`Save progress smoke failed (${progressResponse.status}).`);
  }
  const { progress } = await progressResponse.json();

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
        lessonCreatedWithStableId: /^[0-9a-f-]{36}$/.test(lesson.id),
        progressRoundTrip: progress.progress.lessonId === lessonId,
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
