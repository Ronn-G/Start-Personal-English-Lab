"use client";

import { useRef, useState } from "react";

import type { ImportPreview } from "@/server/backup/backup";

const MAX_FILE_BYTES = 8_000_000;

interface BackupRestorePanelProps {
  lessonCount: number;
  onImported: () => Promise<void>;
}

export default function BackupRestorePanel({ lessonCount, onImported }: BackupRestorePanelProps) {
  const [backup, setBackup] = useState<unknown>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  async function exportFile() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/backup/export");
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Không thể tạo backup.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const name =
        /filename="([^"]+)"/.exec(disposition)?.[1] ?? "personal-english-lab-backup.json";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`Đã tạo backup lúc ${new Date().toLocaleString("vi-VN")}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Không thể tạo backup.");
    } finally {
      setBusy(false);
    }
  }

  async function choose(file?: File) {
    setError(undefined);
    setNotice(undefined);
    setPreview(undefined);
    setBackup(undefined);
    if (!file) return;
    if (file.type && !file.type.includes("json") && !file.name.toLowerCase().endsWith(".json")) {
      setError("Chỉ chấp nhận file JSON.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("File quá lớn (tối đa 8.000.000 byte).");
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      setBackup(parsed);
      setBusy(true);
      const response = await fetch("/api/backup/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dry-run", backup: parsed }),
      });
      const body = (await response.json()) as {
        error?: string;
        preview?: ImportPreview;
      };
      if (!response.ok || !body.preview)
        throw new Error(body.error ?? "Không thể kiểm tra backup.");
      setPreview(body.preview);
      if (!body.preview.valid)
        setError(
          body.preview.diagnostics
            .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
            .join("; "),
        );
    } catch (reason) {
      setError(
        reason instanceof SyntaxError
          ? "JSON bị hỏng hoặc không đọc được."
          : reason instanceof Error
            ? reason.message
            : "Không đọc được backup.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function run(mode: "merge" | "replace") {
    if (!backup || !preview?.valid) return;
    if (
      mode === "replace" &&
      !window.confirm(
        "Thao tác này sẽ thay thế toàn bộ bài học, nguồn/transcript và tiến độ hiện tại bằng dữ liệu trong backup. Nếu import lỗi, dữ liệu cũ sẽ được giữ nguyên. Bạn chắc chắn muốn tiếp tục?",
      )
    )
      return;
    if (
      preview.previouslyImported &&
      !window.confirm("Backup này đã từng được import. Bạn vẫn muốn import lại?")
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/backup/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: mode,
          backup,
          confirmReplace: mode === "replace",
          allowRepeat: preview.previouslyImported,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "Import thất bại; dữ liệu cũ vẫn được giữ nguyên.");
      setNotice(mode === "merge" ? "Đã gộp backup thành công." : "Đã thay thế dữ liệu thành công.");
      setBackup(undefined);
      setPreview(undefined);
      if (input.current) input.current.value = "";
      await onImported();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Import thất bại; dữ liệu cũ vẫn được giữ nguyên.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="rounded-2xl border-2 border-border bg-card p-5 shadow-sm sm:p-6"
      aria-labelledby="backup-title"
    >
      <h2 id="backup-title" className="text-xl font-extrabold text-heading">
        Sao lưu và khôi phục
      </h2>
      <p className="mt-2 text-sm text-body">
        Dữ liệu được lưu trên máy này. Hiện có {lessonCount} bài học. API key, đường dẫn máy và
        audio cache không nằm trong backup.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void exportFile()}
          className="rounded-xl bg-primary px-5 py-3 font-bold text-white disabled:opacity-50"
        >
          {busy ? "Đang xử lý..." : "Tải bản sao lưu"}
        </button>
        <label className="cursor-pointer rounded-xl border-2 border-border px-5 py-3 font-bold text-heading">
          Chọn file JSON
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
      </div>
      {preview?.valid ? (
        <div className="mt-5 rounded-xl border border-border bg-background p-4 text-sm text-body">
          <p>
            <b>Backup v{preview.backupVersion}:</b>{" "}
            {preview.lessonSourceCount > 0
              ? "có snapshot nguồn và transcript"
              : "không có dữ liệu nguồn/transcript"}
          </p>
          <p className="mt-2">
            Bài học: {preview.lessonCount} · Nguồn: {preview.lessonSourceCount} · Progress:{" "}
            {preview.progressCount}
          </p>
          <p className="mt-1">
            Speaking progress: {preview.speakingProgressCount} · Speaking sessions:{" "}
            {preview.speakingSessionCount}
          </p>
          <p className="mt-1">
            Listening sessions: {preview.listeningSessionCount} · Listening item progress:{" "}
            {preview.listeningItemProgressCount}
          </p>
          <p className="mt-1">
            Xung đột: {preview.conflicts} · Remap: {preview.remaps} · Record lỗi:{" "}
            {preview.invalidRecords}
          </p>
          <p className="mt-1">
            Nguồn tạo: app {preview.appVersion} · DB v{preview.databaseSchemaVersion} ·{" "}
            {preview.exportedAt}
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning} className="mt-1 font-bold">
              Cảnh báo: {warning}
            </p>
          ))}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              disabled={busy}
              onClick={() => void run("merge")}
              className="rounded-xl bg-accent px-4 py-2 font-bold text-accent-foreground disabled:opacity-50"
            >
              Gộp với dữ liệu hiện tại
            </button>
            <button
              disabled={busy}
              onClick={() => void run("replace")}
              className="rounded-xl border-2 border-wrong px-4 py-2 font-bold text-wrong disabled:opacity-50"
            >
              Thay thế toàn bộ
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 font-bold text-wrong">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 font-bold text-heading">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
