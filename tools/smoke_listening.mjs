import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pel-listening-e2e-"));
const port = "3231";
const baseUrl = `http://127.0.0.1:${port}`;
const serverPath = resolve(".next", "standalone", "server.js");
const dataDirectory = join(temporaryRoot, "data");
let stderr = "";
const kokoroRequests = [];
const wav = Buffer.alloc(64);
wav.write("RIFF", 0);
wav.write("WAVE", 8);
const kokoro = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/tts") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    kokoroRequests.push(JSON.parse(raw));
    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
    });
    response.end(wav);
  });
});
await new Promise((resolveListen) => kokoro.listen(0, "127.0.0.1", resolveListen));
const kokoroAddress = kokoro.address();
if (!kokoroAddress || typeof kokoroAddress === "string") {
  throw new Error("Mock Kokoro did not bind to a TCP port.");
}

const server = spawn(process.execPath, [serverPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: port,
    PERSONAL_ENGLISH_LAB_DATA_DIR: dataDirectory,
    KOKORO_BASE_URL: `http://127.0.0.1:${kokoroAddress.port}`,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const makeId = () => crypto.randomUUID();
const makeItem = (extra) => ({ id: makeId(), ...extra });
const now = new Date().toISOString();

function lessonFixture(title) {
  const lessonId = makeId();
  return {
    id: lessonId,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    title,
    summary: "Daily listening helps familiar phrases become easier to hear.",
    vocabulary: Array.from({ length: 20 }, (_, index) =>
      makeItem({
        word: `word ${index}`,
        definition: "definition",
        vietnamese: "từ",
        ...(index === 0 ? { context: "I notice this useful word in a real conversation." } : {}),
      }),
    ),
    idiomsAndSlang: [
      makeItem({
        phrase: "keep going",
        meaning: "continue",
        vietnamese: "tiếp tục",
      }),
    ],
    exampleSentences: Array.from({ length: 5 }, (_, index) =>
      makeItem({
        sentence: `I practice listening for ${index + 10} minutes every day.`,
        keyPhrase: "practice listening",
        vietnamese: "Tôi luyện nghe mỗi ngày.",
      }),
    ),
    quiz: Array.from({ length: 5 }, () =>
      makeItem({
        question: "What is the main idea?",
        options: ["A", "B", "C", "D"],
        correctAnswer: 0,
        explanation: "Daily practice helps.",
      }),
    ),
    deepPractice: {
      shadowingPractice: {
        steps: ["Listen", "Repeat", "Shadow"],
        lines: [
          makeItem({
            line: "Small habits make listening feel natural.",
            focus: "small habits",
            vietnamese: "Thói quen nhỏ giúp việc nghe tự nhiên hơn.",
          }),
          makeItem({
            line: "I follow the main idea before every detail.",
            focus: "main idea",
            vietnamese: "Tôi theo ý chính trước mọi chi tiết.",
          }),
          makeItem({
            line: "Familiar phrases become easier to hear.",
            focus: "familiar phrases",
            vietnamese: "Cụm từ quen thuộc trở nên dễ nghe hơn.",
          }),
        ],
      },
      sentenceMining: Array.from({ length: 3 }, (_, index) =>
        makeItem({
          sentence: `Listening loop number ${index + 1} helps me notice more.`,
          pattern: "helps me notice",
          whyUseful: "Reusable pattern",
          remixPrompt: "Make it personal.",
        }),
      ),
      reviewPlan: [1, 2, 4, 7].map((day) => ({
        day: `Day ${day}`,
        task: "Listen again.",
      })),
      ankiCards: Array.from({ length: 5 }, () => makeItem({ front: "listen", back: "nghe" })),
    },
  };
}

const lesson = lessonFixture("Listening smoke lesson");
const otherLesson = lessonFixture("Isolated lesson");

async function postListening(action, extra = {}) {
  const response = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, lessonId: lesson.id, ...extra }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function prepareAudio(item) {
  const response = await fetch(`${baseUrl}/api/audio/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: item.text, speed: 1 }),
  });
  const body = await response.json();
  if (
    !response.ok ||
    body.provider !== "kokoro" ||
    body.status !== "ready" ||
    typeof body.url !== "string"
  ) {
    throw new Error(
      `Kokoro preparation failed (${response.status}): ${JSON.stringify(body)}; ` +
        `mock requests=${kokoroRequests.length}; server stderr=${stderr}`,
    );
  }
  return body;
}

try {
  let health;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/storage/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      // Standalone server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  if (!health) throw new Error(`Standalone server failed. ${stderr}`.trim());
  if (health.schemaVersion !== 8) throw new Error("Listening schema is not v8.");

  for (const currentLesson of [lesson, otherLesson]) {
    const response = await fetch(`${baseUrl}/api/storage/lessons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lesson: currentLesson }),
    });
    if (response.status !== 201) {
      throw new Error(`Create lesson failed (${response.status}): ${await response.text()}`);
    }
  }

  const malformed = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lessonId: lesson.id }),
  });
  if (malformed.status !== 400) throw new Error("Malformed listening command was not rejected.");
  const missingLesson = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", lessonId: makeId() }),
  });
  if (missingLesson.status !== 404) throw new Error("Missing listening lesson was not rejected.");

  const started = await postListening("start");
  const resumed = await postListening("start");
  if (
    !started.items.length ||
    started.session.id !== resumed.session.id ||
    started.session.currentStep !== "first_listen"
  ) {
    throw new Error("Start/resume listening failed.");
  }
  const sessionId = started.session.id;
  const itemId = started.items[0].id;
  const sourceTypes = ["shadowing", "example", "sentence_mining", "vocabulary"];
  const sourceItems = sourceTypes.map((sourceType) => {
    const item = started.items.find((candidate) => candidate.sourceType === sourceType);
    if (!item) throw new Error(`Missing ${sourceType} listening fixture.`);
    return item;
  });
  const firstAudioPair = await Promise.all([
    prepareAudio(sourceItems[0]),
    prepareAudio(sourceItems[0]),
  ]);
  const remainingAudio = await Promise.all(sourceItems.slice(1).map(prepareAudio));
  const audioResults = [firstAudioPair[0], ...remainingAudio];
  if (
    new Set(audioResults.map((result) => result.url)).size !== sourceItems.length ||
    firstAudioPair[0].url !== firstAudioPair[1].url ||
    kokoroRequests.length !== sourceItems.length
  ) {
    throw new Error("Kokoro source preparation did not coalesce or isolate cache keys.");
  }
  for (const item of sourceItems) {
    if (!kokoroRequests.some((request) => request.text === item.text)) {
      throw new Error(`Kokoro received the wrong text for ${item.sourceType}.`);
    }
  }

  let state = await postListening("save_first_listen", {
    sessionId,
    comprehension: "some_parts",
    note: "I heard the topic.",
  });
  if (state.session.currentStep !== "check_meaning") {
    throw new Error("First Listen did not persist.");
  }
  state = await postListening("reveal_item", { sessionId, itemId });
  state = await postListening("record_listen", { sessionId, itemId });
  state = await postListening("record_loop", { sessionId, itemId, count: 3 });
  state = await postListening("mark_difficult", { sessionId, itemId });
  const itemProgress = state.items.find((item) => item.id === itemId)?.progress;
  if (
    !itemProgress ||
    itemProgress.listenCount !== 4 ||
    itemProgress.loopCount !== 3 ||
    !itemProgress.difficult
  ) {
    throw new Error("Listening item progress did not persist.");
  }
  const listeningItem = state.items.find((item) => item.id === itemId);
  const speakingResponse = await fetch(`${baseUrl}/api/speaking`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "practice_item",
      lessonId: lesson.id,
      sourceType: listeningItem.sourceType,
      sourceItemId: listeningItem.sourceItemId,
    }),
  });
  const speaking = await speakingResponse.json();
  if (
    !speakingResponse.ok ||
    speaking.tasks.length !== 1 ||
    speaking.tasks[0].sourceItemId !== listeningItem.sourceItemId
  ) {
    throw new Error("Listening to Speaking Ladder source link failed.");
  }

  const invalidTransition = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "advance_step",
      lessonId: lesson.id,
      sessionId,
      nextStep: "final_relisten",
    }),
  });
  if (invalidTransition.status !== 409) {
    throw new Error("Invalid listening transition was not rejected.");
  }
  const invalidItem = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "record_listen",
      lessonId: lesson.id,
      sessionId,
      itemId: "li-invalid",
    }),
  });
  if (invalidItem.status !== 400) throw new Error("Invalid listening item was not rejected.");
  const wrongPair = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "record_listen",
      lessonId: otherLesson.id,
      sessionId,
      itemId,
    }),
  });
  if (wrongPair.status !== 404) throw new Error("Wrong lesson/session pair was not rejected.");
  const invalidSession = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "record_listen",
      lessonId: lesson.id,
      sessionId: makeId(),
      itemId,
    }),
  });
  if (invalidSession.status !== 404) throw new Error("Invalid listening session was not rejected.");

  state = await postListening("advance_step", {
    sessionId,
    nextStep: "second_listen",
  });
  state = await postListening("save_second_listen", {
    sessionId,
    comprehension: "main_idea",
  });
  if (state.session.currentStep !== "sentence_review") {
    throw new Error("Second Listen did not persist.");
  }
  for (const item of sourceItems) {
    state = await postListening("mark_recognized", { sessionId, itemId: item.id });
    state = await postListening("mark_difficult", { sessionId, itemId: item.id });
    const progress = state.items.find((candidate) => candidate.id === item.id)?.progress;
    if (!progress || progress.recognitionStatus !== "recognized" || !progress.difficult) {
      throw new Error(`Independent progress failed for ${item.sourceType}.`);
    }
  }
  state = await postListening("advance_step", {
    sessionId,
    nextStep: "final_relisten",
  });
  state = await postListening("complete", {
    sessionId,
    rating: "easier",
    note: "The familiar phrases were clearer.",
  });
  if (state.session.status !== "completed" || state.session.currentStep !== "complete") {
    throw new Error("Listening completion failed.");
  }
  const completedMutation = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "record_listen",
      lessonId: lesson.id,
      sessionId,
      itemId,
    }),
  });
  if (completedMutation.status !== 409) {
    throw new Error("Completed listening session mutation was not rejected.");
  }

  const reloaded = await postListening("status");
  if (
    reloaded.session.id !== sessionId ||
    reloaded.session.firstListenComprehension !== "some_parts" ||
    reloaded.session.secondListenComprehension !== "main_idea" ||
    sourceItems.some((item) => {
      const progress = reloaded.items.find((candidate) => candidate.id === item.id)?.progress;
      return !progress || progress.recognitionStatus !== "recognized" || !progress.difficult;
    })
  ) {
    throw new Error("Listening reload persistence failed.");
  }
  const dashboard = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "dashboard" }),
  }).then((response) => response.json());
  if (
    !dashboard.review.some(
      (entry) => entry.lessonId === lesson.id && entry.difficultCount === sourceItems.length,
    )
  ) {
    throw new Error("Difficult listening items did not appear in Re-listen review.");
  }
  const otherStatus = await fetch(`${baseUrl}/api/listening`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "status", lessonId: otherLesson.id }),
  }).then((response) => response.json());
  if (otherStatus.session !== null) throw new Error("Lesson isolation failed.");

  const backup = await fetch(`${baseUrl}/api/backup/export`).then((response) => response.json());
  if (
    backup.listeningSessions.length !== 1 ||
    backup.listeningItemProgress.length !== sourceItems.length ||
    "audioCache" in backup
  ) {
    throw new Error("Listening backup export failed.");
  }

  const database = await stat(join(dataDirectory, "personal-english-lab.sqlite3"));
  console.log(
    JSON.stringify(
      {
        health,
        activeSessionCoalesced: true,
        firstListenSaved: true,
        itemListenCount: 4,
        itemLoopCount: 3,
        secondListenSaved: true,
        completed: true,
        reloadPersisted: true,
        lessonIsolation: true,
        invalidTransitionRejected: true,
        malformedPayloadRejected: true,
        completedMutationRejected: true,
        kokoroSourceTypesReady: sourceTypes,
        kokoroRequests: kokoroRequests.length,
        duplicateAudioCoalesced: true,
        difficultReviewCount: sourceItems.length,
        speakingSourceLinked: true,
        backupListeningSessions: backup.listeningSessions.length,
        backupListeningItems: backup.listeningItemProgress.length,
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
  await new Promise((resolveClose) => kokoro.close(resolveClose));
  await rm(temporaryRoot, { recursive: true, force: true });
}
