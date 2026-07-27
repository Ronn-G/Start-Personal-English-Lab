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
import { extractPracticeCandidates } from "../../lib/speaking-practice";
import {
  COMPREHENSION_LEVELS,
  FINAL_RELISTEN_RATINGS,
  LISTENING_RECOGNITION_STATES,
  LISTENING_STEPS,
  extractListeningItems,
  listeningItemId,
  type ListeningRecognitionState,
  type ListeningStep,
} from "../../lib/listening-practice";

export const BACKUP_FORMAT = "personal-english-lab";
export const CURRENT_BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 8_000_000;

export interface BackupDocument {
  backupFormat: typeof BACKUP_FORMAT;
  backupVersion: 1;
  exportedAt: string;
  appVersion: string;
  databaseSchemaVersion: number;
  lessonSchemaVersion: number;
  progressSchemaVersion: number;
  lessons: Lesson[];
  progress: LessonProgress[];
  settings: Record<string, never>;
  speakingProgress?: SpeakingProgressBackup[];
  speakingSessions?: SpeakingSessionBackup[];
  listeningSessions?: ListeningSessionBackup[];
  listeningItemProgress?: ListeningItemProgressBackup[];
  integrity: { algorithm: "SHA-256"; checksum: string };
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
  exportedAt?: string;
  appVersion?: string;
  databaseSchemaVersion?: number;
  lessonCount: number;
  progressCount: number;
  validRecords: number;
  invalidRecords: number;
  duplicates: number;
  conflicts: number;
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
  typeof value === "string" && !Number.isNaN(Date.parse(value));
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
  if (document.speakingProgress !== undefined) result.speakingProgress = document.speakingProgress;
  if (document.speakingSessions !== undefined) result.speakingSessions = document.speakingSessions;
  if (document.listeningSessions !== undefined)
    result.listeningSessions = document.listeningSessions;
  if (document.listeningItemProgress !== undefined)
    result.listeningItemProgress = document.listeningItemProgress;
  return result;
}

export function validateBackup(value: unknown): {
  document?: BackupDocument;
  diagnostics: BackupDiagnostic[];
} {
  const d: BackupDiagnostic[] = [];
  if (!record(value))
    return {
      diagnostics: [
        { code: "INVALID_BACKUP", path: "$", message: "Backup phải là một đối tượng JSON." },
      ],
    };
  if (value.backupFormat !== BACKUP_FORMAT)
    d.push({ code: "INVALID_FORMAT", path: "$.backupFormat", message: "Sai định dạng backup." });
  if (value.backupVersion !== CURRENT_BACKUP_VERSION)
    d.push({
      code: "UNSUPPORTED_BACKUP_VERSION",
      path: "$.backupVersion",
      message: `Chỉ hỗ trợ backup version ${CURRENT_BACKUP_VERSION}.`,
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
      d.push({ code: "MISSING_FIELD", path: `$.${key}`, message: `Thiếu trường ${key}.` });
  if (
    !Array.isArray(value.lessons) ||
    !Array.isArray(value.progress) ||
    value.lessons?.length > 500 ||
    value.progress?.length > 500
  )
    d.push({
      code: "INVALID_COLLECTION",
      path: "$",
      message: "Danh sách bài học/tiến độ không hợp lệ hoặc có quá 500 bản ghi.",
    });
  if (value.lessonSchemaVersion !== 1 || value.progressSchemaVersion !== 1)
    d.push({
      code: "UNSUPPORTED_DOCUMENT_VERSION",
      path: "$",
      message: "Schema bài học/tiến độ không được hỗ trợ.",
    });
  const ids = new Set<string>();
  const itemIds = new Map<string, Set<string>>();
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
      }
    });
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
      else {
        const data = result.data!,
          allowed = itemIds.get(data.lessonId)!;
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
    value.listeningSessions !== undefined &&
    (!Array.isArray(value.listeningSessions) || value.listeningSessions.length > 2000)
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
        session.revealedItemIds.some(
          (itemId) =>
            typeof itemId !== "string" ||
            !listeningItems.get(String(session.lessonId))?.has(itemId),
        ) ||
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
    (!Array.isArray(value.listeningItemProgress) || value.listeningItemProgress.length > 5000)
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
    document.integrity.algorithm !== "SHA-256" ||
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

export function exportBackup(
  database: DatabaseSync,
  appVersion: string,
  now = new Date().toISOString(),
): BackupDocument {
  database.exec("BEGIN");
  try {
    const lessons = (
      database
        .prepare("SELECT lesson_json FROM lessons WHERE deleted_at IS NULL ORDER BY id")
        .all() as { lesson_json: string }[]
    ).map((r) => JSON.parse(r.lesson_json) as Lesson);
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
      backupVersion: 1,
      exportedAt: now,
      appVersion,
      databaseSchemaVersion: CURRENT_DATABASE_VERSION,
      lessonSchemaVersion: CURRENT_LESSON_SCHEMA_VERSION,
      progressSchemaVersion: 1,
      lessons,
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
    const validated = validateBackup(document);
    if (!validated.document)
      throw new Error(
        `Dữ liệu SQLite không hợp lệ: ${validated.diagnostics.map((x) => x.message).join("; ")}`,
      );
    database.exec("COMMIT");
    return document;
  } catch (e) {
    database.exec("ROLLBACK");
    throw e;
  }
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
      lessonCount: Array.isArray((value as Record<string, unknown>)?.lessons)
        ? ((value as Record<string, unknown>).lessons as unknown[]).length
        : 0,
      progressCount: 0,
      validRecords: 0,
      invalidRecords: validated.diagnostics.length,
      duplicates: 0,
      conflicts: 0,
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
    newLessons = 0;
  for (const lesson of doc.lessons) {
    const same = current.get(lesson.id);
    if (same) {
      if (contentFingerprint(same) === contentFingerprint(lesson)) duplicates++;
      else {
        conflicts++;
        newLessons++;
      }
    } else if (fingerprints.has(contentFingerprint(lesson))) duplicates++;
    else newLessons++;
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
  return {
    valid: true,
    exportedAt: doc.exportedAt,
    appVersion: doc.appVersion,
    databaseSchemaVersion: doc.databaseSchemaVersion,
    lessonCount: doc.lessons.length,
    progressCount: doc.progress.length,
    validRecords: doc.lessons.length + doc.progress.length,
    invalidRecords: 0,
    duplicates,
    conflicts,
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
  return {
    ...newer,
    status: completed ? "completed" : newer.status,
    currentStep: completed ? "complete" : farther.currentStep,
    revealedItemIds: [...new Set([...current.revealedItemIds, ...incoming.revealedItemIds])],
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
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
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
    const now = new Date().toISOString();
    for (const source of doc.lessons) {
      let id = source.id;
      const same = current.get(id);
      const fp = contentFingerprint(source);
      if (same && contentFingerprint(same) !== fp) id = randomUUID();
      else if (!same && byFingerprint.has(fp)) id = byFingerprint.get(fp)!;
      remap.set(source.id, id);
      if (current.has(id) || database.prepare("SELECT 1 FROM lessons WHERE id=?").get(id)) continue;
      const lesson = { ...source, id };
      database
        .prepare(
          "INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)",
        )
        .run(
          id,
          1,
          lesson.title,
          lesson.summary,
          JSON.stringify(lesson),
          lesson.createdAt,
          lesson.updatedAt,
        );
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
      if (mapped.some((x) => !x)) continue;
      const local = database
        .prepare("SELECT * FROM speaking_sessions WHERE lesson_id=? AND status='active'")
        .get(id) as Record<string, unknown> | undefined;
      if (
        source.status === "active" &&
        local &&
        (Number(local.current_item_index) > source.currentItemIndex ||
          (Number(local.current_item_index) === source.currentItemIndex &&
            Date.parse(String(local.updated_at)) >= Date.parse(source.updatedAt)))
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
          "INSERT INTO speaking_sessions(id,lesson_id,item_ids_json,drafts_json,checks_json,current_item_index,current_step,status,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          id,
          JSON.stringify(mapped),
          JSON.stringify(remapObject(source.drafts)),
          JSON.stringify(remapObject(source.checks)),
          Math.min(source.currentItemIndex, mapped.length - 1),
          source.currentStep,
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
      const oldItems = extractListeningItems(oldLesson);
      const targetItems = extractListeningItems(JSON.parse(targetLessonRow.lesson_json) as Lesson);
      const mappedReveals = source.revealedItemIds.flatMap((oldItemId) => {
        const oldItem = oldItems.find((item) => item.id === oldItemId);
        if (!oldItem) return [];
        const target = targetItems.find(
          (item) =>
            item.sourceType === oldItem.sourceType && item.sourceItemId === oldItem.sourceItemId,
        );
        return target ? [target.id] : [];
      });
      const incoming: ListeningSessionBackup = {
        ...source,
        lessonId: id,
        revealedItemIds: mappedReveals,
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
            revealed_item_ids_json,started_at,updated_at,completed_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            lesson_id=excluded.lesson_id,status=excluded.status,current_step=excluded.current_step,
            first_listen_comprehension=excluded.first_listen_comprehension,
            first_listen_note=excluded.first_listen_note,
            second_listen_comprehension=excluded.second_listen_comprehension,
            final_relisten_rating=excluded.final_relisten_rating,final_note=excluded.final_note,
            revealed_item_ids_json=excluded.revealed_item_ids_json,
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
          merged.startedAt,
          merged.updatedAt,
          merged.completedAt ?? null,
        );
    }
    for (const [oldId, id] of remap) {
      const l = database.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as
        { lesson_json: string } | undefined;
      if (!l || !validateCanonicalLesson(JSON.parse(l.lesson_json)).success)
        throw new Error(`Verify lesson tháº¥t báº¡i: ${oldId}`);
    }
    for (const source of doc.progress) {
      const id = remap.get(source.lessonId)!;
      const row = database
        .prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?")
        .get(id) as { progress_json: string } | undefined;
      const checked = row ? normalizeLessonProgress(JSON.parse(row.progress_json), id) : undefined;
      if (!checked?.success || checked.data?.lessonId !== id)
        throw new Error(`Verify progress tháº¥t báº¡i: ${source.lessonId}`);
    }
    for (const id of new Set(remap.values())) {
      const targetRow = database.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as
        { lesson_json: string } | undefined;
      if (!targetRow) throw new Error(`Verify listening lesson thất bại: ${id}`);
      const validItems = new Map(
        extractListeningItems(JSON.parse(targetRow.lesson_json) as Lesson).map((item) => [
          item.id,
          item,
        ]),
      );
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
