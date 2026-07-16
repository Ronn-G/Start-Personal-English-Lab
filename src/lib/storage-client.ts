import type {
  CreateLessonInput,
  LessonSummary,
  LessonProgressPayload,
  StoredLesson,
  StoredLessonProgress,
  UpdateLessonInput,
} from "@/server/storage/domain";
import type { LegacyMigrationRecord } from "@/lib/legacy-storage-reader";
import type { MigrationPreview, MigrationStatus } from "@/server/storage/legacy-migration";

const LEGACY_MIGRATION_ID = "localstorage-lessons-v1";

interface StorageApiErrorBody {
  error?: string;
  code?: string;
}

export class StorageApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "StorageApiError";
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body
      ? { "Content-Type": "application/json", ...init.headers }
      : init?.headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as StorageApiErrorBody;
    throw new StorageApiError(
      body.error ?? "Không thể truy cập bộ nhớ ứng dụng.",
      response.status,
      body.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function lessonUrl(id: string): string {
  return `/api/storage/lessons/${encodeURIComponent(id)}`;
}

export const storageClient = {
  async listLessons(): Promise<LessonSummary[]> {
    const data = await requestJson<{ lessons: LessonSummary[] }>("/api/storage/lessons");
    return data.lessons;
  },

  async getLesson(id: string): Promise<StoredLesson> {
    const data = await requestJson<{ lesson: StoredLesson }>(lessonUrl(id));
    return data.lesson;
  },

  async createLesson(input: CreateLessonInput): Promise<StoredLesson> {
    const data = await requestJson<{ lesson: StoredLesson }>("/api/storage/lessons", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data.lesson;
  },

  async updateLesson(id: string, input: UpdateLessonInput): Promise<StoredLesson> {
    const data = await requestJson<{ lesson: StoredLesson }>(lessonUrl(id), {
      method: "PUT",
      body: JSON.stringify(input),
    });
    return data.lesson;
  },

  async deleteLesson(id: string): Promise<void> {
    await requestJson<void>(lessonUrl(id), { method: "DELETE" });
  },

  async getLessonProgress(id: string): Promise<StoredLessonProgress | null> {
    const data = await requestJson<{ progress: StoredLessonProgress | null }>(
      `${lessonUrl(id)}/progress`,
    );
    return data.progress;
  },

  async saveLessonProgress(
    id: string,
    progress: LessonProgressPayload,
    progressVersion?: number,
  ): Promise<StoredLessonProgress> {
    const data = await requestJson<{ progress: StoredLessonProgress }>(
      `${lessonUrl(id)}/progress`,
      {
        method: "PUT",
        body: JSON.stringify({ progress, progressVersion }),
      },
    );
    return data.progress;
  },

  async getMigrationStatus(): Promise<MigrationStatus> {
    const data = await requestJson<{ status: MigrationStatus }>("/api/storage/migration");
    return data.status;
  },

  async previewLegacyMigration(records: LegacyMigrationRecord[]): Promise<MigrationPreview> {
    const data = await requestJson<{ preview: MigrationPreview }>("/api/storage/migration", {
      method: "POST",
      body: JSON.stringify({ action: "dry-run", migrationId: LEGACY_MIGRATION_ID, records }),
    });
    return data.preview;
  },

  async commitLegacyMigration(records: LegacyMigrationRecord[]): Promise<{ preview: MigrationPreview; status: MigrationStatus }> {
    return requestJson("/api/storage/migration", {
      method: "POST",
      body: JSON.stringify({ action: "commit", migrationId: LEGACY_MIGRATION_ID, records }),
    });
  },
};
