"use client";

import { useEffect, useRef, useState } from "react";

const KOKORO_TTS_URL = "http://127.0.0.1:5050/tts";
const KOKORO_VOICE = "af_sarah";

interface SpeakButtonProps {
  text: string;
  label?: string;
  rate?: number;
}

async function fetchKokoroAudio(text: string, rate: number): Promise<Blob> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(KOKORO_TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: KOKORO_VOICE,
        speed: Math.min(Math.max(rate / 0.86, 0.65), 1.35),
        lang: "en-us",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Kokoro TTS failed (${response.status}): ${detail}`);
    }

    return response.blob();
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function SpeakButton({
  text,
  label = "Nghe",
  rate = 0.86,
}: SpeakButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function speak(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!text.trim() || loading) return;

    setLoading(true);
    setError(false);

    try {
      audioRef.current?.pause();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }

      const audioBlob = await fetchKokoroAudio(text, rate);
      const objectUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      objectUrlRef.current = objectUrl;
      await audio.play();
    } catch (kokoroError) {
      console.error("Không thể phát giọng Kokoro ONNX.", kokoroError);
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  const title = error
    ? "Kokoro ONNX chưa chạy. Hãy mở app bằng Start Personal English Lab.vbs."
    : `${label}: ${text}`;

  return (
    <button
      type="button"
      onClick={speak}
      disabled={loading}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border-2 border-border bg-card px-3 py-1.5 text-xs font-extrabold text-primary shadow-sm transition ease-smooth hover:border-primary hover:bg-white disabled:cursor-wait disabled:opacity-70"
      aria-label={`${label}: ${text}`}
      title={title}
    >
      <span aria-hidden="true">🔊</span>
      {loading ? "Đang tạo..." : error ? "Kokoro chưa chạy" : label}
    </button>
  );
}
