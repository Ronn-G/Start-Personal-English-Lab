import {
  AUDIO_DEFAULTS,
  AudioQueue,
  canonicalAudioInput,
  rateToKokoroSpeed,
  type AudioPreparationStatus,
  type AudioPreloadItem,
} from "./audio-domain";

const queue = new AudioQueue(1);
let current: HTMLAudioElement | undefined;

async function prepareAudio(
  text: string,
  priority: number,
  lessonId: string,
  speed = 1,
  onStatus?: (status: AudioPreparationStatus) => void,
) {
  const config = { ...AUDIO_DEFAULTS, speed };
  const key = canonicalAudioInput(text, config);
  return queue.enqueue({
    key,
    priority,
    lessonId,
    onStatus,
    request: async () => {
      const response = await fetch("/api/audio/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: config.voice, speed: config.speed }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "AUDIO_FAILED");
      return body.url as string;
    },
  });
}

export const audioClient = {
  preload(
    items: AudioPreloadItem[],
    onProgress?: (ready: number, total: number, failed: number) => void,
    onItemStatus?: (item: AudioPreloadItem, status: AudioPreparationStatus) => void,
  ) {
    let ready = 0;
    let failed = 0;
    const total = items.length;
    for (const item of items) {
      prepareAudio(item.text, item.priority, item.lessonId, item.config.speed, (status) =>
        onItemStatus?.(item, status),
      )
        .then(() => {
          ready++;
          onProgress?.(ready, total, failed);
        })
        .catch((error) => {
          failed++;
          console.warn("Kokoro audio preload failed.", error);
          onProgress?.(ready, total, failed);
        });
    }
  },
  cancelLesson(id: string) {
    queue.cancelLesson(id);
  },
  async prepare(text: string, lessonId = "user", rate = 0.86) {
    return prepareAudio(text, 0, lessonId, rateToKokoroSpeed(rate));
  },
  async play(text: string, lessonId = "user", rate = 0.86) {
    const speed = rateToKokoroSpeed(rate);
    const url = await prepareAudio(text, 0, lessonId, speed);
    current?.pause();
    current = new Audio(url);
    await current.play();
    return { source: "kokoro" as const };
  },
  stop() {
    current?.pause();
    current = undefined;
  },
};
