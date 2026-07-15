export interface VocabularyItem {
  word: string;
  phonetic?: string;
  definition: string;
  vietnamese: string;
  context?: string;
}

export interface IdiomItem {
  phrase: string;
  meaning: string;
  vietnamese: string;
  note?: string;
}

export interface ExampleSentence {
  sentence: string;
  keyPhrase: string;
  vietnamese: string;
}

export interface QuizQuestion {
  question: string;
  options: [string, string, string, string];
  correctAnswer: 0 | 1 | 2 | 3;
  explanation: string;
}

export interface ShadowingLine {
  line: string;
  focus: string;
  vietnamese: string;
}

export interface SentenceMiningItem {
  sentence: string;
  pattern: string;
  whyUseful: string;
  remixPrompt: string;
}

export interface ReviewPlanItem {
  day: string;
  task: string;
}

export interface AnkiCard {
  front: string;
  back: string;
  hint?: string;
}

export interface DeepPractice {
  shadowingPractice: {
    steps: string[];
    lines: ShadowingLine[];
  };
  sentenceMining: SentenceMiningItem[];
  reviewPlan: ReviewPlanItem[];
  ankiCards: AnkiCard[];
}

export interface Lesson {
  title: string;
  summary: string;
  vocabulary: VocabularyItem[];
  idiomsAndSlang: IdiomItem[];
  exampleSentences: ExampleSentence[];
  quiz: QuizQuestion[];
  deepPractice?: DeepPractice;
}

export interface GenerateLessonResponse {
  lesson: Lesson;
  videoId?: string;
}

export interface PracticeFeedback {
  score: number;
  overall: string;
  strengths: string[];
  corrections: string[];
  improvedVersion: string;
  nextStep: string;
}

export interface PracticeFeedbackResponse {
  feedback: PracticeFeedback;
}
