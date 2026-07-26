import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  LISTENING_RECOGNITION_STATES,
  LISTENING_STEPS,
  assertListeningTransition,
  buildListeningTrackFromTranscript,
  extractListeningItems,
  isComprehensionLevel,
  isFinalRelistenRating,
  type ListeningItem,
  type ListeningRecognitionState,
  type ListeningStep,
} from "../../lib/listening-practice";
import type { Lesson } from "../../types/lesson";
import { StorageError } from "../storage/errors";

interface LessonRow {
  id: string;
  title: string;
  summary: string;
  lesson_json: string;
  original_transcript: string | null;
  processed_transcript: string | null;
}

interface SessionRow {
  id: string;
  lesson_id: string;
  status: "active" | "completed" | "cancelled";
  current_step: ListeningStep;
  first_listen_comprehension: string | null;
  first_listen_note: string;
  second_listen_comprehension: string | null;
  final_relisten_rating: string | null;
  final_note: string;
  revealed_item_ids_json: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ItemProgressRow {
  id: string;
  lesson_id: string;
  source_type: string;
  source_item_id: string;
  listen_count: number;
  loop_count: number;
  transcript_revealed: number;
  recognition_status: ListeningRecognitionState;
  difficult: number;
  last_listened_at: string | null;
  updated_at: string;
}

export interface ListeningCommand {
  action: string;
  lessonId?: unknown;
  sessionId?: unknown;
  itemId?: unknown;
  comprehension?: unknown;
  note?: unknown;
  nextStep?: unknown;
  rating?: unknown;
  count?: unknown;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StorageError("VALIDATION_ERROR", message);
  }
  return value;
}

function optionalNote(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 1000) {
    throw new StorageError("VALIDATION_ERROR", "Ghi chú phải có tối đa 1000 ký tự.");
  }
  return value.trim();
}

function mapSession(row: SessionRow) {
  return {
    id: row.id,
    lessonId: row.lesson_id,
    status: row.status,
    currentStep: row.current_step,
    firstListenComprehension: row.first_listen_comprehension,
    firstListenNote: row.first_listen_note,
    secondListenComprehension: row.second_listen_comprehension,
    finalRelistenRating: row.final_relisten_rating,
    finalNote: row.final_note,
    revealedItemIds: JSON.parse(row.revealed_item_ids_json) as string[],
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapProgress(row: ItemProgressRow | undefined) {
  if (!row) {
    return {
      listenCount: 0,
      loopCount: 0,
      transcriptRevealed: false,
      recognitionStatus: "not_started" as const,
      difficult: false,
      lastListenedAt: null,
    };
  }
  return {
    listenCount: row.listen_count,
    loopCount: row.loop_count,
    transcriptRevealed: Boolean(row.transcript_revealed),
    recognitionStatus: row.recognition_status,
    difficult: Boolean(row.difficult),
    lastListenedAt: row.last_listened_at,
  };
}

export class ListeningService {
  constructor(private readonly database: DatabaseSync) {}

  execute(command: ListeningCommand): unknown {
    if (command.action === "dashboard") return this.dashboard();
    const lessonId = requiredString(command.lessonId, "Thiếu lesson ID.");
    switch (command.action) {
      case "status":
        return this.status(lessonId);
      case "start":
        return this.start(lessonId, false);
      case "practice_again":
        return this.start(lessonId, true);
      case "save_first_listen":
        return this.saveFirstListen(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          command.comprehension,
          command.note,
        );
      case "advance_step":
        return this.advanceStep(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          command.nextStep,
        );
      case "save_second_listen":
        return this.saveSecondListen(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          command.comprehension,
        );
      case "reveal_item":
        return this.revealItem(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          requiredString(command.itemId, "Thiếu listening item ID."),
        );
      case "reveal_all":
        return this.revealAll(lessonId, requiredString(command.sessionId, "Thiếu session ID."));
      case "record_listen":
        return this.recordListening(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          requiredString(command.itemId, "Thiếu listening item ID."),
          1,
          0,
        );
      case "record_loop":
        return this.recordLoop(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          requiredString(command.itemId, "Thiếu listening item ID."),
          command.count,
        );
      case "mark_recognized":
        return this.markItem(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          requiredString(command.itemId, "Thiếu listening item ID."),
          "recognized",
        );
      case "mark_difficult":
        return this.markItem(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          requiredString(command.itemId, "Thiếu listening item ID."),
          "difficult",
        );
      case "mark_understood_after_reading":
        return this.markItem(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          requiredString(command.itemId, "Thiếu listening item ID."),
          "understood",
        );
      case "complete":
        return this.complete(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          command.rating,
          command.note,
        );
      default:
        throw new StorageError("VALIDATION_ERROR", "Lệnh listening không được hỗ trợ.");
    }
  }

  status(lessonId: string) {
    const lesson = this.lesson(lessonId);
    const row = this.database
      .prepare(
        `SELECT * FROM listening_sessions
         WHERE lesson_id=?
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
                  updated_at DESC
         LIMIT 1`,
      )
      .get(lessonId) as unknown as SessionRow | undefined;
    return this.response(lesson, row);
  }

  dashboard() {
    const active = this.database
      .prepare(
        `SELECT s.lesson_id,l.title,s.current_step,s.updated_at
         FROM listening_sessions s
         JOIN lessons l ON l.id=s.lesson_id
         WHERE s.status='active' AND l.deleted_at IS NULL
         ORDER BY s.updated_at DESC LIMIT 1`,
      )
      .get() as
      | { lesson_id: string; title: string; current_step: ListeningStep; updated_at: string }
      | undefined;
    const review = this.database
      .prepare(
        `SELECT l.id lesson_id,l.title,MAX(s.completed_at) last_listened,
                COALESCE((SELECT SUM(p.difficult)
                  FROM listening_item_progress p WHERE p.lesson_id=l.id),0) difficult_count
         FROM listening_sessions s
         JOIN lessons l ON l.id=s.lesson_id
         WHERE s.status='completed' AND l.deleted_at IS NULL
         GROUP BY l.id,l.title
         ORDER BY difficult_count DESC,last_listened DESC
         LIMIT 5`,
      )
      .all() as Array<{
      lesson_id: string;
      title: string;
      last_listened: string;
      difficult_count: number;
    }>;
    return {
      active: active
        ? {
            lessonId: active.lesson_id,
            title: active.title,
            currentStep: active.current_step,
            updatedAt: active.updated_at,
          }
        : null,
      review: review.map((item) => ({
        lessonId: item.lesson_id,
        title: item.title,
        lastListenedAt: item.last_listened,
        difficultCount: Number(item.difficult_count),
      })),
    };
  }

  private lesson(id: string): { row: LessonRow; lesson: Lesson; items: ListeningItem[] } {
    const row = this.database
      .prepare(
        `SELECT id,title,summary,lesson_json,original_transcript,processed_transcript
         FROM lessons WHERE id=? AND deleted_at IS NULL`,
      )
      .get(id) as LessonRow | undefined;
    if (!row) throw new StorageError("NOT_FOUND", "Không tìm thấy bài học.");
    const lesson = JSON.parse(row.lesson_json) as Lesson;
    return { row, lesson, items: extractListeningItems(lesson) };
  }

  private response(
    context: { row: LessonRow; lesson: Lesson; items: ListeningItem[] },
    row: SessionRow | undefined,
  ) {
    const progressRows = this.database
      .prepare("SELECT * FROM listening_item_progress WHERE lesson_id=?")
      .all(context.lesson.id) as unknown as ItemProgressRow[];
    const progress = new Map(progressRows.map((item) => [item.id, item]));
    return {
      lessonId: context.lesson.id,
      lessonTitle: context.row.title,
      summary: context.row.summary,
      track: buildListeningTrackFromTranscript(
        context.row.processed_transcript ?? context.row.original_transcript ?? undefined,
        context.items,
      ),
      session: row ? mapSession(row) : null,
      items: context.items.map((item) => ({
        ...item,
        progress: mapProgress(progress.get(item.id)),
      })),
      empty: context.items.length === 0,
    };
  }

  private start(lessonId: string, practiceAgain: boolean) {
    const lesson = this.lesson(lessonId);
    if (!lesson.items.length) return this.response(lesson, undefined);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    let id: string;
    try {
      const active = this.database
        .prepare("SELECT id FROM listening_sessions WHERE lesson_id=? AND status='active'")
        .get(lessonId) as { id: string } | undefined;
      if (active && !practiceAgain) {
        id = active.id;
      } else {
        if (active) {
          this.database
            .prepare(
              "UPDATE listening_sessions SET status='cancelled',updated_at=? WHERE id=? AND status='active'",
            )
            .run(now, active.id);
        }
        id = randomUUID();
        this.database
          .prepare(
            `INSERT INTO listening_sessions(
              id,lesson_id,status,current_step,started_at,updated_at
            ) VALUES(?,?,'active','first_listen',?,?)`,
          )
          .run(id, lessonId, now, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const row = this.database
      .prepare("SELECT * FROM listening_sessions WHERE id=?")
      .get(id) as unknown as SessionRow;
    return this.response(lesson, row);
  }

  private mutableSession(lessonId: string, sessionId: string): SessionRow {
    const row = this.database
      .prepare("SELECT * FROM listening_sessions WHERE id=? AND lesson_id=?")
      .get(sessionId, lessonId) as unknown as SessionRow | undefined;
    if (!row) throw new StorageError("NOT_FOUND", "Không tìm thấy phiên luyện nghe.");
    if (row.status !== "active") {
      throw new StorageError("CONFLICT", "Phiên luyện nghe này đã kết thúc.");
    }
    return row;
  }

  private requireStep(row: SessionRow, allowed: readonly ListeningStep[]) {
    if (!allowed.includes(row.current_step)) {
      throw new StorageError("CONFLICT", "Lệnh này không hợp lệ ở bước luyện nghe hiện tại.");
    }
  }

  private saveFirstListen(
    lessonId: string,
    sessionId: string,
    comprehension: unknown,
    note: unknown,
  ) {
    const lesson = this.lesson(lessonId);
    const row = this.mutableSession(lessonId, sessionId);
    this.requireStep(row, ["first_listen"]);
    if (!isComprehensionLevel(comprehension)) {
      throw new StorageError("VALIDATION_ERROR", "Mức độ hiểu lần nghe đầu không hợp lệ.");
    }
    const firstNote = optionalNote(note);
    assertListeningTransition(row.current_step, "check_meaning");
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE listening_sessions
         SET first_listen_comprehension=?,first_listen_note=?,current_step='check_meaning',updated_at=?
         WHERE id=? AND lesson_id=? AND status='active' AND current_step='first_listen'`,
      )
      .run(comprehension, firstNote, now, sessionId, lessonId);
    return this.statusWithLesson(lesson, sessionId);
  }

  private advanceStep(lessonId: string, sessionId: string, nextStep: unknown) {
    const lesson = this.lesson(lessonId);
    const row = this.mutableSession(lessonId, sessionId);
    if (typeof nextStep !== "string" || !LISTENING_STEPS.includes(nextStep as ListeningStep)) {
      throw new StorageError("VALIDATION_ERROR", "Bước luyện nghe không hợp lệ.");
    }
    const target = nextStep as ListeningStep;
    if (!["check_meaning", "sentence_review"].includes(row.current_step)) {
      throw new StorageError("CONFLICT", "Hãy hoàn thành bước hiện tại trước.");
    }
    try {
      assertListeningTransition(row.current_step, target);
    } catch {
      throw new StorageError("CONFLICT", "Không thể bỏ qua bước luyện nghe.");
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        "UPDATE listening_sessions SET current_step=?,updated_at=? WHERE id=? AND lesson_id=? AND status='active' AND current_step=?",
      )
      .run(target, now, sessionId, lessonId, row.current_step);
    return this.statusWithLesson(lesson, sessionId);
  }

  private saveSecondListen(lessonId: string, sessionId: string, comprehension: unknown) {
    const lesson = this.lesson(lessonId);
    const row = this.mutableSession(lessonId, sessionId);
    this.requireStep(row, ["second_listen"]);
    if (!isComprehensionLevel(comprehension)) {
      throw new StorageError("VALIDATION_ERROR", "Mức độ hiểu lần nghe thứ hai không hợp lệ.");
    }
    assertListeningTransition(row.current_step, "sentence_review");
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE listening_sessions
         SET second_listen_comprehension=?,current_step='sentence_review',updated_at=?
         WHERE id=? AND lesson_id=? AND status='active' AND current_step='second_listen'`,
      )
      .run(comprehension, now, sessionId, lessonId);
    return this.statusWithLesson(lesson, sessionId);
  }

  private listeningItem(lesson: { items: ListeningItem[] }, itemId: string): ListeningItem {
    const item = lesson.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new StorageError("VALIDATION_ERROR", "Câu luyện nghe không thuộc bài học này.");
    }
    return item;
  }

  private revealItem(lessonId: string, sessionId: string, itemId: string) {
    const lesson = this.lesson(lessonId);
    const session = this.mutableSession(lessonId, sessionId);
    this.requireStep(session, ["check_meaning", "sentence_review"]);
    const item = this.listeningItem(lesson, itemId);
    const revealed = new Set(JSON.parse(session.revealed_item_ids_json) as string[]);
    revealed.add(item.id);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "UPDATE listening_sessions SET revealed_item_ids_json=?,updated_at=? WHERE id=? AND status='active'",
        )
        .run(JSON.stringify([...revealed]), now, sessionId);
      this.upsertItem(item, now, {
        transcriptRevealed: true,
        listenDelta: 0,
        loopDelta: 0,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.statusWithLesson(lesson, sessionId);
  }

  private revealAll(lessonId: string, sessionId: string) {
    const lesson = this.lesson(lessonId);
    const session = this.mutableSession(lessonId, sessionId);
    this.requireStep(session, ["check_meaning", "sentence_review"]);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "UPDATE listening_sessions SET revealed_item_ids_json=?,updated_at=? WHERE id=? AND status='active'",
        )
        .run(JSON.stringify(lesson.items.map((item) => item.id)), now, sessionId);
      for (const item of lesson.items) {
        this.upsertItem(item, now, {
          transcriptRevealed: true,
          listenDelta: 0,
          loopDelta: 0,
        });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.statusWithLesson(lesson, sessionId);
  }

  private recordLoop(lessonId: string, sessionId: string, itemId: string, count: unknown) {
    if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 5) {
      throw new StorageError("VALIDATION_ERROR", "Số lượt loop phải từ 1 đến 5.");
    }
    return this.recordListening(lessonId, sessionId, itemId, Number(count), Number(count));
  }

  private recordListening(
    lessonId: string,
    sessionId: string,
    itemId: string,
    listenDelta: number,
    loopDelta: number,
  ) {
    const lesson = this.lesson(lessonId);
    const session = this.mutableSession(lessonId, sessionId);
    this.requireStep(session, ["check_meaning", "sentence_review"]);
    const item = this.listeningItem(lesson, itemId);
    const now = new Date().toISOString();
    this.upsertItem(item, now, { listenDelta, loopDelta, transcriptRevealed: false });
    return this.statusWithLesson(lesson, sessionId);
  }

  private markItem(
    lessonId: string,
    sessionId: string,
    itemId: string,
    mark: "recognized" | "difficult" | "understood",
  ) {
    const lesson = this.lesson(lessonId);
    const session = this.mutableSession(lessonId, sessionId);
    this.requireStep(session, ["check_meaning", "sentence_review"]);
    const item = this.listeningItem(lesson, itemId);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.upsertItem(item, now, {
        listenDelta: 0,
        loopDelta: 0,
        transcriptRevealed: false,
        recognitionStatus: mark === "recognized" ? "recognized" : "heard",
        difficult: mark === "difficult" ? true : undefined,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.statusWithLesson(lesson, sessionId);
  }

  private upsertItem(
    item: ListeningItem,
    now: string,
    update: {
      listenDelta: number;
      loopDelta: number;
      transcriptRevealed: boolean;
      recognitionStatus?: ListeningRecognitionState;
      difficult?: boolean;
    },
  ) {
    const recognition = update.recognitionStatus ?? (update.listenDelta ? "heard" : "not_started");
    if (!LISTENING_RECOGNITION_STATES.includes(recognition)) {
      throw new StorageError("VALIDATION_ERROR", "Trạng thái nhận diện câu không hợp lệ.");
    }
    this.database
      .prepare(
        `INSERT INTO listening_item_progress(
          id,lesson_id,source_type,source_item_id,listen_count,loop_count,
          transcript_revealed,recognition_status,difficult,last_listened_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(lesson_id,id) DO UPDATE SET
          listen_count=listening_item_progress.listen_count+excluded.listen_count,
          loop_count=listening_item_progress.loop_count+excluded.loop_count,
          transcript_revealed=MAX(listening_item_progress.transcript_revealed,excluded.transcript_revealed),
          recognition_status=CASE
            WHEN excluded.recognition_status='recognized' THEN 'recognized'
            WHEN listening_item_progress.recognition_status='not_started' AND excluded.recognition_status='heard' THEN 'heard'
            ELSE listening_item_progress.recognition_status
          END,
          difficult=CASE
            WHEN ? IS NOT NULL THEN excluded.difficult
            ELSE listening_item_progress.difficult
          END,
          last_listened_at=CASE
            WHEN excluded.listen_count>0 THEN excluded.last_listened_at
            ELSE listening_item_progress.last_listened_at
          END,
          updated_at=excluded.updated_at`,
      )
      .run(
        item.id,
        item.lessonId,
        item.sourceType,
        item.sourceItemId,
        update.listenDelta,
        update.loopDelta,
        update.transcriptRevealed ? 1 : 0,
        recognition,
        update.difficult ? 1 : 0,
        update.listenDelta ? now : null,
        now,
        update.difficult === undefined ? null : 1,
      );
  }

  private complete(lessonId: string, sessionId: string, rating: unknown, note: unknown) {
    const lesson = this.lesson(lessonId);
    const row = this.mutableSession(lessonId, sessionId);
    this.requireStep(row, ["final_relisten"]);
    if (!isFinalRelistenRating(rating)) {
      throw new StorageError("VALIDATION_ERROR", "Đánh giá nghe lại cuối không hợp lệ.");
    }
    const finalNote = optionalNote(note);
    assertListeningTransition(row.current_step, "complete");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database
        .prepare(
          `UPDATE listening_sessions
           SET status='completed',current_step='complete',final_relisten_rating=?,
               final_note=?,completed_at=?,updated_at=?
           WHERE id=? AND lesson_id=? AND status='active' AND current_step='final_relisten'`,
        )
        .run(rating, finalNote, now, now, sessionId, lessonId);
      if (Number(result.changes) !== 1) {
        throw new StorageError("CONFLICT", "Không thể hoàn thành phiên luyện nghe.");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.statusWithLesson(lesson, sessionId);
  }

  private statusWithLesson(
    lesson: { row: LessonRow; lesson: Lesson; items: ListeningItem[] },
    sessionId: string,
  ) {
    const row = this.database
      .prepare("SELECT * FROM listening_sessions WHERE id=?")
      .get(sessionId) as unknown as SessionRow;
    return this.response(lesson, row);
  }
}
