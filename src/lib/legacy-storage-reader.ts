export const LEGACY_LESSONS_KEY = "personal-english-lab-saved-lessons";
export const LEGACY_PROGRESS_PREFIX = "personal-english-lab-progress:";

export interface LegacyDiagnostic {
  code: string;
  recordIndex?: number;
  key?: string;
  message: string;
}

export interface LegacyMigrationRecord {
  legacyId?: string;
  lesson: unknown;
  videoId?: string;
  createdAt?: string;
  updatedAt?: string;
  progress?: unknown;
  progressKey?: string;
  progressUnreadable?: boolean;
}

export interface LegacyReadResult {
  records: LegacyMigrationRecord[];
  diagnostics: LegacyDiagnostic[];
  detectedCount: number;
}

type StorageReader = Pick<Storage, "getItem">;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readLegacyStorage(storage: StorageReader): LegacyReadResult {
  const diagnostics: LegacyDiagnostic[] = [];
  const rawLessons = storage.getItem(LEGACY_LESSONS_KEY);
  if (!rawLessons) return { records: [], diagnostics, detectedCount: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLessons);
  } catch {
    return {
      records: [],
      detectedCount: 0,
      diagnostics: [{ code: "MALFORMED_LESSON_STORE", key: LEGACY_LESSONS_KEY, message: "Kho bài cũ không phải JSON hợp lệ." }],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      records: [],
      detectedCount: 0,
      diagnostics: [{ code: "INVALID_LESSON_STORE", key: LEGACY_LESSONS_KEY, message: "Kho bài cũ không phải mảng." }],
    };
  }

  const records: LegacyMigrationRecord[] = [];
  parsed.forEach((item, recordIndex) => {
    if (!record(item) || !record(item.lesson)) {
      diagnostics.push({ code: "INVALID_LESSON_WRAPPER", recordIndex, message: "Bỏ qua wrapper bài học không hợp lệ." });
      return;
    }
    const legacyId = typeof item.id === "string" ? item.id : undefined;
    const title = typeof item.lesson.title === "string" ? item.lesson.title : "";
    const summary = typeof item.lesson.summary === "string" ? item.lesson.summary : "";
    const candidates = [
      legacyId ? `${LEGACY_PROGRESS_PREFIX}${legacyId}` : undefined,
      title || summary ? `${LEGACY_PROGRESS_PREFIX}${title}:${summary}` : undefined,
    ].filter((key): key is string => Boolean(key));
    let progress: unknown;
    let progressKey: string | undefined;
    let progressUnreadable = false;
    for (const key of candidates) {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      progressKey = key;
      try {
        progress = JSON.parse(raw);
      } catch {
        progressUnreadable = true;
        diagnostics.push({ code: "MALFORMED_PROGRESS", recordIndex, key, message: "Tiến độ cũ không phải JSON hợp lệ." });
      }
      break;
    }
    records.push({
      legacyId,
      lesson: item.lesson,
      videoId: typeof item.videoId === "string" ? item.videoId : undefined,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
      progress,
      progressKey,
      progressUnreadable,
    });
  });
  return { records, diagnostics, detectedCount: parsed.length };
}
