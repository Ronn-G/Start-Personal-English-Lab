import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const port = "3248";
const base = `http://127.0.0.1:${port}`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "pel-security-smoke-"));
const server = spawn(process.execPath, [resolve(".next", "standalone", "server.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: port,
    GEMINI_API_KEY: "",
    PERSONAL_ENGLISH_LAB_DATA_DIR: join(temporaryRoot, "data"),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});

async function jsonMutation(path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function rawHostMutation(path, body, host, origin) {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path,
        method: "POST",
        headers: {
          Host: host,
          Origin: origin,
          "Content-Type": "application/json",
          "Content-Length": encoded.length,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, ok: response.statusCode === 200 }),
        );
      },
    );
    request.on("error", reject);
    request.end(encoded);
  });
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
    } catch {
      // Standalone server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  if (!health) throw new Error(`Security smoke server failed. ${stderr}`.trim());

  const localHost = `localhost:${port}`;
  const sameOrigin = await rawHostMutation(
    "/api/audio/cache",
    { action: "repair_invalid" },
    localHost,
    `http://${localHost}`,
  );
  const noOrigin = await jsonMutation("/api/audio/cache", { action: "repair_invalid" });
  const invalidHost = await rawHostMutation(
    "/api/audio/cache",
    { action: "repair_invalid" },
    `evil.test:${port}`,
    `http://evil.test:${port}`,
  );
  const crossOrigin = await jsonMutation(
    "/api/audio/cache",
    { action: "repair_invalid" },
    { Origin: "http://evil.test" },
  );
  const readWithForeignHost = await fetch(`${base}/api/storage/health`, {
    headers: { Host: `evil.test:${port}` },
  });
  const wrongMedia = await fetch(`${base}/api/audio/prepare`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not-json",
  });
  const invalidAudio = await jsonMutation("/api/audio/prepare", {
    text: "Hello",
    voice: "../../voices.bin",
  });
  const oversizedGenerate = await jsonMutation("/api/generate-lesson", {
    transcript: "x".repeat(70_000),
  });
  const validGenerate = await jsonMutation("/api/generate-lesson", {
    transcript: "A useful English transcript sentence. ".repeat(8),
  });
  const oversizedFeedback = await jsonMutation("/api/practice-feedback", {
    target: "target",
    answer: "x".repeat(40_000),
  });
  const oversizedSentence = await jsonMutation("/api/speaking/check-sentence", {
    filler: "x".repeat(6_000),
  });
  const exported = await fetch(`${base}/api/backup/export`);
  const backup = await exported.json();
  const backupDryRun = await jsonMutation("/api/backup/import", {
    action: "dry-run",
    backup,
  });

  const expected = [
    ["same-origin mutation", sameOrigin.status, 200],
    ["no-origin mutation", noOrigin.status, 200],
    ["invalid Host", invalidHost.status, 403],
    ["cross-origin mutation", crossOrigin.status, 403],
    ["read with foreign Host", readWithForeignHost.status, 200],
    ["wrong media type", wrongMedia.status, 415],
    ["invalid audio config", invalidAudio.status, 400],
    ["oversized generation", oversizedGenerate.status, 413],
    ["valid generation reaches provider boundary", validGenerate.status, 503],
    ["oversized feedback", oversizedFeedback.status, 413],
    ["oversized sentence check", oversizedSentence.status, 413],
    ["backup dry-run", backupDryRun.status, 200],
  ];
  for (const [label, actual, wanted] of expected) {
    if (actual !== wanted) throw new Error(`${label}: expected ${wanted}, got ${actual}.`);
  }
  console.log(
    JSON.stringify(
      {
        health,
        loopbackHostAccepted: sameOrigin.ok,
        noOriginServerProbeAccepted: noOrigin.ok,
        invalidHostRejected: invalidHost.status === 403,
        crossOriginRejected: crossOrigin.status === 403,
        readRouteUnchanged: readWithForeignHost.ok,
        wrongContentTypeRejected: wrongMedia.status === 415,
        invalidAudioConfigRejected: invalidAudio.status === 400,
        oversizedGenerationRejectedBeforeProvider: oversizedGenerate.status === 413,
        validGenerationReachedSafeProviderBoundary: validGenerate.status === 503,
        oversizedFeedbackRejected: oversizedFeedback.status === 413,
        oversizedSentenceCheckRejected: oversizedSentence.status === 413,
        backupDryRunPreserved: backupDryRun.ok,
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
