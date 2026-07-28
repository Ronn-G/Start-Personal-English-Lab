"use client";

import { useEffect, useState } from "react";

interface CacheInfo {
  count: number;
  bytes: number;
  ready: number;
  failed: number;
  generating: number;
  stale: number;
  queue: { concurrency: number; active: number; queued: number };
  lastError: { code: string | null; summary: string | null; at: string | null } | null;
}

interface HealthInfo {
  reachable: boolean;
  status: "ready" | "unavailable";
}

export default function AudioCacheControls() {
  const [info, setInfo] = useState<CacheInfo>();
  const [health, setHealth] = useState<HealthInfo>();
  const [checking, setChecking] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState<string>();

  async function load() {
    const response = await fetch("/api/audio/cache");
    if (response.ok) setInfo(await response.json());
  }

  async function checkHealth() {
    setChecking(true);
    setError(undefined);
    try {
      const response = await fetch("/api/audio/health", { cache: "no-store" });
      const body = (await response.json()) as HealthInfo;
      setHealth(body);
    } catch {
      setHealth({ reachable: false, status: "unavailable" });
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void Promise.resolve().then(() => Promise.all([load(), checkHealth()]));
  }, []);

  async function repair() {
    setRepairing(true);
    setError(undefined);
    try {
      const response = await fetch("/api/audio/cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repair_invalid" }),
      });
      if (!response.ok) throw new Error("REPAIR_FAILED");
      setInfo(await response.json());
    } catch {
      setError("Could not repair invalid audio entries.");
    } finally {
      setRepairing(false);
    }
  }

  return (
    <div className="mt-2 space-y-1 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-3">
        <span role="status">
          Kokoro:{" "}
          {checking || !health ? "Checking connection" : health.reachable ? "Ready" : "Unavailable"}
        </span>
        <button
          type="button"
          onClick={() => void checkHealth()}
          disabled={checking}
          className="font-bold text-primary underline disabled:opacity-50"
        >
          Retry connection
        </button>
        <span>
          Audio cache:{" "}
          {info
            ? `${info.ready} ready · ${info.failed} failed · ${(info.bytes / 1024 / 1024).toFixed(1)} MB`
            : "checking"}
        </span>
        <button
          type="button"
          onClick={() => void repair()}
          disabled={repairing}
          className="font-bold text-primary underline disabled:opacity-50"
        >
          {repairing ? "Repairing..." : "Repair invalid entries"}
        </button>
      </div>
      {info ? (
        <p>
          Queue: {info.queue.active} active · {info.queue.queued} queued · concurrency{" "}
          {info.queue.concurrency}
          {info.lastError
            ? ` · Last error: ${info.lastError.code ?? "unknown"} — ${info.lastError.summary ?? "Audio failed."}`
            : ""}
        </p>
      ) : null}
      {error ? (
        <span role="alert" className="text-wrong">
          {error}
        </span>
      ) : null}
    </div>
  );
}
