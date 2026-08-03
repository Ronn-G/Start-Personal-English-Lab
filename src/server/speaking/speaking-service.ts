import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  buildSpeakingSession,
  buildSpeakingTasksForIds,
  LADDER_STEPS,
  type LadderStep,
  type PracticeTask,
} from "../../lib/speaking-practice";
import {
  normalizeSentenceInput,
  sentenceInputHash,
  validateSentenceInput,
  type SentenceCheckResult,
} from "../../lib/sentence-check";
import type { Lesson } from "../../types/lesson";
import { MAX_STORED_SPEAKING_SESSIONS } from "../storage/domain";
import { StorageError } from "../storage/errors";

const RATINGS = new Set(["hard", "okay", "easy"]);

type SessionStatus = "active" | "completed" | "cancelled";

interface SessionRow {
  id: string;
  lesson_id: string;
  item_ids_json: string;
  drafts_json: string;
  draft_versions_json: string;
  check_versions_json: string;
  checks_json: string;
  revealed_item_ids_json: string;
  current_item_index: number;
  current_step: LadderStep;
  revision: number;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface Binding {
  practiceItemId: string;
  expectedItemIndex: number;
  expectedStep: LadderStep;
  expectedRevision: number;
}

export interface SpeakingCommand {
  action: string;
  lessonId?: unknown;
  sessionId?: unknown;
  sourceType?: unknown;
  sourceItemId?: unknown;
  practiceItemId?: unknown;
  expectedItemIndex?: unknown;
  expectedStep?: unknown;
  expectedRevision?: unknown;
  draft?: unknown;
  clientDraftVersion?: unknown;
  clientCheckVersion?: unknown;
  rating?: unknown;
  step?: unknown;
}

export interface SentenceCheckCommand extends SpeakingCommand {
  sentence?: unknown;
}

export interface PreparedSentenceCheck {
  lessonId: string;
  sessionId: string;
  binding: Binding;
  task: PracticeTask;
  sentence: string;
  inputHash: string;
  clientCheckVersion: number;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StorageError("VALIDATION_ERROR", message);
  }
  return value;
}

function requiredInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new StorageError("VALIDATION_ERROR", message);
  }
  return Number(value);
}

function requiredStep(value: unknown): LadderStep {
  if (typeof value !== "string" || !LADDER_STEPS.includes(value as LadderStep)) {
    throw new StorageError("VALIDATION_ERROR", "Bậc luyện nói không hợp lệ.");
  }
  return value as LadderStep;
}

function binding(command: SpeakingCommand): Binding {
  return {
    practiceItemId: requiredString(command.practiceItemId, "Thiếu practice item ID."),
    expectedItemIndex: requiredInteger(command.expectedItemIndex, "Item index không hợp lệ."),
    expectedStep: requiredStep(command.expectedStep),
    expectedRevision: requiredInteger(command.expectedRevision, "Session revision không hợp lệ."),
  };
}

function parseObject<T>(value: string): Record<string, T> {
  return JSON.parse(value || "{}") as Record<string, T>;
}

export class SpeakingService {
  constructor(private readonly database: DatabaseSync) {}

  execute(command: SpeakingCommand): unknown {
    if (command.action === "daily") return this.daily();
    const lessonId = requiredString(command.lessonId, "Thiếu lesson ID.");
    switch (command.action) {
      case "status":
        return this.status(lessonId);
      case "start":
        return this.start(lessonId);
      case "start_new":
        return this.startNew(lessonId, false);
      case "review":
        return this.startNew(lessonId, true);
      case "practice_item":
        return this.practiceItem(
          lessonId,
          requiredString(command.sourceType, "Thiếu source type."),
          requiredString(command.sourceItemId, "Thiếu source item ID."),
        );
      case "advance":
        return this.advance(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          binding(command),
          command.step,
        );
      case "show_answer":
        return this.showAnswer(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          binding(command),
        );
      case "save_draft":
        return this.saveDraft(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          binding(command),
          command.draft,
          command.clientDraftVersion,
        );
      case "complete_item":
        return this.completeItem(
          lessonId,
          requiredString(command.sessionId, "Thiếu session ID."),
          binding(command),
          command.rating,
        );
      default:
        throw new StorageError("VALIDATION_ERROR", "Lệnh speaking không được hỗ trợ.");
    }
  }

  status(lessonId: string) {
    const lesson = this.lesson(lessonId);
    const row = this.database
      .prepare(
        `SELECT * FROM speaking_sessions
         WHERE lesson_id=?
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
                  updated_at DESC
         LIMIT 1`,
      )
      .get(lessonId) as unknown as SessionRow | undefined;
    return this.response(lesson, row);
  }

  prepareSentenceCheck(command: SentenceCheckCommand): PreparedSentenceCheck {
    const lessonId = requiredString(command.lessonId, "Thiếu lesson ID.");
    const sessionId = requiredString(command.sessionId, "Thiếu session ID.");
    const expected = binding(command);
    const clientCheckVersion = requiredInteger(
      command.clientCheckVersion,
      "Sentence-check version không hợp lệ.",
    );
    const sentence = normalizeSentenceInput(
      requiredString(command.sentence, "Sentence-check request không hợp lệ."),
    );
    const lesson = this.lesson(lessonId);
    const row = this.mutableSession(lessonId, sessionId);
    const task = this.validateBinding(lesson, row, expected, ["personalize"]);
    const error = validateSentenceInput(sentence, task.personalization, task.text);
    if (error) throw new StorageError("VALIDATION_ERROR", error);
    return {
      lessonId,
      sessionId,
      binding: expected,
      task,
      sentence,
      inputHash: sentenceInputHash(sentence),
      clientCheckVersion,
    };
  }

  saveSentenceCheck(prepared: PreparedSentenceCheck, result: SentenceCheckResult) {
    const checkedAt = new Date().toISOString();
    this.transaction(() => {
      const lesson = this.lesson(prepared.lessonId);
      const row = this.mutableSession(prepared.lessonId, prepared.sessionId);
      this.validateBinding(lesson, row, prepared.binding, ["personalize"]);
      if (sentenceInputHash(prepared.sentence) !== prepared.inputHash) {
        throw new StorageError("CONFLICT", "Kết quả kiểm tra câu đã cũ.");
      }
      const checks = parseObject<unknown>(row.checks_json);
      const checkVersions = parseObject<number>(row.check_versions_json);
      const persistedVersion = Number(checkVersions[prepared.binding.practiceItemId] ?? -1);
      if (prepared.clientCheckVersion <= persistedVersion) {
        throw new StorageError("CONFLICT", "Kết quả kiểm tra câu đã cũ.");
      }
      checks[prepared.binding.practiceItemId] = {
        ...result,
        inputHash: prepared.inputHash,
        inputText: prepared.sentence,
        checkedAt,
      };
      checkVersions[prepared.binding.practiceItemId] = prepared.clientCheckVersion;
      const update = this.database
        .prepare(
          `UPDATE speaking_sessions
           SET checks_json=?,check_versions_json=?,updated_at=?
           WHERE id=? AND lesson_id=? AND status='active'
             AND current_item_index=? AND current_step=? AND revision=?`,
        )
        .run(
          JSON.stringify(checks),
          JSON.stringify(checkVersions),
          checkedAt,
          row.id,
          row.lesson_id,
          row.current_item_index,
          row.current_step,
          row.revision,
        );
      this.requireOneChange(update.changes, "Kết quả kiểm tra câu đã cũ.");
    });
    return {
      result: {
        ...result,
        inputHash: prepared.inputHash,
        inputText: prepared.sentence,
        checkedAt,
      },
      state: this.statusForSession(prepared.lessonId, prepared.sessionId),
    };
  }

  private daily() {
    const active = this.database
      .prepare(
        `SELECT s.lesson_id
         FROM speaking_sessions s
         JOIN lessons l ON l.id=s.lesson_id
         WHERE s.status='active' AND l.deleted_at IS NULL
         ORDER BY s.updated_at DESC LIMIT 1`,
      )
      .get() as { lesson_id: string } | undefined;
    if (active) return { lessonId: active.lesson_id, reason: "active" };
    const lessons = this.database
      .prepare("SELECT lesson_json FROM lessons WHERE deleted_at IS NULL ORDER BY updated_at DESC")
      .all() as { lesson_json: string }[];
    const eligible = lessons
      .map((row) => JSON.parse(row.lesson_json) as Lesson)
      .filter((lesson) => buildSpeakingSession(lesson).length > 0);
    if (!eligible.length) return { lessonId: null };
    const eligibleIds = new Set(eligible.map((lesson) => lesson.id));
    const difficult = this.database
      .prepare(
        `SELECT p.lesson_id
         FROM speaking_progress p
         JOIN lessons l ON l.id=p.lesson_id
         WHERE l.deleted_at IS NULL
           AND (p.self_rating='hard' OR p.status='recalled_with_help')
         ORDER BY p.last_practiced_at ASC`,
      )
      .all() as { lesson_id: string }[];
    const hard = difficult.find((row) => eligibleIds.has(row.lesson_id));
    return { lessonId: hard?.lesson_id ?? eligible[0].id, reason: hard ? "difficult" : "recent" };
  }

  private start(lessonId: string) {
    const lesson = this.lesson(lessonId);
    const tasks = buildSpeakingSession(lesson);
    if (!tasks.length) return { empty: true, lessonTitle: lesson.title, tasks: [] };
    const active = this.database
      .prepare("SELECT * FROM speaking_sessions WHERE lesson_id=? AND status='active'")
      .get(lessonId) as unknown as SessionRow | undefined;
    if (active) return this.response(lesson, active);
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      this.assertSessionCapacity();
      this.insertSession(
        sessionId,
        lessonId,
        tasks.map((task) => task.id),
        now,
      );
    });
    return this.statusForSession(lessonId, sessionId);
  }

  private startNew(lessonId: string, review: boolean) {
    const lesson = this.lesson(lessonId);
    const tasks = buildSpeakingSession(lesson);
    let chosen = tasks;
    if (review) {
      const difficult = new Set(
        (
          this.database
            .prepare(
              `SELECT practice_item_id FROM speaking_progress
               WHERE lesson_id=? AND (self_rating='hard' OR status='recalled_with_help')`,
            )
            .all(lessonId) as { practice_item_id: string }[]
        ).map((row) => row.practice_item_id),
      );
      chosen = tasks.filter((task) => difficult.has(task.id));
    }
    if (!chosen.length) chosen = tasks;
    if (!chosen.length) return { empty: true, lessonTitle: lesson.title, tasks: [] };
    return this.replaceActiveSession(lesson, chosen);
  }

  private practiceItem(lessonId: string, sourceType: string, sourceItemId: string) {
    const lesson = this.lesson(lessonId);
    const target = buildSpeakingSession(lesson).find(
      (task) => task.sourceType === sourceType && task.sourceItemId === sourceItemId,
    );
    if (!target) {
      throw new StorageError("VALIDATION_ERROR", "Câu này không đủ điều kiện cho Speaking Ladder.");
    }
    const active = this.database
      .prepare("SELECT * FROM speaking_sessions WHERE lesson_id=? AND status='active'")
      .get(lessonId) as unknown as SessionRow | undefined;
    if (active) {
      const ids = JSON.parse(active.item_ids_json) as string[];
      if (ids.length === 1 && ids[0] === target.id) return this.response(lesson, active);
    }
    return this.replaceActiveSession(lesson, [target]);
  }

  private replaceActiveSession(lesson: Lesson, tasks: PracticeTask[]) {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      this.assertSessionCapacity();
      this.database
        .prepare(
          `UPDATE speaking_sessions
           SET status='cancelled',updated_at=?
           WHERE lesson_id=? AND status='active'`,
        )
        .run(now, lesson.id);
      this.insertSession(
        sessionId,
        lesson.id,
        tasks.map((task) => task.id),
        now,
      );
    });
    return this.statusForSession(lesson.id, sessionId);
  }

  private advance(lessonId: string, sessionId: string, expected: Binding, requestedStep: unknown) {
    this.transaction(() => {
      const lesson = this.lesson(lessonId);
      const row = this.mutableSession(lessonId, sessionId);
      const task = this.validateBinding(lesson, row, expected);
      const currentIndex = task.steps.indexOf(row.current_step);
      const nextStep = task.steps[currentIndex + 1];
      if (!nextStep) {
        throw new StorageError("CONFLICT", "Hãy hoàn thành item ở bước cuối hiện tại.");
      }
      if (requestedStep !== undefined && requiredStep(requestedStep) !== nextStep) {
        throw new StorageError("CONFLICT", "Không thể bỏ qua hoặc quay lại bước luyện nói.");
      }
      const update = this.database
        .prepare(
          `UPDATE speaking_sessions
           SET current_step=?,revision=revision+1,updated_at=?
           WHERE id=? AND lesson_id=? AND status='active'
             AND current_item_index=? AND current_step=? AND revision=?`,
        )
        .run(
          nextStep,
          new Date().toISOString(),
          row.id,
          row.lesson_id,
          row.current_item_index,
          row.current_step,
          row.revision,
        );
      this.requireOneChange(update.changes, "Phiên luyện nói đã thay đổi.");
    });
    return this.statusForSession(lessonId, sessionId);
  }

  private showAnswer(lessonId: string, sessionId: string, expected: Binding) {
    this.transaction(() => {
      const lesson = this.lesson(lessonId);
      const row = this.mutableSession(lessonId, sessionId);
      const task = this.validateBinding(lesson, row, expected, ["recall"]);
      const revealed = new Set(JSON.parse(row.revealed_item_ids_json) as string[]);
      if (revealed.has(task.id)) return;
      revealed.add(task.id);
      const now = new Date().toISOString();
      const update = this.database
        .prepare(
          `UPDATE speaking_sessions
           SET revealed_item_ids_json=?,revision=revision+1,updated_at=?
           WHERE id=? AND lesson_id=? AND status='active'
             AND current_item_index=? AND current_step=? AND revision=?`,
        )
        .run(
          JSON.stringify([...revealed]),
          now,
          row.id,
          row.lesson_id,
          row.current_item_index,
          row.current_step,
          row.revision,
        );
      this.requireOneChange(update.changes, "Phiên luyện nói đã thay đổi.");
      this.database
        .prepare(
          `INSERT INTO speaking_progress(
             lesson_id,practice_item_id,source_type,source_item_id,status,
             attempt_count,help_count,show_answer_count,recalled_count,personalized_count,
             first_practiced_at,last_practiced_at,updated_at
           ) VALUES(?,?,?,?,'practicing',0,1,1,0,0,?,?,?)
           ON CONFLICT(lesson_id,practice_item_id) DO UPDATE SET
             help_count=speaking_progress.help_count+1,
             show_answer_count=speaking_progress.show_answer_count+1,
             last_practiced_at=excluded.last_practiced_at,
             updated_at=excluded.updated_at`,
        )
        .run(lesson.id, task.id, task.sourceType, task.sourceItemId, now, now, now);
    });
    return this.statusForSession(lessonId, sessionId);
  }

  private saveDraft(
    lessonId: string,
    sessionId: string,
    expected: Binding,
    value: unknown,
    clientVersion: unknown,
  ) {
    if (typeof value !== "string" || value.length > 500) {
      throw new StorageError("VALIDATION_ERROR", "Draft phải có tối đa 500 ký tự.");
    }
    const draftVersion = requiredInteger(clientVersion, "Draft version không hợp lệ.");
    this.transaction(() => {
      const lesson = this.lesson(lessonId);
      const row = this.mutableSession(lessonId, sessionId);
      const task = this.validateBinding(lesson, row, expected, ["personalize"]);
      const drafts = parseObject<string>(row.drafts_json);
      const versions = parseObject<number>(row.draft_versions_json);
      const persistedVersion = Number(versions[task.id] ?? -1);
      const draft = value.trim();
      if (draftVersion < persistedVersion) {
        throw new StorageError("CONFLICT", "Draft mới hơn đã được lưu.");
      }
      if (draftVersion === persistedVersion) {
        const persisted = drafts[task.id] ?? "";
        if (persisted === draft) return;
        throw new StorageError("CONFLICT", "Draft version đã được dùng cho nội dung khác.");
      }
      if (draft) drafts[task.id] = draft;
      else delete drafts[task.id];
      versions[task.id] = draftVersion;
      const update = this.database
        .prepare(
          `UPDATE speaking_sessions
           SET drafts_json=?,draft_versions_json=?,revision=revision+1,updated_at=?
           WHERE id=? AND lesson_id=? AND status='active'
             AND current_item_index=? AND current_step=? AND revision=?`,
        )
        .run(
          JSON.stringify(drafts),
          JSON.stringify(versions),
          new Date().toISOString(),
          row.id,
          row.lesson_id,
          row.current_item_index,
          row.current_step,
          row.revision,
        );
      this.requireOneChange(update.changes, "Phiên luyện nói đã thay đổi.");
    });
    return this.statusForSession(lessonId, sessionId);
  }

  private completeItem(
    lessonId: string,
    sessionId: string,
    expected: Binding,
    ratingValue: unknown,
  ) {
    if (typeof ratingValue !== "string" || !RATINGS.has(ratingValue)) {
      throw new StorageError("VALIDATION_ERROR", "Đánh giá không hợp lệ.");
    }
    this.transaction(() => {
      const lesson = this.lesson(lessonId);
      const row = this.mutableSession(lessonId, sessionId);
      const task = this.validateBinding(lesson, row, expected);
      if (row.current_step !== task.steps.at(-1)) {
        throw new StorageError("CONFLICT", "Hãy hoàn thành đúng bước cuối trước khi đánh giá.");
      }
      const ids = JSON.parse(row.item_ids_json) as string[];
      const nextItemIndex = row.current_item_index + 1;
      const completed = nextItemIndex >= ids.length;
      const now = new Date().toISOString();
      const update = completed
        ? this.database
            .prepare(
              `UPDATE speaking_sessions
               SET status='completed',completed_at=?,revision=revision+1,updated_at=?
               WHERE id=? AND lesson_id=? AND status='active'
                 AND current_item_index=? AND current_step=? AND revision=?`,
            )
            .run(
              now,
              now,
              row.id,
              row.lesson_id,
              row.current_item_index,
              row.current_step,
              row.revision,
            )
        : this.database
            .prepare(
              `UPDATE speaking_sessions
               SET current_item_index=?,current_step='read',revision=revision+1,updated_at=?
               WHERE id=? AND lesson_id=? AND status='active'
                 AND current_item_index=? AND current_step=? AND revision=?`,
            )
            .run(
              nextItemIndex,
              now,
              row.id,
              row.lesson_id,
              row.current_item_index,
              row.current_step,
              row.revision,
            );
      this.requireOneChange(update.changes, "Phiên luyện nói đã thay đổi.");
      const helped = (JSON.parse(row.revealed_item_ids_json) as string[]).includes(task.id);
      const rank = helped ? 2 : 4;
      this.database
        .prepare(
          `INSERT INTO speaking_progress(
             lesson_id,practice_item_id,source_type,source_item_id,status,
             attempt_count,help_count,show_answer_count,recalled_count,personalized_count,
             self_rating,first_practiced_at,last_practiced_at,updated_at
           ) VALUES(?,?,?,?,?,1,0,0,1,1,?,?,?,?)
           ON CONFLICT(lesson_id,practice_item_id) DO UPDATE SET
             status=CASE
               WHEN ${rank}>CASE speaking_progress.status
                 WHEN 'new' THEN 0 WHEN 'practicing' THEN 1
                 WHEN 'recalled_with_help' THEN 2 WHEN 'recalled' THEN 3 ELSE 4 END
               THEN excluded.status ELSE speaking_progress.status END,
             attempt_count=speaking_progress.attempt_count+1,
             recalled_count=speaking_progress.recalled_count+1,
             personalized_count=speaking_progress.personalized_count+1,
             self_rating=excluded.self_rating,
             last_practiced_at=excluded.last_practiced_at,
             updated_at=excluded.updated_at`,
        )
        .run(
          lesson.id,
          task.id,
          task.sourceType,
          task.sourceItemId,
          helped ? "recalled_with_help" : "personalized",
          ratingValue,
          now,
          now,
          now,
        );
    });
    return this.statusForSession(lessonId, sessionId);
  }

  private lesson(lessonId: string): Lesson {
    const row = this.database
      .prepare("SELECT lesson_json FROM lessons WHERE id=? AND deleted_at IS NULL")
      .get(lessonId) as { lesson_json: string } | undefined;
    if (!row) throw new StorageError("NOT_FOUND", "Không tìm thấy bài học.");
    return JSON.parse(row.lesson_json) as Lesson;
  }

  private mutableSession(lessonId: string, sessionId: string): SessionRow {
    const row = this.database
      .prepare("SELECT * FROM speaking_sessions WHERE id=? AND lesson_id=?")
      .get(sessionId, lessonId) as unknown as SessionRow | undefined;
    if (!row) throw new StorageError("NOT_FOUND", "Không tìm thấy phiên luyện nói.");
    if (row.status !== "active") {
      throw new StorageError("CONFLICT", "Phiên luyện nói đã kết thúc và không thể thay đổi.");
    }
    return row;
  }

  private validateBinding(
    lesson: Lesson,
    row: SessionRow,
    expected: Binding,
    allowedSteps?: readonly LadderStep[],
  ): PracticeTask {
    const ids = JSON.parse(row.item_ids_json) as string[];
    const tasks = buildSpeakingTasksForIds(lesson, ids);
    const task = tasks[row.current_item_index];
    if (!task || task.id !== ids[row.current_item_index]) {
      throw new StorageError("CONFLICT", "Practice item hiện tại không còn hợp lệ.");
    }
    if (
      row.current_item_index !== expected.expectedItemIndex ||
      task.id !== expected.practiceItemId ||
      row.current_step !== expected.expectedStep ||
      row.revision !== expected.expectedRevision
    ) {
      throw new StorageError(
        "CONFLICT",
        "Phiên luyện nói đã thay đổi. Đã tải lại trạng thái mới nhất.",
      );
    }
    if (allowedSteps && !allowedSteps.includes(row.current_step)) {
      throw new StorageError("CONFLICT", "Lệnh này không hợp lệ ở bước hiện tại.");
    }
    return task;
  }

  private insertSession(sessionId: string, lessonId: string, itemIds: string[], now: string) {
    this.database
      .prepare(
        `INSERT INTO speaking_sessions(
           id,lesson_id,item_ids_json,drafts_json,draft_versions_json,checks_json,check_versions_json,
           revealed_item_ids_json,current_item_index,current_step,revision,status,
           created_at,updated_at,completed_at
         ) VALUES(?,?,?,'{}','{}','{}','{}','[]',0,'read',0,'active',?,?,NULL)`,
      )
      .run(sessionId, lessonId, JSON.stringify(itemIds), now, now);
  }

  private response(lesson: Lesson, row: SessionRow | undefined) {
    const fullTasks = buildSpeakingSession(lesson);
    if (!row) {
      return {
        session: null,
        lessonTitle: lesson.title,
        tasks: fullTasks,
        empty: fullTasks.length === 0,
      };
    }
    const ids = JSON.parse(row.item_ids_json) as string[];
    const tasks = buildSpeakingTasksForIds(lesson, ids);
    const progress = ids.length
      ? (this.database
          .prepare(
            `SELECT * FROM speaking_progress
             WHERE lesson_id=? AND practice_item_id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(lesson.id, ...ids) as Record<string, unknown>[])
      : [];
    const reviewIds = progress
      .filter((item) => item.self_rating === "hard" || item.status === "recalled_with_help")
      .map((item) => String(item.practice_item_id));
    return {
      session: {
        id: row.id,
        lessonId: row.lesson_id,
        itemIds: ids,
        currentItemIndex: row.current_item_index,
        currentStep: row.current_step,
        revision: row.revision,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        drafts: parseObject<string>(row.drafts_json),
        draftVersions: parseObject<number>(row.draft_versions_json),
        checks: parseObject<unknown>(row.checks_json),
        checkVersions: parseObject<number>(row.check_versions_json),
        revealedItemIds: JSON.parse(row.revealed_item_ids_json) as string[],
      },
      lessonTitle: lesson.title,
      tasks,
      summary: {
        practiced: progress.length,
        recalledWithoutHelp: progress.filter(
          (item) =>
            Number(item.show_answer_count) === 0 &&
            ["recalled", "personalized"].includes(String(item.status)),
        ).length,
        neededAnswer: progress.filter((item) => Number(item.show_answer_count) > 0).length,
        personalized: progress.filter((item) => Number(item.personalized_count) > 0).length,
        freeSpeak: row.status === "completed" ? 1 : 0,
        hard: progress.filter((item) => item.self_rating === "hard").length,
        okay: progress.filter((item) => item.self_rating === "okay").length,
        easy: progress.filter((item) => item.self_rating === "easy").length,
        reviewIds,
      },
    };
  }

  private statusForSession(lessonId: string, sessionId: string) {
    const lesson = this.lesson(lessonId);
    const row = this.database
      .prepare("SELECT * FROM speaking_sessions WHERE id=? AND lesson_id=?")
      .get(sessionId, lessonId) as unknown as SessionRow;
    return this.response(lesson, row);
  }

  private assertSessionCapacity() {
    const row = this.database.prepare("SELECT COUNT(*) count FROM speaking_sessions").get() as {
      count: number;
    };
    if (Number(row.count) >= MAX_STORED_SPEAKING_SESSIONS) {
      throw new StorageError(
        "VALIDATION_ERROR",
        `Đã đạt giới hạn ${MAX_STORED_SPEAKING_SESSIONS} phiên luyện nói.`,
      );
    }
  }

  private requireOneChange(changes: number | bigint, message: string) {
    if (Number(changes) !== 1) throw new StorageError("CONFLICT", message);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
