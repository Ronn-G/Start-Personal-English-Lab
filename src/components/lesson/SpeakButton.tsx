"use client";

import { useEffect, useRef, useState } from "react";
import { audioClient } from "@/lib/audio-client";

interface SpeakButtonProps {
  text: string;
  label?: string;
  rate?: number;
}

type AudioSource = "kokoro" | "browser" | undefined;

export default function SpeakButton({ text, label = "Nghe", rate = 0.86 }: SpeakButtonProps) {
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<AudioSource>();
  const activeRef = useRef(true);

  useEffect(() => {
    return () => {
      activeRef.current = false;
    };
  }, []);

  async function speak(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!text.trim() || loading) return;

    setLoading(true);
    setSource(undefined);

    try {
      activeRef.current = true;
      await audioClient.play(text, "user", rate);
      if (activeRef.current) setSource("kokoro");
    } catch (error) {
      if (!activeRef.current) return;
      console.warn("Kokoro playback failed; using browser voice fallback.", error);
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        utterance.rate = rate;
        const voice = window.speechSynthesis.getVoices().find((item) => item.lang.startsWith("en"));
        if (voice) utterance.voice = voice;
        window.speechSynthesis.speak(utterance);
        setSource("browser");
      }
    } finally {
      setLoading(false);
    }
  }

  const title =
    source === "browser"
      ? "Kokoro chưa sẵn sàng. Đang dùng giọng trình duyệt."
      : source === "kokoro"
        ? "Nguồn âm thanh: Kokoro local"
        : `${label}: ${text}`;

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={speak}
        disabled={loading}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border-2 border-border bg-card px-3 py-1.5 text-xs font-extrabold text-primary shadow-sm transition ease-smooth hover:border-primary hover:bg-white disabled:cursor-wait disabled:opacity-70"
        aria-label={`${label}: ${text}`}
        title={title}
      >
        <span aria-hidden="true">🔊</span>
        {loading ? "Đang chuẩn bị..." : label}
      </button>
      {source ? (
        <span className="text-[11px] text-muted" role="status">
          {source === "kokoro" ? "Kokoro local" : "Browser voice fallback"}
        </span>
      ) : null}
    </span>
  );
}
