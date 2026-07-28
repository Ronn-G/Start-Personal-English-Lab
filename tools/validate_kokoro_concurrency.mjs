const baseUrl = process.env.KOKORO_BASE_URL ?? "http://127.0.0.1:5050";

const cases = [
  { name: "short", text: "Consistent practice builds confidence." },
  {
    name: "long",
    text: "Careful listening helps learners notice connected speech, useful phrases, rhythm, stress, and pronunciation in realistic sentences. "
      .repeat(5)
      .trim(),
  },
  { name: "vocabulary", text: "Resilient." },
  { name: "idiom", text: "Keep your chin up when practice feels demanding." },
  {
    name: "grammar",
    text: "If I had practiced earlier, I would have felt more confident.",
  },
  {
    name: "listening",
    text: "Listen once for meaning, then listen again for details.",
  },
  {
    name: "unicode",
    text: "Café learners ask: Are quotes, dashes — and symbols handled clearly?",
  },
  {
    name: "punctuation",
    text: "Wait... really? Yes! Repeat, pause, and continue.",
  },
];

function validWav(bytes, contentType) {
  return (
    contentType.includes("audio") &&
    bytes.length > 44 &&
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WAVE"
  );
}

async function synthesize(entry) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: entry.text,
        voice: "af_sarah",
        speed: 1,
        lang: "en-us",
      }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      name: entry.name,
      ok: response.ok && validWav(bytes, response.headers.get("content-type") ?? ""),
      status: response.status,
      bytes: bytes.length,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: response.ok ? null : `HTTP_${response.status}`,
    };
  } catch (error) {
    return {
      name: entry.name,
      ok: false,
      status: 0,
      bytes: 0,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: error?.cause?.code ?? error?.name ?? "UNKNOWN",
    };
  }
}

const healthBefore = await (await fetch(`${baseUrl}/health`)).json();
const single = await synthesize({
  name: "single",
  text: "This is a single synthesis validation.",
});

const batchStartedAt = performance.now();
const batch = await Promise.all(cases.map(synthesize));
const batchDurationMs = Math.round(performance.now() - batchStartedAt);

const invalidResponse = await fetch(`${baseUrl}/tts`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    text: "",
    voice: "af_sarah",
    speed: 1,
    lang: "en-us",
  }),
});
const afterError = await synthesize({
  name: "after-error",
  text: "Synthesis continues after a rejected request.",
});
const healthAfter = await (await fetch(`${baseUrl}/health`)).json();

const report = {
  healthBefore,
  healthAfter,
  single,
  batchCount: batch.length,
  batchSuccess: batch.filter((item) => item.ok).length,
  batchFailures: batch.filter((item) => !item.ok).length,
  batchErrorCodes: [...new Set(batch.filter((item) => !item.ok).map((item) => item.errorCode))],
  batchDurationMs,
  completionSpreadMs:
    Math.max(...batch.map((item) => item.durationMs)) -
    Math.min(...batch.map((item) => item.durationMs)),
  batch,
  controlledInvalidStatus: invalidResponse.status,
  afterError,
};

console.log(JSON.stringify(report, null, 2));

if (
  !single.ok ||
  batch.some((item) => !item.ok) ||
  invalidResponse.status !== 400 ||
  !afterError.ok ||
  healthAfter.status !== "ok"
) {
  process.exitCode = 1;
}
