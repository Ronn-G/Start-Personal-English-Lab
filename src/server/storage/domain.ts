import type { Lesson } from "../../types/lesson";

export const LESSON_SCHEMA_VERSION = 1;
export const PROGRESS_SCHEMA_VERSION = 1;

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

export interface LessonProgressPayload {
  answeredQuestions?: number[];
  reviewedVocabularyIds?: string[];
  quizScore?: number;
  visitedTabs?: string[];
  practiceFeedback?: unknown[];
  [key: string]: unknown;
}

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
  listLessons(): Promise<StoredLesson[]>;
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
}

export interface ApplicationSettingsRepository {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

export interface StorageRepository
  extends LessonRepository,
    ProgressRepository,
    ApplicationSettingsRepository {}
