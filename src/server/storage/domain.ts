import { CURRENT_LESSON_SCHEMA_VERSION, type Lesson } from "../../types/lesson";
import {
  CURRENT_PROGRESS_SCHEMA_VERSION,
  type LessonProgress,
  type LessonProgressCommand,
} from "../../lib/lesson-progress";

export const LESSON_SCHEMA_VERSION = CURRENT_LESSON_SCHEMA_VERSION;
export const PROGRESS_SCHEMA_VERSION = CURRENT_PROGRESS_SCHEMA_VERSION;
export const MAX_STORED_LESSONS = 500;
export const MAX_STORED_SPEAKING_SESSIONS = 2_000;
export const MAX_STORED_LISTENING_SESSIONS = 2_000;

export interface LessonSource {
  title?: string;
  url?: string;
  channel?: string;
  originalTranscript?: string;
  processedTranscript?: string;
  wasTruncated?: boolean;
}

export interface StoredLesson {
  id: string;
  schemaVersion: number;
  title: string;
  summary: string;
  lessonDepth?: string;
  lesson: Lesson;
  createdAt: string;
  updatedAt: string;
  source: LessonSource;
  deletedAt?: string;
}

export interface LessonSummary {
  id: string;
  schemaVersion: number;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export type LessonProgressPayload = LessonProgress;

export interface StoredLessonProgress {
  lessonId: string;
  progressVersion: number;
  progress: LessonProgressPayload;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLessonInput {
  id?: string;
  schemaVersion?: number;
  lessonDepth?: string;
  lesson: Lesson;
  source?: LessonSource;
  initialProgress?: LessonProgressPayload;
}

export interface UpdateLessonInput {
  schemaVersion?: number;
  lessonDepth?: string | null;
  lesson?: Lesson;
  source?: LessonSource;
}

export interface LessonRepository {
  listLessons(): Promise<LessonSummary[]>;
  getLesson(id: string): Promise<StoredLesson | null>;
  createLesson(input: CreateLessonInput): Promise<StoredLesson>;
  updateLesson(id: string, input: UpdateLessonInput): Promise<StoredLesson>;
  deleteLesson(id: string): Promise<void>;
}

export interface ProgressRepository {
  getLessonProgress(lessonId: string): Promise<StoredLessonProgress | null>;
  saveLessonProgress(
    lessonId: string,
    progress: LessonProgressPayload,
    progressVersion?: number,
  ): Promise<StoredLessonProgress>;
  updateLessonProgress(
    lessonId: string,
    command: LessonProgressCommand,
  ): Promise<StoredLessonProgress>;
}

export interface ApplicationSettingsRepository {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

export interface StorageRepository
  extends LessonRepository, ProgressRepository, ApplicationSettingsRepository {}
