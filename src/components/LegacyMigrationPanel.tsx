"use client";

import { useEffect, useRef, useState } from "react";

import { readLegacyStorage, type LegacyReadResult } from "@/lib/legacy-storage-reader";
import { storageClient } from "@/lib/storage-client";
import type { MigrationPreview, MigrationStatus } from "@/server/storage/legacy-migration";

export default function LegacyMigrationPanel({ onMigrated }: { onMigrated: () => void }) {
  const [legacy, setLegacy] = useState<LegacyReadResult | null>(null);
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCompleted, setJustCompleted] = useState(false);
  const requestInFlight = useRef(false);

  useEffect(() => {
    Promise.resolve().then(() => setLegacy(readLegacyStorage(window.localStorage)));
    storageClient.getMigrationStatus().then(setStatus).catch((reason) => setError(reason instanceof Error ? reason.message : "Không đọc được trạng thái migration."));
  }, []);

  if (!legacy || (legacy.detectedCount === 0 && legacy.diagnostics.length === 0) || deferred || (status?.status === "completed" && !justCompleted)) return null;

  if (status?.status === "completed" && justCompleted) {
    return <section className="rounded-2xl border-2 border-correct bg-correct-light p-5 text-sm font-bold text-heading">Chuyển dữ liệu thành công. Dữ liệu localStorage cũ vẫn được giữ nguyên làm bản dự phòng tạm thời.</section>;
  }

  async function check() {
    if (!legacy || legacy.records.length === 0 || requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(true); setError(null);
    try { setPreview(await storageClient.previewLegacyMigration(legacy.records)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Không thể kiểm tra dữ liệu cũ."); }
    finally { requestInFlight.current = false; setBusy(false); }
  }

  async function migrate() {
    if (!legacy || !preview || requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(true); setError(null);
    try {
      const result = await storageClient.commitLegacyMigration(legacy.records);
      setStatus(result.status); setPreview(result.preview); setJustCompleted(true); onMigrated();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Chuyển dữ liệu thất bại; dữ liệu cũ vẫn được giữ nguyên."); }
    finally { requestInFlight.current = false; setBusy(false); }
  }

  return (
    <section className="rounded-2xl border-2 border-primary bg-highlight p-5 shadow-sm sm:p-6">
      <h2 className="text-lg font-extrabold text-heading">Chuyển bài học cũ</h2>
      <p className="mt-2 text-sm leading-6 text-body">Ứng dụng đã chuyển sang hệ thống lưu trữ mới. Hãy chuyển các bài học cũ sang SQLite để dữ liệu được lưu ổn định hơn.</p>
      <p className="mt-2 text-sm font-bold text-heading">Phát hiện {legacy.detectedCount} bài. Dữ liệu localStorage cũ sẽ được giữ nguyên.</p>
      {legacy.diagnostics.length > 0 ? <div className="mt-3 rounded-xl border-2 border-border bg-card p-3 text-sm text-body">
        {legacy.diagnostics.slice(0, 8).map((diagnostic, index) => <p key={`${diagnostic.code}-${diagnostic.recordIndex ?? index}`}>{diagnostic.code}: {diagnostic.message}</p>)}
      </div> : null}
      {preview ? <div className="mt-4 rounded-xl border-2 border-border bg-card p-4 text-sm leading-6 text-body">
        <p>Hợp lệ: {preview.validLessons} · Đã có: {preview.existingLessons} · Lỗi: {preview.invalidLessons} · Progress: {preview.convertedProgress}</p>
        {preview.items.flatMap((item) => item.diagnostics).slice(0, 8).map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`} className="mt-1 text-muted">{diagnostic.code}: {diagnostic.message}</p>)}
      </div> : null}
      {error ? <p role="alert" className="mt-3 text-sm font-bold text-wrong">{error}</p> : null}
      {status?.status === "completed-with-warnings" ? <p className="mt-3 text-sm font-bold text-heading">Chuyển dữ liệu xong với cảnh báo. Dữ liệu cũ vẫn được giữ tạm thời.</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={check} className="rounded-xl border-2 border-primary bg-card px-4 py-2 text-sm font-extrabold text-primary disabled:opacity-50">{busy ? "Đang xử lý..." : "Kiểm tra dữ liệu"}</button>
        {preview ? <button type="button" disabled={busy} onClick={migrate} className="rounded-xl bg-accent px-4 py-2 text-sm font-extrabold text-accent-foreground disabled:opacity-50">Chuyển dữ liệu</button> : null}
        <button type="button" disabled={busy} onClick={() => setDeferred(true)} className="rounded-xl border-2 border-border bg-card px-4 py-2 text-sm font-extrabold text-body"> Để sau </button>
      </div>
    </section>
  );
}
