import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validateCanonicalLesson } from "../../lib/lesson-schema";
import {
  PRACTICE_HISTORY_LIMIT,
  normalizeLessonProgress,
  type LearningItemProgress,
  type LessonProgress,
} from "../../lib/lesson-progress";
import type { Lesson } from "../../types/lesson";
import { CURRENT_LESSON_SCHEMA_VERSION } from "../../types/lesson";
import { CURRENT_DATABASE_VERSION } from "../storage/migrations";
import { StorageError } from "../storage/errors";
import {
  MAX_STORED_LESSONS,
  MAX_STORED_LISTENING_SESSIONS,
  MAX_STORED_SPEAKING_SESSIONS,
} from "../storage/domain";
import {
  LADDER_STEPS,
  buildSpeakingSession,
  extractPracticeCandidates,
} from "../../lib/speaking-practice";
import {
  COMPREHENSION_LEVELS,
  FINAL_RELISTEN_RATINGS,
  LISTENING_RECOGNITION_STATES,
  LISTENING_STEPS,
  createListeningSessionSnapshot,
  extractListeningItems,
  isListeningSessionSnapshot,
  listeningItemId,
  type ListeningItem,
  type ListeningRecognitionState,
  type ListeningSessionSnapshot,
  type ListeningStep,
} from "../../lib/listening-practice";

export const BACKUP_FORMAT = "personal-english-lab";
export const CURRENT_BACKUP_VERSION = 2;
export const MAX_BACKUP_BYTES = 8_000_000;
export const MAX_IMPORT_REQUEST_BYTES = MAX_BACKUP_BYTES + 64_000;
export const MAX_LESSON_COUNT = MAX_STORED_LESSONS;
export const MAX_SPEAKING_PROGRESS_COUNT = 5_000;
export const MAX_SPEAKING_SESSION_COUNT = MAX_STORED_SPEAKING_SESSIONS;
export const MAX_LISTENING_SESSION_COUNT = MAX_STORED_LISTENING_SESSIONS;
export const MAX_LISTENING_PROGRESS_COUNT = 25_000;

export interface BackupCapacityStatus {
  state: "ready" | "too_large" | "unavailable";
  estimatedBytes: number | null;
  maximumBytes: number;
  exportAvailable: boolean;
  reason?: string;
}

const MAX_SOURCE_LABEL_CHARS = 500;
const MAX_SOURCE_URL_CHARS = 2_048;
const MAX_SOURCE_TRANSCRIPT_CHARS = 2_000_000;
const MAX_SOURCE_TRANSCRIPT_BYTES = 4_000_000;
const MAX_SPEAKING_TEXT_CHARS = 500;
const SHA256 = /^[0-9a-f]{64}$/i;
const SPEAKING_STATUSES = [
  "new",
  "practicing",
  "recalled_with_help",
  "recalled",
  "personalized",
] as const;
const SESSION_STATUSES = ["active", "completed", "cancelled"] as const;
const SELF_RATINGS = ["hard", "okay", "easy"] as const;
const SENTENCE_CHECK_VERDICTS = ["clear", "needs_small_fix", "needs_rewrite", "unclear"] as const;

export interface BackupDocument {
  backupFormat: typeof BACKUP_FORMAT;
  backupVersion: 1 | 2;
  exportedAt: string;
  appVersion: string;
  databaseSchemaVersion: number;
  lessonSchemaVersion: number;
  progressSchemaVersion: number;
  lessons: Lesson[];
  lessonSources?: LessonSourceBackup[];
  progress: LessonProgress[];
  settings: Record<string, never>;
  speakingProgress?: SpeakingProgressBackup[];
  speakingSessions?: SpeakingSessionBackup[];
  listeningSessions?: ListeningSessionBackup[];
  listeningItemProgress?: ListeningItemProgressBackup[];
  integrity: { algorithm: "SHA-256"; checksum: string };
}
export interface LessonSourceBackup {
  lessonId: string;
  title: string | null;
  url: string | null;
  channel: string | null;
  originalTranscript: string | null;
  processedTranscript: string | null;
  wasTruncated: boolean;
  updatedAt: string;
}
export interface SpeakingProgressBackup {
  lessonId: string;
  practiceItemId: string;
  sourceType: string;
  sourceItemId: string;
  status: "new" | "practicing" | "recalled_with_help" | "recalled" | "personalized";
  attemptCount: number;
  helpCount: number;
  showAnswerCount: number;
  recalledCount: number;
  personalizedCount: number;
  selfRating?: "hard" | "okay" | "easy";
  firstPracticedAt?: string;
  lastPracticedAt?: string;
  updatedAt: string;
}
export interface SpeakingSessionBackup {
  id: string;
  lessonId: string;
  itemIds: string[];
  drafts?: Record<string, string>;
  checks?: Record<string, unknown>;
  draftVersions?: Record<string, number>;
  checkVersions?: Record<string, number>;
  revealedItemIds?: string[];
  revision?: number;
  currentItemIndex: number;
  currentStep: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
export interface ListeningSessionBackup {
  id: string;
  lessonId: string;
  status: "active" | "completed" | "cancelled";
  currentStep: ListeningStep;
  firstListenComprehension?: (typeof COMPREHENSION_LEVELS)[number];
  firstListenNote: string;
  secondListenComprehension?: (typeof COMPREHENSION_LEVELS)[number];
  finalRelistenRating?: (typeof FINAL_RELISTEN_RATINGS)[number];
  finalNote: string;
  revealedItemIds: string[];
  selectedItemIds?: string[];
  selectedItems?: ListeningItem[];
  track?: string;
  trackHash?: string;
  lessonContentHash?: string;
  selectionVersion?: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}
export interface ListeningItemProgressBackup {
  id: string;
  lessonId: string;
  sourceType: string;
  sourceItemId: string;
  listenCount: number;
  loopCount: number;
  transcriptRevealed: boolean;
  recognitionStatus: ListeningRecognitionState;
  difficult: boolean;
  savedForRelisten?: boolean;
  lastListenedAt?: string;
  updatedAt: string;
}
export interface BackupDiagnostic {
  code: string;
  path: string;
  message: string;
}
export interface ImportPreview {
  valid: boolean;
  backupVersion?: number;
  exportedAt?: string;
  appVersion?: string;
  databaseSchemaVersion?: number;
  lessonCount: number;
  lessonSourceCount: number;
  progressCount: number;
  speakingProgressCount: number;
  speakingSessionCount: number;
  listeningSessionCount: number;
  listeningItemProgressCount: number;
  validRecords: number;
  invalidRecords: number;
  duplicates: number;
  conflicts: number;
  remaps: number;
  newLessons: number;
  updatedLessons: number;
  previouslyImported: boolean;
  warnings: string[];
  diagnostics: BackupDiagnostic[];
  fingerprint?: string;
}
type BareBackup = Omit<BackupDocument, "integrity">;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value));
const nonNegativeInteger = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
export function isBackupByteLengthAllowed(bytes: number): boolean {
  return Number.isInteger(bytes) && bytes >= 0 && bytes <= MAX_BACKUP_BYTES;
}
export function isBackupCollectionCountAllowed(count: number, limit: number): boolean {
  return Number.isInteger(count) && count >= 0 && count <= limit;
}
function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
const SOURCE_KEYS = [
  "lessonId",
  "title",
  "url",
  "channel",
  "originalTranscript",
  "processedTranscript",
  "wasTruncated",
  "updatedAt",
] as const;
const SPEAKING_PROGRESS_KEYS = [
  "lessonId",
  "practiceItemId",
  "sourceType",
  "sourceItemId",
  "status",
  "attemptCount",
  "helpCount",
  "showAnswerCount",
  "recalledCount",
  "personalizedCount",
  "selfRating",
  "firstPracticedAt",
  "lastPracticedAt",
  "updatedAt",
] as const;
const SPEAKING_SESSION_KEYS = [
  "id",
  "lessonId",
  "itemIds",
  "drafts",
  "checks",
  "draftVersions",
  "checkVersions",
  "revealedItemIds",
  "revision",
  "currentItemIndex",
  "currentStep",
  "status",
  "createdAt",
  "updatedAt",
  "completedAt",
] as const;
const SENTENCE_CHECK_KEYS = [
  "understandable",
  "verdict",
  "correctedSentence",
  "naturalAlternative",
  "explanationVi",
  "inputHash",
  "inputText",
  "checkedAt",
] as const;
const BACKUP_KEYS = [
  "backupFormat",
  "backupVersion",
  "exportedAt",
  "appVersion",
  "databaseSchemaVersion",
  "lessonSchemaVersion",
  "progressSchemaVersion",
  "lessons",
  "lessonSources",
  "progress",
  "settings",
  "speakingProgress",
  "speakingSessions",
  "listeningSessions",
  "listeningItemProgress",
  "integrity",
] as const;

function validNullableText(
  value: unknown,
  maxChars: number,
  maxBytes = maxChars * 4,
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= maxChars && utf8Bytes(value) <= maxBytes)
  );
}

function validWebUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > MAX_SOURCE_URL_CHARS || utf8Bytes(value) > 8_192)
    return false;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !/^[A-Za-z]:[\\/]|^\\\\/.test(value);
  } catch {
    return false;
  }
}

function validSentenceCheck(value: unknown): boolean {
  if (!record(value) || !hasExactKeys(value, SENTENCE_CHECK_KEYS)) return false;
  return (
    typeof value.understandable === "boolean" &&
    SENTENCE_CHECK_VERDICTS.includes(value.verdict as (typeof SENTENCE_CHECK_VERDICTS)[number]) &&
    typeof value.correctedSentence === "string" &&
    value.correctedSentence.length > 0 &&
    value.correctedSentence.length <= MAX_SPEAKING_TEXT_CHARS &&
    (value.naturalAlternative === null ||
      (typeof value.naturalAlternative === "string" &&
        value.naturalAlternative.length > 0 &&
        value.naturalAlternative.length <= MAX_SPEAKING_TEXT_CHARS)) &&
    typeof value.explanationVi === "string" &&
    value.explanationVi.length > 0 &&
    value.explanationVi.length <= MAX_SPEAKING_TEXT_CHARS &&
    typeof value.inputText === "string" &&
    value.inputText.length > 0 &&
    value.inputText.length <= MAX_SPEAKING_TEXT_CHARS &&
    typeof value.inputHash === "string" &&
    SHA256.test(value.inputHash) &&
    iso(value.checkedAt)
  );
}
export function checksum(payload: BareBackup): string {
  return createHash("sha256").update(stable(payload), "utf8").digest("hex");
}
export function contentFingerprint(lesson: Lesson): string {
  const copy = structuredClone(lesson) as unknown as Record<string, unknown>;
  delete copy.id;
  delete copy.createdAt;
  delete copy.updatedAt;
  return createHash("sha256").update(stable(copy)).digest("hex");
}
function bare(document: BackupDocument): BareBackup {
  const result: BareBackup = {
    backupFormat: document.backupFormat,
    backupVersion: document.backupVersion,
    exportedAt: document.exportedAt,
    appVersion: document.appVersion,
    databaseSchemaVersion: document.databaseSchemaVersion,
    lessonSchemaVersion: document.lessonSchemaVersion,
    progressSchemaVersion: document.progressSchemaVersion,
    lessons: document.lessons,
    progress: document.progress,
    settings: document.settings,
  };
  if (document.lessonSources !== undefined) result.lessonSources = document.lessonSources;
  if (document.speakingProgress !== undefined) result.speakingProgress = document.speakingProgress;
  if (document.speakingSessions !== undefined) result.speakingSessions = document.speakingSessions;
  if (document.listeningSessions !== undefined)
    result.listeningSessions = document.listeningSessions;
  if (document.listeningItemProgress !== undefined)
    result.listeningItemProgress = document.listeningItemProgress;
  return result;
}

export function validateBackup(
  value: unknown,
  options: { enforceArtifactByteLimit?: boolean } = {},
): {
  document?: BackupDocument;
  diagnostics: BackupDiagnostic[];
} {
  const d: BackupDiagnostic[] = [];
  if (!record(value))
    return {
      diagnostics: [
        {
          code: "INVALID_BACKUP",
          path: "$",
          message: "Backup phải là một đối tượng JSON.",
        },
      ],
    };
  let serializedBytes = Number.POSITIVE_INFINITY;
  try {
    serializedBytes = serializedUtf8Bytes(value);
  } catch {
    d.push({
      code: "INVALID_BACKUP",
      path: "$",
      message: "Backup không thể chuyển thành JSON hợp lệ.",
    });
  }
  if ((options.enforceArtifactByteLimit ?? true) && !isBackupByteLengthAllowed(serializedBytes))
    d.push({
      code: "BACKUP_TOO_LARGE",
      path: "$",
      message: `Backup vượt quá giới hạn ${MAX_BACKUP_BYTES} byte.`,
    });
  if (value.backupFormat !== BACKUP_FORMAT)
    d.push({
      code: "INVALID_FORMAT",
      path: "$.backupFormat",
      message: "Sai định dạng backup.",
    });
  if (value.backupVersion !== 1 && value.backupVersion !== CURRENT_BACKUP_VERSION)
    d.push({
      code: "UNSUPPORTED_BACKUP_VERSION",
      path: "$.backupVersion",
      message: `Chỉ hỗ trợ backup version 1 hoặc ${CURRENT_BACKUP_VERSION}.`,
    });
  if (!hasOnlyKeys(value, BACKUP_KEYS))
    d.push({
      code: "INVALID_BACKUP_KEYS",
      path: "$",
      message: "Backup có field cấp cao nhất không được hỗ trợ.",
    });
  for (const key of [
    "exportedAt",
    "appVersion",
    "databaseSchemaVersion",
    "lessonSchemaVersion",
    "progressSchemaVersion",
    "lessons",
    "progress",
    "settings",
    "integrity",
  ])
    if (!(key in value))
      d.push({
        code: "MISSING_FIELD",
        path: `$.${key}`,
        message: `Thiếu trường ${key}.`,
      });
  if (!iso(value.exportedAt))
    d.push({
      code: "INVALID_EXPORTED_AT",
      path: "$.exportedAt",
      message: "exportedAt phải là timestamp ISO hợp lệ.",
    });
  if (
    typeof value.appVersion !== "string" ||
    value.appVersion.length === 0 ||
    value.appVersion.length > 100
  )
    d.push({
      code: "INVALID_APP_VERSION",
      path: "$.appVersion",
      message: "appVersion không hợp lệ.",
    });
  if (!nonNegativeInteger(value.databaseSchemaVersion))
    d.push({
      code: "INVALID_DATABASE_VERSION",
      path: "$.databaseSchemaVersion",
      message: "databaseSchemaVersion không hợp lệ.",
    });
  if (!record(value.settings) || Object.keys(value.settings).length !== 0)
    d.push({
      code: "INVALID_SETTINGS",
      path: "$.settings",
      message: "Backup chỉ hỗ trợ settings allow-list rỗng.",
    });
  if (
    !Array.isArray(value.lessons) ||
    !Array.isArray(value.progress) ||
    !isBackupCollectionCountAllowed(value.lessons?.length, MAX_LESSON_COUNT) ||
    !isBackupCollectionCountAllowed(value.progress?.length, MAX_LESSON_COUNT)
  )
    d.push({
      code: "INVALID_COLLECTION",
      path: "$",
      message: `Danh sách bài học/tiến độ không hợp lệ hoặc có quá ${MAX_LESSON_COUNT} bản ghi.`,
    });
  if (value.backupVersion === 2 && !Array.isArray(value.lessonSources))
    d.push({
      code: "MISSING_LESSON_SOURCES",
      path: "$.lessonSources",
      message: "Backup v2 phải có danh sách nguồn bài học.",
    });
  if (
    value.lessonSources !== undefined &&
    (!Array.isArray(value.lessonSources) ||
      !isBackupCollectionCountAllowed(value.lessonSources.length, MAX_LESSON_COUNT))
  )
    d.push({
      code: "INVALID_LESSON_SOURCES",
      path: "$.lessonSources",
      message: `Danh sách nguồn bài học không hợp lệ hoặc có quá ${MAX_LESSON_COUNT} bản ghi.`,
    });
  if (value.lessonSchemaVersion !== 1 || value.progressSchemaVersion !== 1)
    d.push({
      code: "UNSUPPORTED_DOCUMENT_VERSION",
      path: "$",
      message: "Schema bài học/tiến độ không được hỗ trợ.",
    });
  const ids = new Set<string>();
  const itemIds = new Map<string, Set<string>>();
  const speakingItems = new Map<
    string,
    Map<string, ReturnType<typeof extractPracticeCandidates>[number]>
  >();
  const speakingTasks = new Map<
    string,
    Map<string, ReturnType<typeof buildSpeakingSession>[number]>
  >();
  const listeningItems = new Map<
    string,
    Map<string, ReturnType<typeof extractListeningItems>[number]>
  >();
  if (Array.isArray(value.lessons))
    value.lessons.forEach((lesson, i) => {
      const result = validateCanonicalLesson(lesson);
      if (!result.success)
        d.push({
          code: "INVALID_LESSON",
          path: `$.lessons[${i}]`,
          message: result.diagnostics.map((x) => x.message).join("; "),
        });
      else if (ids.has((lesson as Lesson).id))
        d.push({
          code: "DUPLICATE_LESSON_ID",
          path: `$.lessons[${i}].id`,
          message: "ID bài học bị trùng trong backup.",
        });
      else {
        const data = lesson as Lesson;
        ids.add(data.id);
        itemIds.set(
          data.id,
          new Set(
            [
              ...data.vocabulary,
              ...data.idiomsAndSlang,
              ...data.exampleSentences,
              ...data.quiz,
              ...data.deepPractice.shadowingPractice.lines,
              ...data.deepPractice.sentenceMining,
              ...data.deepPractice.ankiCards,
            ].map((x) => x.id),
          ),
        );
        listeningItems.set(
          data.id,
          new Map(extractListeningItems(data).map((item) => [item.id, item])),
        );
        speakingItems.set(
          data.id,
          new Map(extractPracticeCandidates(data).map((item) => [item.id, item])),
        );
        speakingTasks.set(
          data.id,
          new Map(buildSpeakingSession(data).map((item) => [item.id, item])),
        );
      }
    });
  if (Array.isArray(value.lessonSources)) {
    const sourceLessonIds = new Set<string>();
    value.lessonSources.forEach((source, index) => {
      const path = `$.lessonSources[${index}]`;
      if (!record(source)) {
        d.push({
          code: "INVALID_LESSON_SOURCE",
          path,
          message: "Nguồn bài học phải là object.",
        });
        return;
      }
      if (!hasExactKeys(source, SOURCE_KEYS))
        d.push({
          code: "INVALID_LESSON_SOURCE_KEYS",
          path,
          message: "Nguồn bài học có field thiếu hoặc không được hỗ trợ.",
        });
      const lessonId = typeof source.lessonId === "string" ? source.lessonId : "";
      if (!UUID.test(lessonId) || !ids.has(lessonId))
        d.push({
          code: "ORPHAN_LESSON_SOURCE",
          path: `${path}.lessonId`,
          message: "Nguồn không tham chiếu tới lesson hợp lệ trong backup.",
        });
      else if (sourceLessonIds.has(lessonId))
        d.push({
          code: "DUPLICATE_LESSON_SOURCE",
          path: `${path}.lessonId`,
          message: "Lesson có nhiều hơn một bản ghi nguồn.",
        });
      else sourceLessonIds.add(lessonId);
      for (const field of ["title", "channel"] as const)
        if (!validNullableText(source[field], MAX_SOURCE_LABEL_CHARS, 2_000))
          d.push({
            code: "INVALID_LESSON_SOURCE_FIELD",
            path: `${path}.${field}`,
            message: `${field} phải là chuỗi/null trong giới hạn cho phép.`,
          });
      if (!validWebUrl(source.url))
        d.push({
          code: "INVALID_LESSON_SOURCE_URL",
          path: `${path}.url`,
          message: "URL nguồn phải là HTTP(S), không phải đường dẫn máy cục bộ.",
        });
      for (const field of ["originalTranscript", "processedTranscript"] as const) {
        const transcript = source[field];
        if (
          !validNullableText(transcript, MAX_SOURCE_TRANSCRIPT_CHARS, MAX_SOURCE_TRANSCRIPT_BYTES)
        )
          d.push({
            code: "INVALID_LESSON_TRANSCRIPT",
            path: `${path}.${field}`,
            message: `${field} phải là chuỗi/null trong giới hạn cho phép.`,
          });
        else if (typeof transcript === "string" && /^data:audio\//i.test(transcript.trim()))
          d.push({
            code: "BINARY_AUDIO_NOT_ALLOWED",
            path: `${path}.${field}`,
            message: "Backup không được chứa audio/base64.",
          });
      }
      if (typeof source.wasTruncated !== "boolean")
        d.push({
          code: "INVALID_LESSON_SOURCE_FIELD",
          path: `${path}.wasTruncated`,
          message: "wasTruncated phải là boolean.",
        });
      if (!iso(source.updatedAt))
        d.push({
          code: "INVALID_LESSON_SOURCE_TIMESTAMP",
          path: `${path}.updatedAt`,
          message: "updatedAt của nguồn không hợp lệ.",
        });
    });
    if (value.backupVersion === 2)
      for (const lessonId of ids)
        if (!sourceLessonIds.has(lessonId))
          d.push({
            code: "MISSING_LESSON_SOURCE",
            path: "$.lessonSources",
            message: `Thiếu bản ghi nguồn cho lesson ${lessonId}.`,
          });
  }
  const progressLessonIds = new Set<string>();
  if (Array.isArray(value.progress))
    value.progress.forEach((progress, i) => {
      const lessonId =
        record(progress) && typeof progress.lessonId === "string" ? progress.lessonId : undefined;
      const result = normalizeLessonProgress(progress, lessonId);
      if (!result.success)
        d.push({
          code: "INVALID_PROGRESS",
          path: `$.progress[${i}]`,
          message: result.diagnostics.map((x) => x.message).join("; "),
        });
      else if (!ids.has(result.data!.lessonId))
        d.push({
          code: "ORPHAN_PROGRESS",
          path: `$.progress[${i}].lessonId`,
          message: "Tiến độ không có bài học tương ứng.",
        });
      else if (progressLessonIds.has(result.data!.lessonId))
        d.push({
          code: "DUPLICATE_PROGRESS",
          path: `$.progress[${i}].lessonId`,
          message: "Lesson có nhiều hơn một progress record.",
        });
      else {
        const data = result.data!,
          allowed = itemIds.get(data.lessonId)!;
        progressLessonIds.add(data.lessonId);
        const bad = [
          ...Object.keys(data.quizItems),
          ...Object.keys(data.learningItems),
          ...data.practiceHistory.map((item) => item.itemId),
        ].find((id) => !allowed.has(id));
        if (bad)
          d.push({
            code: "ITEM_ID_MISMATCH",
            path: `$.progress[${i}]`,
            message: `Tiến độ tham chiếu tới ID nội dung không thuộc bài học: ${bad}.`,
          });
      }
    });
  if (
    value.speakingProgress !== undefined &&
    (!Array.isArray(value.speakingProgress) ||
      !isBackupCollectionCountAllowed(value.speakingProgress.length, MAX_SPEAKING_PROGRESS_COUNT))
  )
    d.push({
      code: "INVALID_SPEAKING_PROGRESS_COLLECTION",
      path: "$.speakingProgress",
      message: `Danh sách tiến độ nói không hợp lệ hoặc có quá ${MAX_SPEAKING_PROGRESS_COUNT} bản ghi.`,
    });
  if (Array.isArray(value.speakingProgress)) {
    const identities = new Set<string>();
    value.speakingProgress.forEach((progress, index) => {
      const path = `$.speakingProgress[${index}]`;
      if (!record(progress)) {
        d.push({
          code: "INVALID_SPEAKING_PROGRESS",
          path,
          message: "Tiến độ nói phải là object.",
        });
        return;
      }
      const required = SPEAKING_PROGRESS_KEYS.filter(
        (key) => !["selfRating", "firstPracticedAt", "lastPracticedAt"].includes(key),
      );
      if (
        !hasOnlyKeys(progress, SPEAKING_PROGRESS_KEYS) ||
        required.some((key) => !(key in progress))
      )
        d.push({
          code: "INVALID_SPEAKING_PROGRESS_KEYS",
          path,
          message: "Tiến độ nói có field thiếu hoặc không được hỗ trợ.",
        });
      const lessonId = typeof progress.lessonId === "string" ? progress.lessonId : "";
      if (!UUID.test(lessonId) || !ids.has(lessonId))
        d.push({
          code: "ORPHAN_SPEAKING_PROGRESS",
          path: `${path}.lessonId`,
          message: "Tiến độ nói không thuộc lesson trong backup.",
        });
      const practiceItemId =
        typeof progress.practiceItemId === "string" ? progress.practiceItemId : "";
      const target = speakingItems.get(lessonId)?.get(practiceItemId);
      if (!target)
        d.push({
          code: "INVALID_SPEAKING_SOURCE",
          path: `${path}.practiceItemId`,
          message: "Practice item không thuộc lesson.",
        });
      else if (
        progress.sourceType !== target.sourceType ||
        progress.sourceItemId !== target.sourceItemId
      )
        d.push({
          code: "INVALID_SPEAKING_SOURCE",
          path: `${path}.sourceItemId`,
          message: "Source identity không khớp practice item của lesson.",
        });
      const identity = `${lessonId}|${practiceItemId}`;
      if (identities.has(identity))
        d.push({
          code: "DUPLICATE_SPEAKING_PROGRESS",
          path: `${path}.practiceItemId`,
          message: "Practice item bị trùng trong tiến độ nói.",
        });
      else identities.add(identity);
      if (
        typeof progress.sourceType !== "string" ||
        !["shadowing", "example", "sentence_mining", "vocabulary"].includes(progress.sourceType)
      )
        d.push({
          code: "INVALID_SPEAKING_SOURCE_TYPE",
          path: `${path}.sourceType`,
          message: "sourceType không hợp lệ.",
        });
      if (!SPEAKING_STATUSES.includes(progress.status as (typeof SPEAKING_STATUSES)[number]))
        d.push({
          code: "INVALID_SPEAKING_STATUS",
          path: `${path}.status`,
          message: "Speaking status không hợp lệ.",
        });
      for (const field of [
        "attemptCount",
        "helpCount",
        "showAnswerCount",
        "recalledCount",
        "personalizedCount",
      ] as const)
        if (!nonNegativeInteger(progress[field]))
          d.push({
            code: "INVALID_SPEAKING_COUNTER",
            path: `${path}.${field}`,
            message: `${field} phải là số nguyên không âm.`,
          });
      if (
        progress.selfRating !== undefined &&
        !SELF_RATINGS.includes(progress.selfRating as (typeof SELF_RATINGS)[number])
      )
        d.push({
          code: "INVALID_SPEAKING_RATING",
          path: `${path}.selfRating`,
          message: "Self-rating không hợp lệ.",
        });
      for (const field of ["firstPracticedAt", "lastPracticedAt"] as const)
        if (progress[field] !== undefined && !iso(progress[field]))
          d.push({
            code: "INVALID_SPEAKING_TIMESTAMP",
            path: `${path}.${field}`,
            message: `${field} không phải timestamp ISO hợp lệ.`,
          });
      if (!iso(progress.updatedAt))
        d.push({
          code: "INVALID_SPEAKING_TIMESTAMP",
          path: `${path}.updatedAt`,
          message: "updatedAt không phải timestamp ISO hợp lệ.",
        });
    });
  }
  if (
    value.speakingSessions !== undefined &&
    (!Array.isArray(value.speakingSessions) ||
      !isBackupCollectionCountAllowed(value.speakingSessions.length, MAX_SPEAKING_SESSION_COUNT))
  )
    d.push({
      code: "INVALID_SPEAKING_SESSION_COLLECTION",
      path: "$.speakingSessions",
      message: `Danh sách phiên nói không hợp lệ hoặc có quá ${MAX_SPEAKING_SESSION_COUNT} bản ghi.`,
    });
  if (Array.isArray(value.speakingSessions)) {
    const sessionIds = new Set<string>();
    const activeLessons = new Set<string>();
    value.speakingSessions.forEach((session, index) => {
      const path = `$.speakingSessions[${index}]`;
      if (!record(session)) {
        d.push({
          code: "INVALID_SPEAKING_SESSION",
          path,
          message: "Phiên nói phải là object.",
        });
        return;
      }
      const required = SPEAKING_SESSION_KEYS.filter(
        (key) =>
          ![
            "drafts",
            "checks",
            "draftVersions",
            "checkVersions",
            "revealedItemIds",
            "revision",
            "completedAt",
          ].includes(key),
      );
      if (!hasOnlyKeys(session, SPEAKING_SESSION_KEYS) || required.some((key) => !(key in session)))
        d.push({
          code: "INVALID_SPEAKING_SESSION_KEYS",
          path,
          message: "Phiên nói có field thiếu hoặc không được hỗ trợ.",
        });
      const sessionId = typeof session.id === "string" ? session.id : "";
      if (!UUID.test(sessionId))
        d.push({
          code: "INVALID_SPEAKING_SESSION_ID",
          path: `${path}.id`,
          message: "Session ID không hợp lệ.",
        });
      else if (sessionIds.has(sessionId))
        d.push({
          code: "DUPLICATE_SPEAKING_SESSION_ID",
          path: `${path}.id`,
          message: "Session ID bị trùng trong backup.",
        });
      else sessionIds.add(sessionId);
      const lessonId = typeof session.lessonId === "string" ? session.lessonId : "";
      if (!UUID.test(lessonId) || !ids.has(lessonId))
        d.push({
          code: "ORPHAN_SPEAKING_SESSION",
          path: `${path}.lessonId`,
          message: "Phiên nói không thuộc lesson trong backup.",
        });
      const status = session.status;
      if (!SESSION_STATUSES.includes(status as (typeof SESSION_STATUSES)[number]))
        d.push({
          code: "INVALID_SPEAKING_SESSION_STATUS",
          path: `${path}.status`,
          message: "Session status không hợp lệ.",
        });
      if (status === "active") {
        if (activeLessons.has(lessonId))
          d.push({
            code: "DUPLICATE_ACTIVE_SPEAKING_SESSION",
            path: `${path}.status`,
            message: "Một lesson chỉ được có một phiên nói active.",
          });
        else activeLessons.add(lessonId);
      }
      const itemIds = Array.isArray(session.itemIds) ? session.itemIds : [];
      if (!Array.isArray(session.itemIds) || itemIds.length === 0)
        d.push({
          code: "INVALID_SPEAKING_SESSION_ITEMS",
          path: `${path}.itemIds`,
          message: "Phiên nói phải có ít nhất một task.",
        });
      const itemSet = new Set<string>();
      for (let itemIndex = 0; itemIndex < itemIds.length; itemIndex++) {
        const itemId = itemIds[itemIndex];
        if (
          typeof itemId !== "string" ||
          itemSet.has(itemId) ||
          !speakingTasks.get(lessonId)?.has(itemId)
        )
          d.push({
            code: "INVALID_SPEAKING_SESSION_ITEM",
            path: `${path}.itemIds[${itemIndex}]`,
            message: "Task bị trùng hoặc không thuộc lesson.",
          });
        if (typeof itemId === "string") itemSet.add(itemId);
      }
      const revealedItemIds = Array.isArray(session.revealedItemIds) ? session.revealedItemIds : [];
      if (session.revision !== undefined && !nonNegativeInteger(session.revision))
        d.push({
          code: "INVALID_SPEAKING_REVISION",
          path: `${path}.revision`,
          message: "Speaking revision phải là số nguyên không âm.",
        });
      if (
        session.revealedItemIds !== undefined &&
        (!Array.isArray(session.revealedItemIds) ||
          revealedItemIds.some(
            (itemId, revealedIndex) =>
              typeof itemId !== "string" ||
              !itemSet.has(itemId) ||
              revealedItemIds.indexOf(itemId) !== revealedIndex,
          ))
      )
        d.push({
          code: "INVALID_SPEAKING_REVEALS",
          path: `${path}.revealedItemIds`,
          message: "Danh sách Show Answer của session không hợp lệ.",
        });
      if (session.draftVersions !== undefined) {
        if (!record(session.draftVersions))
          d.push({
            code: "INVALID_SPEAKING_DRAFT_VERSIONS",
            path: `${path}.draftVersions`,
            message: "Draft versions phải là object theo item ID.",
          });
        else
          for (const [itemId, version] of Object.entries(session.draftVersions))
            if (!itemSet.has(itemId) || !nonNegativeInteger(version))
              d.push({
                code: "INVALID_SPEAKING_DRAFT_VERSION",
                path: `${path}.draftVersions.${itemId}`,
                message: "Draft version không hợp lệ cho session item.",
              });
      }
      if (session.checkVersions !== undefined) {
        if (!record(session.checkVersions))
          d.push({
            code: "INVALID_SPEAKING_CHECK_VERSIONS",
            path: `${path}.checkVersions`,
            message: "Check versions phải là object theo item ID.",
          });
        else
          for (const [itemId, version] of Object.entries(session.checkVersions))
            if (!itemSet.has(itemId) || !nonNegativeInteger(version))
              d.push({
                code: "INVALID_SPEAKING_CHECK_VERSION",
                path: `${path}.checkVersions.${itemId}`,
                message: "Check version không hợp lệ cho session item.",
              });
      }
      const currentIndex = session.currentItemIndex;
      if (
        !nonNegativeInteger(currentIndex) ||
        itemIds.length === 0 ||
        Number(currentIndex) >= itemIds.length
      )
        d.push({
          code: "INVALID_SPEAKING_CURRENT_INDEX",
          path: `${path}.currentItemIndex`,
          message: "currentItemIndex phải nằm trong task list.",
        });
      const currentTask =
        nonNegativeInteger(currentIndex) && Number(currentIndex) < itemIds.length
          ? speakingTasks.get(lessonId)?.get(String(itemIds[Number(currentIndex)]))
          : undefined;
      if (
        typeof session.currentStep !== "string" ||
        !LADDER_STEPS.includes(session.currentStep as (typeof LADDER_STEPS)[number]) ||
        (currentTask &&
          !(
            Number(currentIndex) === itemIds.length - 1 ? LADDER_STEPS : currentTask.steps
          ).includes(session.currentStep as (typeof LADDER_STEPS)[number]))
      )
        d.push({
          code: "INVALID_SPEAKING_CURRENT_STEP",
          path: `${path}.currentStep`,
          message: "currentStep không hợp lệ cho task hiện tại.",
        });
      for (const [field, shape] of [
        ["drafts", session.drafts],
        ["checks", session.checks],
      ] as const) {
        if (shape !== undefined && !record(shape))
          d.push({
            code: "INVALID_SPEAKING_SESSION_STATE",
            path: `${path}.${field}`,
            message: `${field} phải là object theo item ID.`,
          });
        else if (record(shape))
          for (const [itemId, itemValue] of Object.entries(shape)) {
            if (!itemSet.has(itemId))
              d.push({
                code: "ORPHAN_SPEAKING_SESSION_STATE",
                path: `${path}.${field}.${itemId}`,
                message: `${field} tham chiếu task không thuộc session.`,
              });
            if (
              (field === "drafts" &&
                (typeof itemValue !== "string" ||
                  itemValue.length > MAX_SPEAKING_TEXT_CHARS ||
                  utf8Bytes(itemValue) > 2_000)) ||
              (field === "checks" && !validSentenceCheck(itemValue))
            )
              d.push({
                code: "INVALID_SPEAKING_SESSION_STATE",
                path: `${path}.${field}.${itemId}`,
                message: `${field} có nội dung không hợp lệ.`,
              });
          }
      }
      if (!iso(session.createdAt))
        d.push({
          code: "INVALID_SPEAKING_TIMESTAMP",
          path: `${path}.createdAt`,
          message: "createdAt không hợp lệ.",
        });
      if (!iso(session.updatedAt))
        d.push({
          code: "INVALID_SPEAKING_TIMESTAMP",
          path: `${path}.updatedAt`,
          message: "updatedAt không hợp lệ.",
        });
      const completedAtIsIso = iso(session.completedAt);
      if (
        status === "completed" &&
        (!completedAtIsIso ||
          !nonNegativeInteger(currentIndex) ||
          Number(currentIndex) !== itemIds.length - 1 ||
          (currentTask && session.currentStep !== "free_speak"))
      )
        d.push({
          code: "INCONSISTENT_COMPLETED_SPEAKING_SESSION",
          path: completedAtIsIso ? `${path}.currentItemIndex` : `${path}.completedAt`,
          message: "Phiên completed không nhất quán với task/step cuối.",
        });
      if (status !== "completed" && session.completedAt !== undefined)
        d.push({
          code: "INCONSISTENT_SPEAKING_SESSION_STATUS",
          path: `${path}.completedAt`,
          message: "Phiên active/cancelled không được có completedAt.",
        });
    });
  }
  if (
    value.listeningSessions !== undefined &&
    (!Array.isArray(value.listeningSessions) ||
      !isBackupCollectionCountAllowed(value.listeningSessions.length, MAX_LISTENING_SESSION_COUNT))
  ) {
    d.push({
      code: "INVALID_LISTENING_SESSIONS",
      path: "$.listeningSessions",
      message: "Danh sách phiên luyện nghe không hợp lệ.",
    });
  }
  const activeListeningLessons = new Set<string>();
  const listeningSessionIds = new Set<string>();
  if (Array.isArray(value.listeningSessions)) {
    value.listeningSessions.forEach((session, index) => {
      const path = `$.listeningSessions[${index}]`;
      let snapshotValid = true;
      let revealedIdsValid = true;
      if (record(session)) {
        const snapshotValues = [
          session.selectedItemIds,
          session.selectedItems,
          session.track,
          session.trackHash,
          session.lessonContentHash,
          session.selectionVersion,
        ];
        const hasSnapshot = snapshotValues.some((entry) => entry !== undefined);
        const hasCompleteSnapshot = snapshotValues.every((entry) => entry !== undefined);
        const snapshot = hasCompleteSnapshot
          ? {
              selectedItemIds: session.selectedItemIds,
              selectedItems: session.selectedItems,
              track: session.track,
              trackHash: session.trackHash,
              lessonContentHash: session.lessonContentHash,
              selectionVersion: session.selectionVersion,
            }
          : undefined;
        snapshotValid =
          !hasSnapshot ||
          (hasCompleteSnapshot &&
            isListeningSessionSnapshot(snapshot, String(session.lessonId ?? "")));
        if (!snapshotValid) {
          d.push({
            code: "INVALID_LISTENING_SNAPSHOT",
            path: `${path}.selectedItems`,
            message: "Listening snapshot thiếu field, vượt giới hạn hoặc không nhất quán.",
          });
        }
        if (Array.isArray(session.revealedItemIds)) {
          const allowedIds =
            snapshot && isListeningSessionSnapshot(snapshot, String(session.lessonId ?? ""))
              ? new Set(snapshot.selectedItemIds)
              : new Set(listeningItems.get(String(session.lessonId))?.keys() ?? ([] as string[]));
          revealedIdsValid = session.revealedItemIds.every(
            (itemId) => typeof itemId === "string" && allowedIds.has(itemId),
          );
        }
      }
      if (
        !record(session) ||
        typeof session.id !== "string" ||
        !UUID.test(session.id) ||
        listeningSessionIds.has(session.id) ||
        typeof session.lessonId !== "string" ||
        !ids.has(session.lessonId) ||
        !["active", "completed", "cancelled"].includes(String(session.status)) ||
        !LISTENING_STEPS.includes(session.currentStep as ListeningStep) ||
        !Array.isArray(session.revealedItemIds) ||
        !revealedIdsValid ||
        !snapshotValid ||
        typeof session.firstListenNote !== "string" ||
        session.firstListenNote.length > 1000 ||
        typeof session.finalNote !== "string" ||
        session.finalNote.length > 1000 ||
        !iso(session.startedAt) ||
        !iso(session.updatedAt) ||
        (session.completedAt !== undefined && !iso(session.completedAt)) ||
        (session.firstListenComprehension !== undefined &&
          !COMPREHENSION_LEVELS.includes(
            session.firstListenComprehension as (typeof COMPREHENSION_LEVELS)[number],
          )) ||
        (session.secondListenComprehension !== undefined &&
          !COMPREHENSION_LEVELS.includes(
            session.secondListenComprehension as (typeof COMPREHENSION_LEVELS)[number],
          )) ||
        (session.finalRelistenRating !== undefined &&
          !FINAL_RELISTEN_RATINGS.includes(
            session.finalRelistenRating as (typeof FINAL_RELISTEN_RATINGS)[number],
          )) ||
        (session.status === "active" && session.currentStep === "complete") ||
        (session.status === "completed" &&
          (session.currentStep !== "complete" || !iso(session.completedAt)))
      ) {
        d.push({
          code: "INVALID_LISTENING_SESSION",
          path,
          message: "Phiên luyện nghe không hợp lệ hoặc tham chiếu sai bài học.",
        });
      } else if (session.status === "active") {
        listeningSessionIds.add(session.id);
        if (activeListeningLessons.has(session.lessonId)) {
          d.push({
            code: "DUPLICATE_ACTIVE_LISTENING_SESSION",
            path,
            message: "Một bài học có nhiều hơn một phiên luyện nghe đang hoạt động.",
          });
        }
        activeListeningLessons.add(session.lessonId);
      } else {
        listeningSessionIds.add(session.id);
      }
    });
  }
  if (
    value.listeningItemProgress !== undefined &&
    (!Array.isArray(value.listeningItemProgress) ||
      !isBackupCollectionCountAllowed(
        value.listeningItemProgress.length,
        MAX_LISTENING_PROGRESS_COUNT,
      ))
  ) {
    d.push({
      code: "INVALID_LISTENING_PROGRESS",
      path: "$.listeningItemProgress",
      message: "Danh sách tiến độ câu luyện nghe không hợp lệ.",
    });
  }
  if (Array.isArray(value.listeningItemProgress)) {
    const progressKeys = new Set<string>();
    value.listeningItemProgress.forEach((progress, index) => {
      const path = `$.listeningItemProgress[${index}]`;
      const lessonId = record(progress) ? progress.lessonId : undefined;
      const target =
        record(progress) && typeof lessonId === "string" && typeof progress.id === "string"
          ? listeningItems.get(lessonId)?.get(progress.id)
          : undefined;
      const key =
        record(progress) && typeof progress.lessonId === "string" && typeof progress.id === "string"
          ? `${progress.lessonId}|${progress.id}`
          : "";
      if (
        !record(progress) ||
        !target ||
        target.sourceType !== progress.sourceType ||
        target.sourceItemId !== progress.sourceItemId ||
        progress.id !==
          listeningItemId(progress.lessonId as string, target.sourceType, target.sourceItemId) ||
        !nonNegativeInteger(progress.listenCount) ||
        !nonNegativeInteger(progress.loopCount) ||
        progress.loopCount > progress.listenCount ||
        typeof progress.transcriptRevealed !== "boolean" ||
        !LISTENING_RECOGNITION_STATES.includes(
          progress.recognitionStatus as ListeningRecognitionState,
        ) ||
        typeof progress.difficult !== "boolean" ||
        (progress.savedForRelisten !== undefined &&
          typeof progress.savedForRelisten !== "boolean") ||
        (progress.lastListenedAt !== undefined && !iso(progress.lastListenedAt)) ||
        !iso(progress.updatedAt) ||
        progressKeys.has(key)
      ) {
        d.push({
          code: "INVALID_LISTENING_ITEM_PROGRESS",
          path,
          message: "Tiến độ câu luyện nghe không hợp lệ hoặc không thuộc bài học.",
        });
      } else {
        progressKeys.add(key);
      }
    });
  }
  if (d.length) return { diagnostics: d };
  const document = value as unknown as BackupDocument;
  if (
    !record(document.integrity) ||
    !hasExactKeys(document.integrity, ["algorithm", "checksum"]) ||
    document.integrity.algorithm !== "SHA-256" ||
    typeof document.integrity.checksum !== "string" ||
    !SHA256.test(document.integrity.checksum) ||
    document.integrity.checksum !== checksum(bare(document))
  )
    d.push({
      code: "CHECKSUM_MISMATCH",
      path: "$.integrity.checksum",
      message: "Checksum không khớp; file có thể đã hỏng hoặc bị sửa.",
    });
  if (d.length) return { diagnostics: d };
  return {
    document: {
      ...document,
      progress: document.progress.map(
        (progress) => normalizeLessonProgress(progress, progress.lessonId).data!,
      ),
    },
    diagnostics: [],
  };
}

function createBackupDocument(
  database: DatabaseSync,
  appVersion: string,
  now = new Date().toISOString(),
  insideWriteTransaction = false,
  enforceArtifactByteLimit = true,
): BackupDocument {
  if (!insideWriteTransaction) database.exec("BEGIN");
  try {
    const lessonRows = database
      .prepare(
        `SELECT lesson_json, updated_at, source_title, source_url, source_channel,
                original_transcript, processed_transcript, was_truncated
         FROM lessons WHERE deleted_at IS NULL ORDER BY id`,
      )
      .all() as Array<{
      lesson_json: string;
      updated_at: string;
      source_title: string | null;
      source_url: string | null;
      source_channel: string | null;
      original_transcript: string | null;
      processed_transcript: string | null;
      was_truncated: number;
    }>;
    const lessons = lessonRows.map((row) => JSON.parse(row.lesson_json) as Lesson);
    const lessonSources = lessonRows.map((row, index): LessonSourceBackup => ({
      lessonId: lessons[index].id,
      title: row.source_title,
      url: row.source_url,
      channel: row.source_channel,
      originalTranscript: row.original_transcript,
      processedTranscript: row.processed_transcript,
      wasTruncated: Boolean(row.was_truncated),
      updatedAt: row.updated_at,
    }));
    const progress = (
      database
        .prepare(
          "SELECT p.progress_json FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.deleted_at IS NULL ORDER BY p.lesson_id",
        )
        .all() as { progress_json: string }[]
    ).map((r) => JSON.parse(r.progress_json) as LessonProgress);
    const speakingProgress = (
      database
        .prepare(
          "SELECT p.* FROM speaking_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.deleted_at IS NULL ORDER BY p.lesson_id,p.practice_item_id",
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      lessonId: String(r.lesson_id),
      practiceItemId: String(r.practice_item_id),
      sourceType: String(r.source_type),
      sourceItemId: String(r.source_item_id),
      status: r.status as SpeakingProgressBackup["status"],
      attemptCount: Number(r.attempt_count),
      helpCount: Number(r.help_count),
      showAnswerCount: Number(r.show_answer_count),
      recalledCount: Number(r.recalled_count),
      personalizedCount: Number(r.personalized_count),
      ...(r.self_rating
        ? { selfRating: r.self_rating as SpeakingProgressBackup["selfRating"] }
        : {}),
      ...(r.first_practiced_at ? { firstPracticedAt: String(r.first_practiced_at) } : {}),
      ...(r.last_practiced_at ? { lastPracticedAt: String(r.last_practiced_at) } : {}),
      updatedAt: String(r.updated_at),
    }));
    const speakingSessions = (
      database
        .prepare(
          "SELECT s.* FROM speaking_sessions s JOIN lessons l ON l.id=s.lesson_id WHERE l.deleted_at IS NULL ORDER BY s.lesson_id,s.updated_at",
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: String(r.id),
      lessonId: String(r.lesson_id),
      itemIds: JSON.parse(String(r.item_ids_json)) as string[],
      drafts: JSON.parse(String(r.drafts_json || "{}")) as Record<string, string>,
      checks: JSON.parse(String(r.checks_json || "{}")) as Record<string, unknown>,
      draftVersions: JSON.parse(String(r.draft_versions_json || "{}")) as Record<string, number>,
      checkVersions: JSON.parse(String(r.check_versions_json || "{}")) as Record<string, number>,
      revealedItemIds: JSON.parse(String(r.revealed_item_ids_json || "[]")) as string[],
      revision: Number(r.revision ?? 0),
      currentItemIndex: Number(r.current_item_index),
      currentStep: String(r.current_step),
      status: r.status as SpeakingSessionBackup["status"],
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      ...(r.completed_at ? { completedAt: String(r.completed_at) } : {}),
    }));
    const listeningSessions = (
      database
        .prepare(
          "SELECT s.* FROM listening_sessions s JOIN lessons l ON l.id=s.lesson_id WHERE l.deleted_at IS NULL ORDER BY s.lesson_id,s.started_at",
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      lessonId: String(row.lesson_id),
      status: row.status as ListeningSessionBackup["status"],
      currentStep: row.current_step as ListeningStep,
      ...(row.first_listen_comprehension
        ? {
            firstListenComprehension:
              row.first_listen_comprehension as ListeningSessionBackup["firstListenComprehension"],
          }
        : {}),
      firstListenNote: String(row.first_listen_note),
      ...(row.second_listen_comprehension
        ? {
            secondListenComprehension:
              row.second_listen_comprehension as ListeningSessionBackup["secondListenComprehension"],
          }
        : {}),
      ...(row.final_relisten_rating
        ? {
            finalRelistenRating:
              row.final_relisten_rating as ListeningSessionBackup["finalRelistenRating"],
          }
        : {}),
      finalNote: String(row.final_note),
      revealedItemIds: JSON.parse(String(row.revealed_item_ids_json)) as string[],
      selectedItemIds: JSON.parse(String(row.selected_item_ids_json)) as string[],
      selectedItems: JSON.parse(String(row.selected_items_json)) as ListeningItem[],
      track: String(row.listening_track),
      trackHash: String(row.track_hash),
      lessonContentHash: String(row.lesson_content_hash),
      selectionVersion: Number(row.selection_version),
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    }));
    const listeningItemProgress = (
      database
        .prepare(
          "SELECT p.* FROM listening_item_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.deleted_at IS NULL ORDER BY p.lesson_id,p.id",
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      lessonId: String(row.lesson_id),
      sourceType: String(row.source_type),
      sourceItemId: String(row.source_item_id),
      listenCount: Number(row.listen_count),
      loopCount: Number(row.loop_count),
      transcriptRevealed: Boolean(row.transcript_revealed),
      recognitionStatus: row.recognition_status as ListeningRecognitionState,
      difficult: Boolean(row.difficult),
      savedForRelisten: Boolean(row.saved_for_relisten),
      ...(row.last_listened_at ? { lastListenedAt: String(row.last_listened_at) } : {}),
      updatedAt: String(row.updated_at),
    }));
    const payload: BareBackup = {
      backupFormat: BACKUP_FORMAT,
      backupVersion: CURRENT_BACKUP_VERSION,
      exportedAt: now,
      appVersion,
      databaseSchemaVersion: CURRENT_DATABASE_VERSION,
      lessonSchemaVersion: CURRENT_LESSON_SCHEMA_VERSION,
      progressSchemaVersion: 1,
      lessons,
      lessonSources,
      progress,
      speakingProgress,
      speakingSessions,
      listeningSessions,
      listeningItemProgress,
      settings: {},
    };
    const document: BackupDocument = {
      ...payload,
      integrity: { algorithm: "SHA-256", checksum: checksum(payload) },
    };
    const validated = validateBackup(document, { enforceArtifactByteLimit: false });
    if (!validated.document)
      throw new Error(
        `Dữ liệu SQLite không hợp lệ: ${validated.diagnostics.map((x) => x.message).join("; ")}`,
      );
    if (enforceArtifactByteLimit && !isBackupByteLengthAllowed(serializedUtf8Bytes(document))) {
      throw new StorageError(
        "VALIDATION_ERROR",
        `Bản sao lưu hiện tại vượt quá giới hạn ${MAX_BACKUP_BYTES} byte. Dữ liệu học vẫn được lưu bình thường.`,
      );
    }
    if (!insideWriteTransaction) database.exec("COMMIT");
    return document;
  } catch (error) {
    if (!insideWriteTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function inspectBackupCapacity(
  database: DatabaseSync,
  appVersion: string,
  now = new Date().toISOString(),
): BackupCapacityStatus {
  try {
    const document = createBackupDocument(database, appVersion, now, false, false);
    const estimatedBytes = serializedUtf8Bytes(document);
    if (!isBackupByteLengthAllowed(estimatedBytes)) {
      return {
        state: "too_large",
        estimatedBytes,
        maximumBytes: MAX_BACKUP_BYTES,
        exportAvailable: false,
        reason:
          "Dữ liệu hiện tại vẫn được lưu bình thường, nhưng đã vượt kích thước tối đa của một tệp sao lưu.",
      };
    }
    return {
      state: "ready",
      estimatedBytes,
      maximumBytes: MAX_BACKUP_BYTES,
      exportAvailable: true,
    };
  } catch (error) {
    return {
      state: "unavailable",
      estimatedBytes: null,
      maximumBytes: MAX_BACKUP_BYTES,
      exportAvailable: false,
      reason:
        error instanceof Error
          ? `Không thể kiểm tra bản sao lưu: ${error.message}`
          : "Không thể kiểm tra bản sao lưu hiện tại.",
    };
  }
}

export function exportBackup(
  database: DatabaseSync,
  appVersion: string,
  now = new Date().toISOString(),
): BackupDocument {
  return createBackupDocument(database, appVersion, now);
}

function existing(database: DatabaseSync): Map<string, Lesson> {
  return new Map(
    (
      database.prepare("SELECT id,lesson_json FROM lessons WHERE deleted_at IS NULL").all() as {
        id: string;
        lesson_json: string;
      }[]
    ).map((r) => [r.id, JSON.parse(r.lesson_json) as Lesson]),
  );
}
export function previewImport(database: DatabaseSync, value: unknown): ImportPreview {
  const validated = validateBackup(value);
  const doc = validated.document;
  if (!doc)
    return {
      valid: false,
      backupVersion:
        record(value) && typeof value.backupVersion === "number" ? value.backupVersion : undefined,
      lessonCount: Array.isArray((value as Record<string, unknown>)?.lessons)
        ? ((value as Record<string, unknown>).lessons as unknown[]).length
        : 0,
      lessonSourceCount: Array.isArray((value as Record<string, unknown>)?.lessonSources)
        ? ((value as Record<string, unknown>).lessonSources as unknown[]).length
        : 0,
      progressCount: Array.isArray((value as Record<string, unknown>)?.progress)
        ? ((value as Record<string, unknown>).progress as unknown[]).length
        : 0,
      speakingProgressCount: Array.isArray((value as Record<string, unknown>)?.speakingProgress)
        ? ((value as Record<string, unknown>).speakingProgress as unknown[]).length
        : 0,
      speakingSessionCount: Array.isArray((value as Record<string, unknown>)?.speakingSessions)
        ? ((value as Record<string, unknown>).speakingSessions as unknown[]).length
        : 0,
      listeningSessionCount: Array.isArray((value as Record<string, unknown>)?.listeningSessions)
        ? ((value as Record<string, unknown>).listeningSessions as unknown[]).length
        : 0,
      listeningItemProgressCount: Array.isArray(
        (value as Record<string, unknown>)?.listeningItemProgress,
      )
        ? ((value as Record<string, unknown>).listeningItemProgress as unknown[]).length
        : 0,
      validRecords: 0,
      invalidRecords: validated.diagnostics.length,
      duplicates: 0,
      conflicts: 0,
      remaps: 0,
      newLessons: 0,
      updatedLessons: 0,
      previouslyImported: false,
      warnings: [],
      diagnostics: validated.diagnostics,
    };
  const current = existing(database);
  const fingerprints = new Map([...current.values()].map((l) => [contentFingerprint(l), l.id]));
  let duplicates = 0,
    conflicts = 0,
    newLessons = 0,
    remaps = 0;
  for (const lesson of doc.lessons) {
    const same = current.get(lesson.id);
    const duplicateId = fingerprints.get(contentFingerprint(lesson));
    if (same) {
      if (contentFingerprint(same) === contentFingerprint(lesson)) duplicates++;
      else {
        conflicts++;
        remaps++;
        if (duplicateId) duplicates++;
        else newLessons++;
      }
    } else if (duplicateId) {
      duplicates++;
      if (duplicateId !== lesson.id) remaps++;
    } else newLessons++;
  }
  const fingerprint = doc.integrity.checksum;
  const prior = Boolean(
    database
      .prepare("SELECT 1 FROM import_receipts WHERE source_fingerprint=? AND result='success'")
      .get(fingerprint),
  );
  const warnings: string[] = [];
  if (conflicts) warnings.push(`${conflicts} xung đột ID sẽ được giữ cả hai bằng ID mới khi gộp.`);
  if (prior) warnings.push("Backup này đã từng được nhập; hãy xác nhận nếu muốn tiếp tục.");
  if (doc.backupVersion === 1 && doc.lessonSources === undefined)
    warnings.push(
      "Backup v1 không chứa dữ liệu nguồn/transcript; các field nguồn sẽ được khôi phục mặc định là rỗng.",
    );
  return {
    valid: true,
    backupVersion: doc.backupVersion,
    exportedAt: doc.exportedAt,
    appVersion: doc.appVersion,
    databaseSchemaVersion: doc.databaseSchemaVersion,
    lessonCount: doc.lessons.length,
    lessonSourceCount: doc.lessonSources?.length ?? 0,
    progressCount: doc.progress.length,
    speakingProgressCount: doc.speakingProgress?.length ?? 0,
    speakingSessionCount: doc.speakingSessions?.length ?? 0,
    listeningSessionCount: doc.listeningSessions?.length ?? 0,
    listeningItemProgressCount: doc.listeningItemProgress?.length ?? 0,
    validRecords:
      doc.lessons.length +
      (doc.lessonSources?.length ?? 0) +
      doc.progress.length +
      (doc.speakingProgress?.length ?? 0) +
      (doc.speakingSessions?.length ?? 0) +
      (doc.listeningSessions?.length ?? 0) +
      (doc.listeningItemProgress?.length ?? 0),
    invalidRecords: 0,
    duplicates,
    conflicts,
    remaps,
    newLessons,
    updatedLessons: duplicates,
    previouslyImported: prior,
    warnings,
    diagnostics: [],
    fingerprint,
  };
}

export function mergeProgress(a: LessonProgress | undefined, b: LessonProgress): LessonProgress {
  if (!a) return b;
  const newer = Date.parse(b.updatedAt) >= Date.parse(a.updatedAt) ? b : a;
  const older = newer === b ? a : b;
  const quizItems = { ...older.quizItems, ...newer.quizItems };
  for (const id of new Set([...Object.keys(a.quizItems), ...Object.keys(b.quizItems)])) {
    const x = a.quizItems[id],
      y = b.quizItems[id];
    if (x && y)
      quizItems[id] = {
        ...(Date.parse(y.answeredAt) >= Date.parse(x.answeredAt) ? y : x),
        attemptCount: Math.max(x.attemptCount, y.attemptCount),
        completed: x.completed || y.completed,
      };
  }
  const learningRank: Record<LearningItemProgress["status"], number> = {
    new: 0,
    learning: 1,
    learned: 2,
  };
  const learningItems = { ...older.learningItems, ...newer.learningItems };
  for (const id of new Set([...Object.keys(a.learningItems), ...Object.keys(b.learningItems)])) {
    const left = a.learningItems[id];
    const right = b.learningItems[id];
    if (left && right) {
      learningItems[id] =
        learningRank[left.status] > learningRank[right.status]
          ? left
          : learningRank[right.status] > learningRank[left.status]
            ? right
            : Date.parse(left.updatedAt) >= Date.parse(right.updatedAt)
              ? left
              : right;
    }
  }
  const historyById = new Map(a.practiceHistory.map((item) => [item.id, item]));
  for (const item of b.practiceHistory) {
    const old = historyById.get(item.id);
    if (!old || Date.parse(item.occurredAt) >= Date.parse(old.occurredAt)) {
      historyById.set(item.id, item);
    }
  }
  return {
    ...newer,
    quizItems,
    learningItems,
    visitedSections: [...new Set([...a.visitedSections, ...b.visitedSections])],
    practiceHistory: [...historyById.values()]
      .sort(
        (left, right) =>
          Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, PRACTICE_HISTORY_LIMIT),
    createdAt: Date.parse(a.createdAt) < Date.parse(b.createdAt) ? a.createdAt : b.createdAt,
  };
}
const speakingRank: Record<SpeakingProgressBackup["status"], number> = {
  new: 0,
  practicing: 1,
  recalled_with_help: 2,
  recalled: 3,
  personalized: 4,
};
export function mergeSpeakingProgress(
  a: SpeakingProgressBackup | undefined,
  b: SpeakingProgressBackup,
): SpeakingProgressBackup {
  if (!a) return b;
  const newer = Date.parse(b.updatedAt) >= Date.parse(a.updatedAt) ? b : a;
  return {
    ...newer,
    status: speakingRank[a.status] >= speakingRank[b.status] ? a.status : b.status,
    attemptCount: Math.max(a.attemptCount, b.attemptCount),
    helpCount: Math.max(a.helpCount, b.helpCount),
    showAnswerCount: Math.max(a.showAnswerCount, b.showAnswerCount),
    recalledCount: Math.max(a.recalledCount, b.recalledCount),
    personalizedCount: Math.max(a.personalizedCount, b.personalizedCount),
    firstPracticedAt: !a.firstPracticedAt
      ? b.firstPracticedAt
      : !b.firstPracticedAt
        ? a.firstPracticedAt
        : Date.parse(a.firstPracticedAt) <= Date.parse(b.firstPracticedAt)
          ? a.firstPracticedAt
          : b.firstPracticedAt,
    lastPracticedAt: !a.lastPracticedAt
      ? b.lastPracticedAt
      : !b.lastPracticedAt
        ? a.lastPracticedAt
        : Date.parse(a.lastPracticedAt) >= Date.parse(b.lastPracticedAt)
          ? a.lastPracticedAt
          : b.lastPracticedAt,
    updatedAt: Date.parse(a.updatedAt) >= Date.parse(b.updatedAt) ? a.updatedAt : b.updatedAt,
  };
}
const listeningRecognitionRank: Record<ListeningRecognitionState, number> = {
  not_started: 0,
  heard: 1,
  recognized: 2,
};
const listeningStepRank = new Map(LISTENING_STEPS.map((step, index) => [step, index]));

export function mergeListeningItemProgress(
  current: ListeningItemProgressBackup | undefined,
  incoming: ListeningItemProgressBackup,
): ListeningItemProgressBackup {
  if (!current) return incoming;
  const newer =
    Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt) ? incoming : current;
  const recognitionStatus =
    listeningRecognitionRank[current.recognitionStatus] >=
    listeningRecognitionRank[incoming.recognitionStatus]
      ? current.recognitionStatus
      : incoming.recognitionStatus;
  const lastListenedAt = !current.lastListenedAt
    ? incoming.lastListenedAt
    : !incoming.lastListenedAt
      ? current.lastListenedAt
      : Date.parse(current.lastListenedAt) >= Date.parse(incoming.lastListenedAt)
        ? current.lastListenedAt
        : incoming.lastListenedAt;
  return {
    ...newer,
    listenCount: Math.max(current.listenCount, incoming.listenCount),
    loopCount: Math.max(current.loopCount, incoming.loopCount),
    transcriptRevealed: current.transcriptRevealed || incoming.transcriptRevealed,
    recognitionStatus,
    difficult: recognitionStatus === "recognized" ? false : newer.difficult,
    savedForRelisten:
      newer.savedForRelisten ?? current.savedForRelisten ?? incoming.savedForRelisten ?? false,
    ...(lastListenedAt ? { lastListenedAt } : {}),
    updatedAt:
      Date.parse(current.updatedAt) >= Date.parse(incoming.updatedAt)
        ? current.updatedAt
        : incoming.updatedAt,
  };
}

export function mergeListeningSession(
  current: ListeningSessionBackup | undefined,
  incoming: ListeningSessionBackup,
): ListeningSessionBackup {
  if (!current) return incoming;
  const newer =
    Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt) ? incoming : current;
  const farther =
    (listeningStepRank.get(current.currentStep) ?? 0) >=
    (listeningStepRank.get(incoming.currentStep) ?? 0)
      ? current
      : incoming;
  const completed =
    current.status === "completed"
      ? current
      : incoming.status === "completed"
        ? incoming
        : undefined;
  const completedAt = !current.completedAt
    ? incoming.completedAt
    : !incoming.completedAt
      ? current.completedAt
      : Date.parse(current.completedAt) >= Date.parse(incoming.completedAt)
        ? current.completedAt
        : incoming.completedAt;
  const snapshotOwner = current.selectedItems?.length ? current : incoming;
  const selectedIds = snapshotOwner.selectedItemIds
    ? new Set(snapshotOwner.selectedItemIds)
    : undefined;
  const revealedItemIds = [
    ...new Set([...current.revealedItemIds, ...incoming.revealedItemIds]),
  ].filter((itemId) => !selectedIds || selectedIds.has(itemId));
  return {
    ...newer,
    status: completed ? "completed" : newer.status,
    currentStep: completed ? "complete" : farther.currentStep,
    revealedItemIds,
    ...(snapshotOwner.selectedItemIds && snapshotOwner.selectedItems
      ? {
          selectedItemIds: snapshotOwner.selectedItemIds,
          selectedItems: snapshotOwner.selectedItems,
          track: snapshotOwner.track,
          trackHash: snapshotOwner.trackHash,
          lessonContentHash: snapshotOwner.lessonContentHash,
          selectionVersion: snapshotOwner.selectionVersion,
        }
      : {}),
    startedAt:
      Date.parse(current.startedAt) <= Date.parse(incoming.startedAt)
        ? current.startedAt
        : incoming.startedAt,
    updatedAt:
      Date.parse(current.updatedAt) >= Date.parse(incoming.updatedAt)
        ? current.updatedAt
        : incoming.updatedAt,
    ...(completedAt ? { completedAt } : {}),
  };
}
function dbSpeaking(row: Record<string, unknown>): SpeakingProgressBackup {
  return {
    lessonId: String(row.lesson_id),
    practiceItemId: String(row.practice_item_id),
    sourceType: String(row.source_type),
    sourceItemId: String(row.source_item_id),
    status: row.status as SpeakingProgressBackup["status"],
    attemptCount: Number(row.attempt_count),
    helpCount: Number(row.help_count),
    showAnswerCount: Number(row.show_answer_count),
    recalledCount: Number(row.recalled_count),
    personalizedCount: Number(row.personalized_count),
    ...(row.self_rating
      ? { selfRating: row.self_rating as SpeakingProgressBackup["selfRating"] }
      : {}),
    ...(row.first_practiced_at ? { firstPracticedAt: String(row.first_practiced_at) } : {}),
    ...(row.last_practiced_at ? { lastPracticedAt: String(row.last_practiced_at) } : {}),
    updatedAt: String(row.updated_at),
  };
}

function dbListeningProgress(row: Record<string, unknown>): ListeningItemProgressBackup {
  return {
    id: String(row.id),
    lessonId: String(row.lesson_id),
    sourceType: String(row.source_type),
    sourceItemId: String(row.source_item_id),
    listenCount: Number(row.listen_count),
    loopCount: Number(row.loop_count),
    transcriptRevealed: Boolean(row.transcript_revealed),
    recognitionStatus: row.recognition_status as ListeningRecognitionState,
    difficult: Boolean(row.difficult),
    savedForRelisten: Boolean(row.saved_for_relisten),
    ...(row.last_listened_at ? { lastListenedAt: String(row.last_listened_at) } : {}),
    updatedAt: String(row.updated_at),
  };
}

function dbListeningSession(row: Record<string, unknown>): ListeningSessionBackup {
  return {
    id: String(row.id),
    lessonId: String(row.lesson_id),
    status: row.status as ListeningSessionBackup["status"],
    currentStep: row.current_step as ListeningStep,
    ...(row.first_listen_comprehension
      ? {
          firstListenComprehension:
            row.first_listen_comprehension as ListeningSessionBackup["firstListenComprehension"],
        }
      : {}),
    firstListenNote: String(row.first_listen_note),
    ...(row.second_listen_comprehension
      ? {
          secondListenComprehension:
            row.second_listen_comprehension as ListeningSessionBackup["secondListenComprehension"],
        }
      : {}),
    ...(row.final_relisten_rating
      ? {
          finalRelistenRating:
            row.final_relisten_rating as ListeningSessionBackup["finalRelistenRating"],
        }
      : {}),
    finalNote: String(row.final_note),
    revealedItemIds: JSON.parse(String(row.revealed_item_ids_json)) as string[],
    selectedItemIds: JSON.parse(String(row.selected_item_ids_json)) as string[],
    selectedItems: JSON.parse(String(row.selected_items_json)) as ListeningItem[],
    track: String(row.listening_track),
    trackHash: String(row.track_hash),
    lessonContentHash: String(row.lesson_content_hash),
    selectionVersion: Number(row.selection_version),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
  };
}

function remapListeningSnapshot(
  snapshot: ListeningSessionSnapshot,
  targetLessonId: string,
  targetItems: ListeningItem[],
): ListeningSessionSnapshot {
  const targetByIdentity = new Map(
    targetItems.map((item) => [`${item.sourceType}|${item.sourceItemId}`, item]),
  );
  const selectedItems = snapshot.selectedItems.map((item) => {
    const target = targetByIdentity.get(`${item.sourceType}|${item.sourceItemId}`);
    return {
      ...item,
      id: listeningItemId(targetLessonId, item.sourceType, item.sourceItemId),
      lessonId: targetLessonId,
      speakingPracticeItemId: target?.speakingPracticeItemId,
    };
  });
  return {
    ...snapshot,
    selectedItems,
    selectedItemIds: selectedItems.map((item) => item.id),
  };
}

export function importBackup(
  database: DatabaseSync,
  value: unknown,
  mode: "merge" | "replace",
  allowRepeat = false,
): ImportPreview {
  const preview = previewImport(database, value);
  if (!preview.valid) throw new Error(preview.diagnostics.map((x) => x.message).join("; "));
  if (preview.previouslyImported && !allowRepeat)
    throw new Error("Backup này đã được nhập. Cần xác nhận trước khi nhập lại.");
  const doc = validateBackup(value).document!;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (mode === "replace") {
      database.exec(
        `DELETE FROM listening_item_progress;
         DELETE FROM listening_sessions;
         DELETE FROM speaking_progress;
         DELETE FROM speaking_sessions;
         DELETE FROM lesson_progress;
         DELETE FROM legacy_migration_items;
         DELETE FROM lessons;`,
      );
    }
    const current = existing(database);
    const byFingerprint = new Map([...current.values()].map((l) => [contentFingerprint(l), l.id]));
    const remap = new Map<string, string>();
    const sourceByLesson = new Map(
      (doc.lessonSources ?? []).map((source) => [source.lessonId, source]),
    );
    const expectedSources = new Map<string, LessonSourceBackup>();
    const now = new Date().toISOString();
    for (const source of doc.lessons) {
      let id = source.id;
      const same = current.get(id);
      const fp = contentFingerprint(source);
      if (mode === "merge" && same && contentFingerprint(same) !== fp)
        id = byFingerprint.get(fp) ?? randomUUID();
      else if (mode === "merge" && !same && byFingerprint.has(fp)) id = byFingerprint.get(fp)!;
      remap.set(source.id, id);
      const incomingSource = sourceByLesson.get(source.id) ?? {
        lessonId: source.id,
        title: null,
        url: null,
        channel: null,
        originalTranscript: null,
        processedTranscript: null,
        wasTruncated: false,
        updatedAt: source.updatedAt,
      };
      const currentRow = database
        .prepare(
          `SELECT updated_at,source_title,source_url,source_channel,original_transcript,
                  processed_transcript,was_truncated FROM lessons WHERE id=?`,
        )
        .get(id) as
        | {
            updated_at: string;
            source_title: string | null;
            source_url: string | null;
            source_channel: string | null;
            original_transcript: string | null;
            processed_transcript: string | null;
            was_truncated: number;
          }
        | undefined;
      if (currentRow) {
        const currentSource: LessonSourceBackup = {
          lessonId: id,
          title: currentRow.source_title,
          url: currentRow.source_url,
          channel: currentRow.source_channel,
          originalTranscript: currentRow.original_transcript,
          processedTranscript: currentRow.processed_transcript,
          wasTruncated: Boolean(currentRow.was_truncated),
          updatedAt: currentRow.updated_at,
        };
        const winner =
          mode === "merge" &&
          Date.parse(currentSource.updatedAt) > Date.parse(incomingSource.updatedAt)
            ? currentSource
            : { ...incomingSource, lessonId: id };
        if (winner !== currentSource)
          database
            .prepare(
              `UPDATE lessons SET source_title=?,source_url=?,source_channel=?,
                 original_transcript=?,processed_transcript=?,was_truncated=?,updated_at=?
               WHERE id=?`,
            )
            .run(
              winner.title,
              winner.url,
              winner.channel,
              winner.originalTranscript,
              winner.processedTranscript,
              winner.wasTruncated ? 1 : 0,
              winner.updatedAt,
              id,
            );
        expectedSources.set(id, winner);
        continue;
      }
      const lesson = { ...source, id };
      database
        .prepare(
          `INSERT INTO lessons(
             id,schema_version,title,summary,lesson_json,created_at,updated_at,
             source_title,source_url,source_channel,original_transcript,
             processed_transcript,was_truncated
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          1,
          lesson.title,
          lesson.summary,
          JSON.stringify(lesson),
          lesson.createdAt,
          incomingSource.updatedAt,
          incomingSource.title,
          incomingSource.url,
          incomingSource.channel,
          incomingSource.originalTranscript,
          incomingSource.processedTranscript,
          incomingSource.wasTruncated ? 1 : 0,
        );
      current.set(id, lesson);
      byFingerprint.set(fp, id);
      expectedSources.set(id, { ...incomingSource, lessonId: id });
    }
    for (const source of doc.progress) {
      const id = remap.get(source.lessonId)!;
      const incoming = { ...source, lessonId: id };
      const row = database
        .prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?")
        .get(id) as { progress_json: string } | undefined;
      const merged =
        mode === "merge"
          ? mergeProgress(row ? JSON.parse(row.progress_json) : undefined, incoming)
          : incoming;
      database
        .prepare(
          "INSERT INTO lesson_progress(lesson_id,progress_version,progress_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(lesson_id) DO UPDATE SET progress_json=excluded.progress_json,progress_version=excluded.progress_version,updated_at=excluded.updated_at",
        )
        .run(id, 1, JSON.stringify(merged), merged.createdAt, merged.updatedAt);
    }
    for (const source of doc.speakingProgress ?? []) {
      const id = remap.get(source.lessonId);
      if (!id) continue;
      const targetLessonRow = database
        .prepare("SELECT lesson_json FROM lessons WHERE id=?")
        .get(id) as { lesson_json: string } | undefined;
      if (!targetLessonRow) continue;
      const target = extractPracticeCandidates(
        JSON.parse(targetLessonRow.lesson_json) as Lesson,
      ).find((x) => x.sourceType === source.sourceType && x.sourceItemId === source.sourceItemId);
      if (!target) continue;
      const incoming = { ...source, lessonId: id, practiceItemId: target.id };
      const old = database
        .prepare("SELECT * FROM speaking_progress WHERE lesson_id=? AND practice_item_id=?")
        .get(id, target.id) as Record<string, unknown> | undefined;
      const merged =
        mode === "merge"
          ? mergeSpeakingProgress(old ? dbSpeaking(old) : undefined, incoming)
          : incoming;
      database
        .prepare(
          "INSERT INTO speaking_progress(lesson_id,practice_item_id,source_type,source_item_id,status,attempt_count,help_count,show_answer_count,recalled_count,personalized_count,self_rating,first_practiced_at,last_practiced_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lesson_id,practice_item_id) DO UPDATE SET status=excluded.status,attempt_count=excluded.attempt_count,help_count=excluded.help_count,show_answer_count=excluded.show_answer_count,recalled_count=excluded.recalled_count,personalized_count=excluded.personalized_count,self_rating=excluded.self_rating,first_practiced_at=excluded.first_practiced_at,last_practiced_at=excluded.last_practiced_at,updated_at=excluded.updated_at",
        )
        .run(
          id,
          target.id,
          target.sourceType,
          target.sourceItemId,
          merged.status,
          merged.attemptCount,
          merged.helpCount,
          merged.showAnswerCount,
          merged.recalledCount,
          merged.personalizedCount,
          merged.selfRating ?? null,
          merged.firstPracticedAt ?? null,
          merged.lastPracticedAt ?? null,
          merged.updatedAt,
        );
    }
    for (const source of doc.speakingSessions ?? []) {
      const id = remap.get(source.lessonId);
      if (!id) continue;
      const oldLesson = doc.lessons.find((x) => x.id === source.lessonId),
        targetRow = database.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as
          { lesson_json: string } | undefined;
      if (!oldLesson || !targetRow) continue;
      const oldCandidates = extractPracticeCandidates(oldLesson),
        newCandidates = extractPracticeCandidates(JSON.parse(targetRow.lesson_json) as Lesson);
      const mapped = source.itemIds.map((oldId) => {
        const old = oldCandidates.find((x) => x.id === oldId);
        return (
          old &&
          newCandidates.find(
            (x) => x.sourceType === old.sourceType && x.sourceItemId === old.sourceItemId,
          )?.id
        );
      });
      if (mapped.some((x) => !x))
        throw new Error(`Không thể remap speaking item cho session ${source.id}.`);
      const mappedIds = mapped as string[];
      let sessionId = source.id;
      const idCollision = database
        .prepare("SELECT lesson_id FROM speaking_sessions WHERE id=?")
        .get(sessionId) as { lesson_id: string } | undefined;
      if (idCollision && idCollision.lesson_id !== id) sessionId = randomUUID();
      const sameSession =
        idCollision?.lesson_id === id
          ? (database.prepare("SELECT * FROM speaking_sessions WHERE id=?").get(sessionId) as
              Record<string, unknown> | undefined)
          : undefined;
      const sessionStatusRank = {
        active: 0,
        cancelled: 1,
        completed: 2,
      } as const;
      if (
        mode === "merge" &&
        sameSession &&
        (sessionStatusRank[sameSession.status as keyof typeof sessionStatusRank] >
          sessionStatusRank[source.status] ||
          Number(sameSession.revision ?? 0) > (source.revision ?? 0) ||
          (Number(sameSession.revision ?? 0) === (source.revision ?? 0) &&
            Date.parse(String(sameSession.updated_at)) >= Date.parse(source.updatedAt)))
      )
        continue;
      const local = database
        .prepare("SELECT * FROM speaking_sessions WHERE lesson_id=? AND status='active' AND id<>?")
        .get(id, sessionId) as Record<string, unknown> | undefined;
      const incomingStepRank = LADDER_STEPS.indexOf(
        source.currentStep as (typeof LADDER_STEPS)[number],
      );
      const localStepRank = local
        ? LADDER_STEPS.indexOf(String(local.current_step) as (typeof LADDER_STEPS)[number])
        : -1;
      if (
        source.status === "active" &&
        local &&
        (Number(local.current_item_index) > source.currentItemIndex ||
          (Number(local.current_item_index) === source.currentItemIndex &&
            (localStepRank > incomingStepRank ||
              (localStepRank === incomingStepRank &&
                Date.parse(String(local.updated_at)) >= Date.parse(source.updatedAt)))))
      )
        continue;
      if (source.status === "active" && local)
        database
          .prepare("UPDATE speaking_sessions SET status='cancelled',updated_at=? WHERE id=?")
          .run(now, String(local.id));
      const remapObject = (value: Record<string, unknown> | undefined) =>
        Object.fromEntries(
          Object.entries(value ?? {}).flatMap(([oldId, data]) => {
            const at = source.itemIds.indexOf(oldId),
              newId = at >= 0 ? mapped[at] : undefined;
            return newId ? [[newId, data]] : [];
          }),
        );
      database
        .prepare(
          `INSERT INTO speaking_sessions(
             id,lesson_id,item_ids_json,drafts_json,draft_versions_json,checks_json,check_versions_json,
             revealed_item_ids_json,current_item_index,current_step,revision,status,
             created_at,updated_at,completed_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
              lesson_id=excluded.lesson_id,item_ids_json=excluded.item_ids_json,
              drafts_json=excluded.drafts_json,draft_versions_json=excluded.draft_versions_json,
              checks_json=excluded.checks_json,check_versions_json=excluded.check_versions_json,
              revealed_item_ids_json=excluded.revealed_item_ids_json,
              current_item_index=excluded.current_item_index,current_step=excluded.current_step,
              revision=excluded.revision,status=excluded.status,created_at=excluded.created_at,
              updated_at=excluded.updated_at,completed_at=excluded.completed_at`,
        )
        .run(
          sessionId,
          id,
          JSON.stringify(mappedIds),
          JSON.stringify(remapObject(source.drafts)),
          JSON.stringify(remapObject(source.draftVersions)),
          JSON.stringify(remapObject(source.checks)),
          JSON.stringify(remapObject(source.checkVersions)),
          JSON.stringify(
            (source.revealedItemIds ?? []).flatMap((oldId) => {
              const at = source.itemIds.indexOf(oldId);
              return at >= 0 && mapped[at] ? [mapped[at]] : [];
            }),
          ),
          source.currentItemIndex,
          source.currentStep,
          source.revision ?? 0,
          source.status,
          source.createdAt,
          source.updatedAt,
          source.completedAt ?? null,
        );
    }
    for (const source of doc.listeningItemProgress ?? []) {
      const id = remap.get(source.lessonId);
      if (!id) continue;
      const targetLessonRow = database
        .prepare("SELECT lesson_json FROM lessons WHERE id=?")
        .get(id) as { lesson_json: string } | undefined;
      if (!targetLessonRow) continue;
      const target = extractListeningItems(JSON.parse(targetLessonRow.lesson_json) as Lesson).find(
        (item) =>
          item.sourceType === source.sourceType && item.sourceItemId === source.sourceItemId,
      );
      if (!target) continue;
      const incoming: ListeningItemProgressBackup = {
        ...source,
        id: target.id,
        lessonId: id,
        sourceType: target.sourceType,
        sourceItemId: target.sourceItemId,
      };
      const old = database
        .prepare("SELECT * FROM listening_item_progress WHERE lesson_id=? AND id=?")
        .get(id, target.id) as Record<string, unknown> | undefined;
      const merged =
        mode === "merge"
          ? mergeListeningItemProgress(old ? dbListeningProgress(old) : undefined, incoming)
          : incoming;
      database
        .prepare(
          `INSERT INTO listening_item_progress(
            id,lesson_id,source_type,source_item_id,listen_count,loop_count,
            transcript_revealed,recognition_status,difficult,saved_for_relisten,
            last_listened_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(lesson_id,id) DO UPDATE SET
            source_type=excluded.source_type,source_item_id=excluded.source_item_id,
            listen_count=excluded.listen_count,loop_count=excluded.loop_count,
            transcript_revealed=excluded.transcript_revealed,
            recognition_status=excluded.recognition_status,difficult=excluded.difficult,
            saved_for_relisten=excluded.saved_for_relisten,
            last_listened_at=excluded.last_listened_at,updated_at=excluded.updated_at`,
        )
        .run(
          merged.id,
          merged.lessonId,
          merged.sourceType,
          merged.sourceItemId,
          merged.listenCount,
          merged.loopCount,
          merged.transcriptRevealed ? 1 : 0,
          merged.recognitionStatus,
          merged.difficult ? 1 : 0,
          merged.savedForRelisten ? 1 : 0,
          merged.lastListenedAt ?? null,
          merged.updatedAt,
        );
    }
    for (const source of doc.listeningSessions ?? []) {
      const id = remap.get(source.lessonId);
      if (!id) continue;
      const oldLesson = doc.lessons.find((lesson) => lesson.id === source.lessonId);
      const targetLessonRow = database
        .prepare("SELECT lesson_json FROM lessons WHERE id=?")
        .get(id) as { lesson_json: string } | undefined;
      if (!oldLesson || !targetLessonRow) continue;
      const targetItems = extractListeningItems(JSON.parse(targetLessonRow.lesson_json) as Lesson);
      const explicitSnapshot = {
        selectedItemIds: source.selectedItemIds,
        selectedItems: source.selectedItems,
        track: source.track,
        trackHash: source.trackHash,
        lessonContentHash: source.lessonContentHash,
        selectionVersion: source.selectionVersion,
      };
      const sourceSnapshot = isListeningSessionSnapshot(explicitSnapshot, source.lessonId)
        ? explicitSnapshot
        : createListeningSessionSnapshot(oldLesson);
      const targetSnapshot = remapListeningSnapshot(sourceSnapshot, id, targetItems);
      const mappedReveals = source.revealedItemIds.flatMap((oldItemId) => {
        const index = sourceSnapshot.selectedItemIds.indexOf(oldItemId);
        return index >= 0 ? [targetSnapshot.selectedItemIds[index]] : [];
      });
      const incoming: ListeningSessionBackup = {
        ...source,
        lessonId: id,
        revealedItemIds: mappedReveals,
        selectedItemIds: targetSnapshot.selectedItemIds,
        selectedItems: targetSnapshot.selectedItems,
        track: targetSnapshot.track,
        trackHash: targetSnapshot.trackHash,
        lessonContentHash: targetSnapshot.lessonContentHash,
        selectionVersion: targetSnapshot.selectionVersion,
      };
      let sessionId = source.id;
      const idCollision = database
        .prepare("SELECT lesson_id FROM listening_sessions WHERE id=?")
        .get(sessionId) as { lesson_id: string } | undefined;
      if (idCollision && idCollision.lesson_id !== id) sessionId = randomUUID();
      const same = database
        .prepare("SELECT * FROM listening_sessions WHERE id=? AND lesson_id=?")
        .get(sessionId, id) as Record<string, unknown> | undefined;
      let merged =
        mode === "merge"
          ? mergeListeningSession(same ? dbListeningSession(same) : undefined, {
              ...incoming,
              id: sessionId,
            })
          : { ...incoming, id: sessionId };
      if (merged.status === "active") {
        const localActive = database
          .prepare(
            "SELECT * FROM listening_sessions WHERE lesson_id=? AND status='active' AND id<>?",
          )
          .get(id, sessionId) as Record<string, unknown> | undefined;
        if (localActive) {
          const local = dbListeningSession(localActive);
          const localIsFarther =
            (listeningStepRank.get(local.currentStep) ?? 0) >
              (listeningStepRank.get(merged.currentStep) ?? 0) ||
            ((listeningStepRank.get(local.currentStep) ?? 0) ===
              (listeningStepRank.get(merged.currentStep) ?? 0) &&
              Date.parse(local.updatedAt) >= Date.parse(merged.updatedAt));
          if (mode === "merge" && localIsFarther) continue;
          database
            .prepare("UPDATE listening_sessions SET status='cancelled',updated_at=? WHERE id=?")
            .run(now, local.id);
        }
      }
      if (merged.status === "completed") {
        merged = { ...merged, currentStep: "complete" };
      }
      database
        .prepare(
          `INSERT INTO listening_sessions(
            id,lesson_id,status,current_step,first_listen_comprehension,first_listen_note,
            second_listen_comprehension,final_relisten_rating,final_note,
            revealed_item_ids_json,selected_item_ids_json,selected_items_json,listening_track,
            track_hash,lesson_content_hash,selection_version,started_at,updated_at,completed_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            lesson_id=excluded.lesson_id,status=excluded.status,current_step=excluded.current_step,
            first_listen_comprehension=excluded.first_listen_comprehension,
            first_listen_note=excluded.first_listen_note,
            second_listen_comprehension=excluded.second_listen_comprehension,
            final_relisten_rating=excluded.final_relisten_rating,final_note=excluded.final_note,
            revealed_item_ids_json=excluded.revealed_item_ids_json,
            selected_item_ids_json=excluded.selected_item_ids_json,
            selected_items_json=excluded.selected_items_json,
            listening_track=excluded.listening_track,track_hash=excluded.track_hash,
            lesson_content_hash=excluded.lesson_content_hash,
            selection_version=excluded.selection_version,
            started_at=excluded.started_at,updated_at=excluded.updated_at,
            completed_at=excluded.completed_at`,
        )
        .run(
          merged.id,
          merged.lessonId,
          merged.status,
          merged.currentStep,
          merged.firstListenComprehension ?? null,
          merged.firstListenNote,
          merged.secondListenComprehension ?? null,
          merged.finalRelistenRating ?? null,
          merged.finalNote,
          JSON.stringify(merged.revealedItemIds),
          JSON.stringify(merged.selectedItemIds),
          JSON.stringify(merged.selectedItems),
          merged.track,
          merged.trackHash,
          merged.lessonContentHash,
          merged.selectionVersion,
          merged.startedAt,
          merged.updatedAt,
          merged.completedAt ?? null,
        );
    }
    for (const [oldId, id] of remap) {
      const l = database.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as
        { lesson_json: string } | undefined;
      if (!l || !validateCanonicalLesson(JSON.parse(l.lesson_json)).success)
        throw new Error(`Verify lesson thất bại: ${oldId}`);
    }
    for (const [id, expected] of expectedSources) {
      const row = database
        .prepare(
          `SELECT updated_at,source_title,source_url,source_channel,original_transcript,
                  processed_transcript,was_truncated FROM lessons WHERE id=?`,
        )
        .get(id) as Record<string, unknown> | undefined;
      if (
        !row ||
        row.source_title !== expected.title ||
        row.source_url !== expected.url ||
        row.source_channel !== expected.channel ||
        row.original_transcript !== expected.originalTranscript ||
        row.processed_transcript !== expected.processedTranscript ||
        Boolean(row.was_truncated) !== expected.wasTruncated ||
        row.updated_at !== expected.updatedAt
      )
        throw new Error(`Verify lesson source thất bại: ${id}`);
    }
    for (const source of doc.progress) {
      const id = remap.get(source.lessonId)!;
      const row = database
        .prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?")
        .get(id) as { progress_json: string } | undefined;
      const checked = row ? normalizeLessonProgress(JSON.parse(row.progress_json), id) : undefined;
      if (!checked?.success || checked.data?.lessonId !== id)
        throw new Error(`Verify progress thất bại: ${source.lessonId}`);
    }
    for (const id of new Set(remap.values())) {
      const targetRow = database.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as
        { lesson_json: string } | undefined;
      if (!targetRow) throw new Error(`Verify listening lesson thất bại: ${id}`);
      const lesson = JSON.parse(targetRow.lesson_json) as Lesson;
      const validSpeakingItems = new Map(
        extractPracticeCandidates(lesson).map((item) => [item.id, item]),
      );
      const validSpeakingTasks = new Map(
        buildSpeakingSession(lesson).map((item) => [item.id, item]),
      );
      const speakingRows = database
        .prepare("SELECT * FROM speaking_progress WHERE lesson_id=?")
        .all(id) as Record<string, unknown>[];
      for (const row of speakingRows) {
        const item = validSpeakingItems.get(String(row.practice_item_id));
        if (
          !item ||
          item.sourceType !== row.source_type ||
          item.sourceItemId !== row.source_item_id ||
          !SPEAKING_STATUSES.includes(row.status as (typeof SPEAKING_STATUSES)[number]) ||
          [
            row.attempt_count,
            row.help_count,
            row.show_answer_count,
            row.recalled_count,
            row.personalized_count,
          ].some((count) => !nonNegativeInteger(Number(count)))
        )
          throw new Error(`Verify speaking progress thất bại: ${id}`);
      }
      const speakingSessionRows = database
        .prepare("SELECT * FROM speaking_sessions WHERE lesson_id=?")
        .all(id) as Record<string, unknown>[];
      for (const row of speakingSessionRows) {
        const itemIds = JSON.parse(String(row.item_ids_json)) as unknown;
        const drafts = JSON.parse(String(row.drafts_json)) as unknown;
        const draftVersions = JSON.parse(String(row.draft_versions_json || "{}")) as unknown;
        const checkVersions = JSON.parse(String(row.check_versions_json || "{}")) as unknown;
        const checks = JSON.parse(String(row.checks_json)) as unknown;
        const revealedItemIds = JSON.parse(String(row.revealed_item_ids_json || "[]")) as unknown;
        const currentIndex = Number(row.current_item_index);
        const currentTask =
          Array.isArray(itemIds) && nonNegativeInteger(currentIndex)
            ? validSpeakingTasks.get(String(itemIds[currentIndex]))
            : undefined;
        if (
          !Array.isArray(itemIds) ||
          itemIds.length === 0 ||
          itemIds.some((itemId) => typeof itemId !== "string" || !validSpeakingTasks.has(itemId)) ||
          !currentTask ||
          !(currentIndex === itemIds.length - 1 ? LADDER_STEPS : currentTask.steps).includes(
            row.current_step as (typeof LADDER_STEPS)[number],
          ) ||
          !SESSION_STATUSES.includes(row.status as (typeof SESSION_STATUSES)[number]) ||
          !nonNegativeInteger(Number(row.revision ?? 0)) ||
          !record(drafts) ||
          !record(draftVersions) ||
          !record(checkVersions) ||
          !record(checks) ||
          !Array.isArray(revealedItemIds) ||
          Object.keys(drafts).some((itemId) => !itemIds.includes(itemId)) ||
          Object.entries(draftVersions).some(
            ([itemId, version]) => !itemIds.includes(itemId) || !nonNegativeInteger(version),
          ) ||
          Object.entries(checkVersions).some(
            ([itemId, version]) => !itemIds.includes(itemId) || !nonNegativeInteger(version),
          ) ||
          revealedItemIds.some(
            (itemId, revealIndex) =>
              typeof itemId !== "string" ||
              !itemIds.includes(itemId) ||
              revealedItemIds.indexOf(itemId) !== revealIndex,
          ) ||
          Object.entries(checks).some(
            ([itemId, check]) => !itemIds.includes(itemId) || !validSentenceCheck(check),
          )
        )
          throw new Error(`Verify speaking session thất bại: ${id}`);
      }
      const activeSpeakingCount = database
        .prepare(
          "SELECT COUNT(*) count FROM speaking_sessions WHERE lesson_id=? AND status='active'",
        )
        .get(id) as { count: number };
      if (Number(activeSpeakingCount.count) > 1)
        throw new Error(`Verify active speaking session thất bại: ${id}`);
      const validItems = new Map(extractListeningItems(lesson).map((item) => [item.id, item]));
      const rows = database
        .prepare("SELECT * FROM listening_item_progress WHERE lesson_id=?")
        .all(id) as Record<string, unknown>[];
      for (const row of rows) {
        const item = validItems.get(String(row.id));
        if (
          !item ||
          item.sourceType !== row.source_type ||
          item.sourceItemId !== row.source_item_id ||
          Number(row.listen_count) < 0 ||
          Number(row.loop_count) < 0
        )
          throw new Error(`Verify listening progress thất bại: ${id}`);
      }
      const activeCount = database
        .prepare(
          "SELECT COUNT(*) count FROM listening_sessions WHERE lesson_id=? AND status='active'",
        )
        .get(id) as { count: number };
      if (Number(activeCount.count) > 1)
        throw new Error(`Verify active listening session thất bại: ${id}`);
      const listeningSessionRows = database
        .prepare("SELECT * FROM listening_sessions WHERE lesson_id=?")
        .all(id) as Record<string, unknown>[];
      for (const row of listeningSessionRows) {
        const revealed = JSON.parse(String(row.revealed_item_ids_json)) as unknown;
        const snapshot = {
          selectedItemIds: JSON.parse(String(row.selected_item_ids_json)) as unknown,
          selectedItems: JSON.parse(String(row.selected_items_json)) as unknown,
          track: String(row.listening_track),
          trackHash: String(row.track_hash),
          lessonContentHash: String(row.lesson_content_hash),
          selectionVersion: Number(row.selection_version),
        };
        const snapshotValid = isListeningSessionSnapshot(snapshot, id);
        const snapshotIds = snapshotValid ? new Set(snapshot.selectedItemIds) : new Set<string>();
        if (
          !SESSION_STATUSES.includes(row.status as (typeof SESSION_STATUSES)[number]) ||
          !LISTENING_STEPS.includes(row.current_step as ListeningStep) ||
          !Array.isArray(revealed) ||
          !snapshotValid ||
          revealed.some((itemId) => typeof itemId !== "string" || !snapshotIds.has(itemId)) ||
          (row.status === "completed" &&
            (row.current_step !== "complete" || !iso(row.completed_at)))
        )
          throw new Error(`Verify listening session thất bại: ${id}`);
      }
    }
    if (mode === "replace") {
      const count = (table: string) =>
        Number(
          (
            database.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as {
              count: number;
            }
          ).count,
        );
      if (
        count("lessons") !== doc.lessons.length ||
        count("lesson_progress") !== doc.progress.length ||
        count("speaking_progress") !== (doc.speakingProgress?.length ?? 0) ||
        count("speaking_sessions") !== (doc.speakingSessions?.length ?? 0) ||
        count("listening_sessions") !== (doc.listeningSessions?.length ?? 0) ||
        count("listening_item_progress") !== (doc.listeningItemProgress?.length ?? 0)
      )
        throw new Error("Verify số lượng record sau Replace thất bại.");
    }
    const foreignKeyError = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyError) throw new Error("Verify foreign key sau import thất bại.");
    const importId = randomUUID();
    database
      .prepare("INSERT INTO import_receipts VALUES(?,?,?,?,?,?,?,?)")
      .run(
        importId,
        now,
        doc.integrity.checksum,
        mode,
        doc.lessons.length,
        doc.progress.length,
        "success",
        preview.warnings.length,
      );
    database.exec("COMMIT");
    return preview;
  } catch (e) {
    database.exec("ROLLBACK");
    throw e;
  }
}
