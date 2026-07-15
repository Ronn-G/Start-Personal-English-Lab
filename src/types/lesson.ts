export const CURRENT_LESSON_SCHEMA_VERSION = 1;

export interface VocabularyItem { id: string; word: string; phonetic?: string; definition: string; vietnamese: string; context?: string }
export interface IdiomItem { id: string; phrase: string; meaning: string; vietnamese: string; note?: string }
export interface ExampleSentence { id: string; sentence: string; keyPhrase: string; vietnamese: string }
export interface QuizQuestion { id: string; question: string; options: [string, string, string, string]; correctAnswer: 0 | 1 | 2 | 3; explanation: string }
export interface ShadowingLine { id: string; line: string; focus: string; vietnamese: string }
export interface SentenceMiningItem { id: string; sentence: string; pattern: string; whyUseful: string; remixPrompt: string }
export interface ReviewPlanItem { day: string; task: string }
export interface AnkiCard { id: string; front: string; back: string; hint?: string }
export interface DeepPractice {
  shadowingPractice: { steps: string[]; lines: ShadowingLine[] };
  sentenceMining: SentenceMiningItem[];
  reviewPlan: ReviewPlanItem[];
  ankiCards: AnkiCard[];
}
export interface Lesson {
  id: string;
  schemaVersion: typeof CURRENT_LESSON_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  title: string;
  summary: string;
  vocabulary: VocabularyItem[];
  idiomsAndSlang: IdiomItem[];
  exampleSentences: ExampleSentence[];
  quiz: QuizQuestion[];
  deepPractice: DeepPractice;
}
export interface GenerateLessonResponse { lesson: Lesson; videoId?: string }
export interface PracticeFeedback { score: number; overall: string; strengths: string[]; corrections: string[]; improvedVersion: string; nextStep: string }
export interface PracticeFeedbackResponse { feedback: PracticeFeedback }
