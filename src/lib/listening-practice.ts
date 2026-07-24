import { extractPracticeCandidates } from "./speaking-practice";
import type { Lesson } from "../types/lesson";

export const LISTENING_NORMALIZATION_VERSION = 1;
export const LISTENING_STEPS = [
  "first_listen",
  "check_meaning",
  "second_listen",
  "sentence_review",
  "final_relisten",
  "complete",
] as const;
export const COMPREHENSION_LEVELS = [
  "mostly_lost",
  "some_parts",
  "main_idea",
  "most_of_it",
] as const;
export const FINAL_RELISTEN_RATINGS = ["easier", "same", "still_difficult"] as const;
export const LISTENING_RECOGNITION_STATES = ["not_started", "heard", "recognized"] as const;

export type ListeningStep = (typeof LISTENING_STEPS)[number];
export type ComprehensionLevel = (typeof COMPREHENSION_LEVELS)[number];
export type FinalRelistenRating = (typeof FINAL_RELISTEN_RATINGS)[number];
export type ListeningRecognitionState = (typeof LISTENING_RECOGNITION_STATES)[number];
export type ListeningSourceType = "shadowing" | "example" | "sentence_mining" | "vocabulary";

export interface ListeningItem {
  id: string;
  lessonId: string;
  sourceType: ListeningSourceType;
  sourceItemId: string;
  text: string;
  targetPhrase?: string;
  meaning?: string;
  sourceContext?: string;
  speakingPracticeItemId?: string;
}

const comprehensionRank: Record<ComprehensionLevel, number> = {
  mostly_lost: 0,
  some_parts: 1,
  main_idea: 2,
  most_of_it: 3,
};

export function isComprehensionLevel(value: unknown): value is ComprehensionLevel {
  return typeof value === "string" && COMPREHENSION_LEVELS.includes(value as ComprehensionLevel);
}

export function isFinalRelistenRating(value: unknown): value is FinalRelistenRating {
  return typeof value === "string" && FINAL_RELISTEN_RATINGS.includes(value as FinalRelistenRating);
}

export function getComprehensionRank(value: ComprehensionLevel): number {
  return comprehensionRank[value];
}

function normalizeListeningText(value: string): string {
  return value
    .replace(/[_]+/g, " ")
    .replace(/\s*\/\s*/g, ", ")
    .replace(/[\[\]{}*`~]/g, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function hashStable(input: string): string {
  let first = 2166136261;
  let second = 2246822519;
  let third = 3266489917;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
    third = Math.imul(third ^ code, 668265263);
  }
  return [first, second, third]
    .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

export function listeningItemId(
  lessonId: string,
  sourceType: ListeningSourceType,
  sourceItemId: string,
): string {
  return `li-${hashStable(
    `${LISTENING_NORMALIZATION_VERSION}|${lessonId}|${sourceType}|${sourceItemId}`,
  )}`;
}

export function extractListeningItems(lesson: Lesson): ListeningItem[] {
  const speakingBySource = new Map(
    extractPracticeCandidates(lesson).map((item) => [
      `${item.sourceType}|${item.sourceItemId}`,
      item.id,
    ]),
  );
  const raw: Array<{
    sourceType: ListeningSourceType;
    sourceItemId: string;
    text: string;
    targetPhrase?: string;
    meaning?: string;
    sourceContext?: string;
  }> = [
    ...lesson.deepPractice.shadowingPractice.lines.map((item) => ({
      sourceType: "shadowing" as const,
      sourceItemId: item.id,
      text: item.line,
      targetPhrase: item.focus,
      meaning: item.vietnamese,
      sourceContext: "Shadowing practice",
    })),
    ...lesson.exampleSentences.map((item) => ({
      sourceType: "example" as const,
      sourceItemId: item.id,
      text: item.sentence,
      targetPhrase: item.keyPhrase,
      meaning: item.vietnamese,
      sourceContext: "Example sentence",
    })),
    ...lesson.deepPractice.sentenceMining.map((item) => ({
      sourceType: "sentence_mining" as const,
      sourceItemId: item.id,
      text: item.sentence,
      targetPhrase: item.pattern,
      sourceContext: item.whyUseful,
    })),
    ...lesson.vocabulary
      .filter((item) => item.context)
      .map((item) => ({
        sourceType: "vocabulary" as const,
        sourceItemId: item.id,
        text: item.context!,
        targetPhrase: item.word,
        meaning: item.vietnamese,
        sourceContext: item.definition,
      })),
  ];

  return raw.flatMap((item) => {
    const text = normalizeListeningText(item.text);
    if (!text || text.length > 650) return [];
    const sourceKey = `${item.sourceType}|${item.sourceItemId}`;
    return [
      {
        ...item,
        id: listeningItemId(lesson.id, item.sourceType, item.sourceItemId),
        lessonId: lesson.id,
        text,
        targetPhrase: item.targetPhrase ? normalizeListeningText(item.targetPhrase) : undefined,
        speakingPracticeItemId: speakingBySource.get(sourceKey),
      },
    ];
  });
}

export function buildListeningTrack(items: ListeningItem[], maximumLength = 620): string {
  let track = "";
  for (const item of items) {
    const candidate = track ? `${track} ${item.text}` : item.text;
    if (candidate.length > maximumLength) break;
    track = candidate;
    if (track.length >= 280) break;
  }
  return track;
}

export function buildListeningTrackFromTranscript(
  transcript: string | undefined,
  fallbackItems: ListeningItem[],
  maximumLength = 620,
): string {
  const normalized = transcript?.replace(/\s+/g, " ").trim();
  if (!normalized) return buildListeningTrack(fallbackItems, maximumLength);
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  let track = "";
  for (const sentence of sentences) {
    const candidate = track ? `${track} ${sentence}` : sentence;
    if (candidate.length > maximumLength) break;
    track = candidate;
    if (track.length >= 280) break;
  }
  if (track) return track;
  const shortened = normalized.slice(0, maximumLength + 1);
  const lastSpace = shortened.lastIndexOf(" ");
  return shortened.slice(0, lastSpace > 80 ? lastSpace : maximumLength).trim();
}

const nextStep: Partial<Record<ListeningStep, ListeningStep>> = {
  first_listen: "check_meaning",
  check_meaning: "second_listen",
  second_listen: "sentence_review",
  sentence_review: "final_relisten",
  final_relisten: "complete",
};

export function assertListeningTransition(current: ListeningStep, next: ListeningStep): void {
  if (nextStep[current] !== next) {
    throw new Error(`Invalid listening transition: ${current} to ${next}.`);
  }
}

export function mergeNonDecreasingCounter(current: number, incoming: number): number {
  if (!Number.isInteger(current) || current < 0 || !Number.isInteger(incoming) || incoming < 0) {
    throw new Error("Listening counters must be non-negative integers.");
  }
  return Math.max(current, incoming);
}
