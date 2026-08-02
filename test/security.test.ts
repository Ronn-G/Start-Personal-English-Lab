import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_DEFAULTS,
  buildCanonicalAudioRequest,
  resolveAudioConfig,
} from "../src/lib/audio-domain";
import {
  AudioServiceError,
  ServerSynthesisQueue,
  audioCacheKey,
  resolveKokoroBaseUrl,
  type AudioResult,
} from "../src/server/audio/audio-cache";
import { LocalAdmissionGate } from "../src/server/security/admission";
import {
  ApiRequestError,
  assertLocalMutationRequest,
  readBoundedJsonBody,
} from "../src/server/security/local-request";

function jsonRequest(
  host: string,
  body: string,
  options: { origin?: string; contentType?: string; contentLength?: string } = {},
) {
  const headers = new Headers({
    Host: host,
    "Content-Type": options.contentType ?? "application/json",
  });
  if (options.origin) headers.set("Origin", options.origin);
  if (options.contentLength) headers.set("Content-Length", options.contentLength);
  return new Request(`http://${host}/api/test`, { method: "POST", headers, body });
}

function expectApiError(operation: () => unknown, status: number, code: string) {
  assert.throws(operation, (error: unknown) => {
    return error instanceof ApiRequestError && error.status === status && error.code === code;
  });
}

test("local mutation policy accepts loopback same-origin and rejects foreign boundaries", () => {
  assert.doesNotThrow(() =>
    assertLocalMutationRequest(
      jsonRequest("localhost:3000", "{}", { origin: "http://localhost:3000" }),
    ),
  );
  assert.doesNotThrow(() => assertLocalMutationRequest(jsonRequest("127.0.0.1:4312", "{}")));
  assert.doesNotThrow(() =>
    assertLocalMutationRequest(jsonRequest("[::1]:3000", "{}", { origin: "http://[::1]:3000" })),
  );
  expectApiError(
    () => assertLocalMutationRequest(jsonRequest("192.168.1.5:3000", "{}")),
    403,
    "LOCAL_HOST_REQUIRED",
  );
  expectApiError(
    () =>
      assertLocalMutationRequest(
        jsonRequest("localhost:3000", "{}", { origin: "http://evil.test" }),
      ),
    403,
    "CROSS_ORIGIN_MUTATION_REJECTED",
  );
  expectApiError(
    () =>
      assertLocalMutationRequest(
        jsonRequest("localhost:3000", "{}", { origin: "http://127.0.0.1:3000" }),
      ),
    403,
    "CROSS_ORIGIN_MUTATION_REJECTED",
  );
  expectApiError(
    () =>
      assertLocalMutationRequest(
        jsonRequest("localhost:3000", "{}", { origin: "http://localhost:3000/not-an-origin" }),
      ),
    403,
    "CROSS_ORIGIN_MUTATION_REJECTED",
  );
});

test("bounded JSON reader distinguishes media, size, and malformed failures", async () => {
  assert.deepEqual(
    await readBoundedJsonBody(
      jsonRequest("127.0.0.1:3000", '{"ok":true}', {
        contentType: "application/json; charset=UTF-8",
      }),
      32,
    ),
    { ok: true },
  );
  await assert.rejects(
    () => readBoundedJsonBody(jsonRequest("localhost:3000", "{}", { contentType: "text/plain" })),
    (error: unknown) => error instanceof ApiRequestError && error.status === 415,
  );
  await assert.rejects(
    () => readBoundedJsonBody(jsonRequest("localhost:3000", "{}", { contentLength: "999" }), 10),
    (error: unknown) => error instanceof ApiRequestError && error.status === 413,
  );
  await assert.rejects(
    () =>
      readBoundedJsonBody(
        jsonRequest("localhost:3000", JSON.stringify({ value: "x".repeat(30) })),
        20,
      ),
    (error: unknown) => error instanceof ApiRequestError && error.status === 413,
  );
  await assert.rejects(
    () => readBoundedJsonBody(jsonRequest("localhost:3000", "{"), 20),
    (error: unknown) => error instanceof ApiRequestError && error.status === 400,
  );
});

test("audio config rejects explicit invalid variants and preserves canonical defaults", () => {
  assert.deepEqual(resolveAudioConfig(), AUDIO_DEFAULTS);
  for (const invalid of [
    { speed: Number.NaN },
    { speed: 0.1 },
    { speed: 9 },
    { voice: "../../voices.bin" },
    { language: "x".repeat(200) },
    { modelVersion: "other-model" },
    { normalizationVersion: 2 },
    { format: "mp3" },
  ]) {
    assert.throws(() => resolveAudioConfig(invalid as never), /INVALID_AUDIO_REQUEST/);
  }
  const first = buildCanonicalAudioRequest("  Hello   world  ");
  const second = buildCanonicalAudioRequest("Hello world", { ...AUDIO_DEFAULTS });
  assert.equal(audioCacheKey(first.text, first), audioCacheKey(second.text, second));
  assert.throws(() => buildCanonicalAudioRequest("😀".repeat(651)), /INVALID_AUDIO_REQUEST/);
  assert.equal(resolveKokoroBaseUrl("http://localhost:5050"), "http://localhost:5050");
  assert.throws(() => resolveKokoroBaseUrl("http://192.168.1.5:5050"));
  assert.throws(() => resolveKokoroBaseUrl("https://127.0.0.1:5050"));
});

test("local operation admission is bounded and releases capacity after completion", async () => {
  const gate = new LocalAdmissionGate("test operation", 1, 1, 1_000);
  let releaseFirst!: () => void;
  const first = gate.run(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = gate.run(async () => "second");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    () => gate.run(async () => "overflow"),
    (error: unknown) => error instanceof ApiRequestError && error.status === 429,
  );
  releaseFirst();
  await first;
  assert.equal(await second, "second");
  assert.equal(await gate.run(async () => "recovered"), "recovered");
  assert.deepEqual(gate.info(), {
    name: "test operation",
    maxInFlight: 1,
    maxWaiting: 1,
    active: 0,
    waiting: 0,
  });
});

test("server audio queue rejects overflow, coalesces duplicates, and recovers", async () => {
  const queue = new ServerSynthesisQueue(1);
  let release!: () => void;
  const result = (key: string): AudioResult => ({
    cacheKey: key,
    url: `/api/audio/${key}`,
    cacheHit: false,
    sizeBytes: 48,
    provider: "kokoro",
    status: "ready",
  });
  const active = queue.enqueue(
    "a",
    0,
    () =>
      new Promise<AudioResult>((resolve) => {
        release = () => resolve(result("a"));
      }),
  );
  const duplicate = queue.enqueue("a", 0, async () => result("duplicate"));
  const waiting = queue.enqueue("b", 1, async () => result("b"));
  await assert.rejects(
    () => queue.enqueue("c", 2, async () => result("c")),
    (error: unknown) =>
      error instanceof AudioServiceError && error.code === "AUDIO_CAPACITY_EXCEEDED",
  );
  release();
  assert.equal((await active).cacheKey, "a");
  assert.equal((await duplicate).cacheKey, "a");
  assert.equal((await waiting).cacheKey, "b");
  assert.equal((await queue.enqueue("d", 0, async () => result("d"))).cacheKey, "d");
});
