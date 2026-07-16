"use client";

import { useEffect, useRef, useState } from "react";
import { audioClient } from "@/lib/audio-client";

interface SpeakButtonProps {
  text: string;
  label?: string;
  rate?: number;
}

export default function SpeakButton({
  text,
  label = "Nghe",
  rate = 0.86,
}: SpeakButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const activeRef = useRef(true);

  useEffect(() => {
    return () => {
      activeRef.current=false;
    };
  }, []);

  async function speak(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!text.trim() || loading) return;

    setLoading(true);
    setError(false);

    try {
      activeRef.current=true; await audioClient.play(text,"user",rate);
    } catch {
      if(!activeRef.current)return;setError(true);if("speechSynthesis" in window){window.speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang="en-US";utterance.rate=rate;const voice=window.speechSynthesis.getVoices().find(v=>v.lang.startsWith("en"));if(voice)utterance.voice=voice;window.speechSynthesis.speak(utterance);}
    } finally {
      setLoading(false);
    }
  }

  const title = error
    ? "Kokoro chưa sẵn sàng; đang dùng giọng trình duyệt."
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
      {loading ? "Đang chuẩn bị..." : error ? "Giọng trình duyệt" : label}
    </button>
  );
}
