import {
  AUDIO_DEFAULTS,
  AudioQueue,
  buildCanonicalAudioRequest,
  canonicalAudioInput,
  rateToKokoroSpeed,
  type AudioConfig,
  type AudioErrorCode,
  type AudioPreparationStatus,
  type AudioPreloadItem,
  type AudioRetryMode,
  type AudioSourceType,
} from "./audio-domain";

const queue = new AudioQueue(1);
let lastHealth: { reachable: boolean; checkedAt: number } | undefined;

export interface AudioFailure {
  error: AudioErrorCode;
  summary: string;
  retryable: boolean;
  nextRetryAt: string | null;
}

export class AudioClientError extends Error implements AudioFailure {
  constructor(
    public readonly error: AudioErrorCode,
    public readonly summary: string,
    public readonly retryable: boolean,
    public readonly nextRetryAt: string | null = null,
  ) {
    super(error);
    this.name = "AudioClientError";
  }
}

export interface PrepareAudioOptions {
  retryMode?: AudioRetryMode;
  priority?: number;
  sourceType?: AudioSourceType;
}

export function buildAudioPreparationRequest(
  text: string,
  configOrSpeed: Partial<AudioConfig> | number = AUDIO_DEFAULTS,
) {
  const request = buildCanonicalAudioRequest(
    text,
    typeof configOrSpeed === "number" ? { speed: configOrSpeed } : configOrSpeed,
  );
  const { text: normalizedText, ...config } = request;
  return {
    key: canonicalAudioInput(normalizedText, config),
    body: { text: normalizedText, ...config },
  };
}

async function responseFailure(response: Response): Promise<AudioClientError> {
  const body = (await response.json().catch(() => ({}))) as Partial<AudioFailure>;
  return new AudioClientError(
    body.error ?? "KOKORO_UNAVAILABLE",
    body.summary ?? "Kokoro is unavailable.",
    body.retryable ?? response.status >= 500,
    body.nextRetryAt ?? null,
  );
}

async function prepareAudio(
  text: string,
  priority: number,
  lessonId: string,
  config: Partial<AudioConfig>,
  onStatus?: (status: AudioPreparationStatus) => void,
  options: PrepareAudioOptions = {},
) {
  const request = buildAudioPreparationRequest(text, config);
  return queue.enqueue({
    key: request.key,
    priority,
    lessonId,
    onStatus,
    request: async () => {
      const response = await fetch("/api/audio/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request.body,
          retryMode: options.retryMode ?? "automatic",
          priority,
          sourceType: options.sourceType,
        }),
      });
      if (!response.ok) throw await responseFailure(response);
      const body = (await response.json()) as { url: string };
      return body.url;
    },
  });
}

async function health(force = false) {
  if (!force && lastHealth && Date.now() - lastHealth.checkedAt < 5_000) {
    return {
      provider: "kokoro" as const,
      status: lastHealth.reachable ? "ready" : "unavailable",
      reachable: lastHealth.reachable,
    };
  }
  try {
    const response = await fetch("/api/audio/health", { cache: "no-store" });
    const body = (await response.json()) as {
      provider: "kokoro";
      status: "ready" | "unavailable";
      reachable: boolean;
      checkedAt?: string;
      error?: AudioErrorCode | null;
    };
    lastHealth = { reachable: response.ok && body.reachable, checkedAt: Date.now() };
    return body;
  } catch {
    lastHealth = { reachable: false, checkedAt: Date.now() };
    return {
      provider: "kokoro" as const,
      status: "unavailable" as const,
      reachable: false,
      error: "KOKORO_UNAVAILABLE" as const,
    };
  }
}

export const audioClient = {
  async preload(
    items: AudioPreloadItem[],
    onProgress?: (ready: number, total: number, failed: number) => void,
    onItemStatus?: (item: AudioPreloadItem, status: AudioPreparationStatus) => void,
  ) {
    let ready = 0;
    let failed = 0;
    const total = items.length;
    const provider = await health();
    if (!provider.reachable) {
      for (const item of items) onItemStatus?.(item, "failed");
      onProgress?.(0, total, total);
      return;
    }
    await Promise.allSettled(
      items.map((item) =>
        prepareAudio(
          item.text,
          item.priority,
          item.lessonId,
          item.config,
          (status) => onItemStatus?.(item, status),
          { retryMode: "preload", sourceType: item.sourceType },
        )
          .then(() => {
            ready += 1;
            onProgress?.(ready, total, failed);
          })
          .catch((error) => {
            if (error instanceof AudioClientError && error.error === "AUDIO_REQUEST_CANCELLED") {
              return;
            }
            failed += 1;
            onProgress?.(ready, total, failed);
          }),
      ),
    );
  },
  cancelLesson(id: string) {
    queue.cancelLesson(id);
  },
  prepare(
    text: string,
    lessonId = "user",
    rate = 0.86,
    onStatus?: (status: AudioPreparationStatus) => void,
    options: PrepareAudioOptions = {},
  ) {
    return prepareAudio(
      text,
      options.priority ?? 0,
      lessonId,
      { speed: rateToKokoroSpeed(rate) },
      onStatus,
      options,
    );
  },
  health,
};
