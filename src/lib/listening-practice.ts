import { extractPracticeCandidates } from "./speaking-practice";
import { AUDIO_MAX_TEXT_BYTES, AUDIO_MAX_TEXT_CHARS } from "./audio-domain";
import type { Lesson } from "../types/lesson";

export const LISTENING_NORMALIZATION_VERSION = 1;
export const LISTENING_SELECTION_VERSION = 1;
export const MAX_LISTENING_SESSION_ITEMS = 8;
export const MAX_LISTENING_SNAPSHOT_JSON_CHARS = 40_000;
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

export interface ListeningSessionSnapshot {
  selectedItems: ListeningItem[];
  selectedItemIds: string[];
  track: string;
  trackHash: string;
  lessonContentHash: string;
  selectionVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function hashStable(input: string): string {
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

export function listeningTrackHash(track: string): string {
  return hashStable(`track|${LISTENING_SELECTION_VERSION}|${track}`);
}

export function listeningLessonContentHash(lesson: Lesson): string {
  return hashStable(`lesson|${JSON.stringify(lesson)}`);
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

export function selectSourceDiverseListeningItems<
  Item extends Pick<ListeningItem, "id" | "sourceType">,
>(rankedItems: Item[], limit = 8): Item[] {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const selected: Item[] = [];
  const selectedIds = new Set<string>();
  for (const sourceType of ["shadowing", "example", "sentence_mining", "vocabulary"] as const) {
    const item = rankedItems.find((candidate) => candidate.sourceType === sourceType);
    if (item && selected.length < limit) {
      selected.push(item);
      selectedIds.add(item.id);
    }
  }
  for (const item of rankedItems) {
    if (selected.length >= limit) break;
    if (!selectedIds.has(item.id)) {
      selected.push(item);
      selectedIds.add(item.id);
    }
  }
  return selected;
}

function audioTrackFits(items: ListeningItem[]): boolean {
  const track = items.map((item) => item.text).join(" ");
  return (
    track.length <= AUDIO_MAX_TEXT_CHARS &&
    new TextEncoder().encode(track).byteLength <= AUDIO_MAX_TEXT_BYTES
  );
}

export function selectListeningSessionItems(
  rankedItems: ListeningItem[],
  limit = MAX_LISTENING_SESSION_ITEMS,
): ListeningItem[] {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const ordered = selectSourceDiverseListeningItems(rankedItems, rankedItems.length);
  const selected: ListeningItem[] = [];
  const ids = new Set<string>();
  const identities = new Set<string>();
  const texts = new Set<string>();
  for (const item of ordered) {
    if (selected.length >= Math.min(limit, MAX_LISTENING_SESSION_ITEMS)) break;
    const identity = `${item.sourceType}|${item.sourceItemId}`;
    const normalizedText = item.text.trim().toLocaleLowerCase("en-US");
    if (
      !item.id ||
      !item.sourceItemId ||
      !normalizedText ||
      ids.has(item.id) ||
      identities.has(identity) ||
      texts.has(normalizedText) ||
      !audioTrackFits([...selected, item])
    ) {
      continue;
    }
    selected.push(item);
    ids.add(item.id);
    identities.add(identity);
    texts.add(normalizedText);
  }
  return selected;
}

export function buildListeningTrack(items: ListeningItem[]): string {
  const track = items.map((item) => item.text).join(" ");
  if (
    track.length > AUDIO_MAX_TEXT_CHARS ||
    new TextEncoder().encode(track).byteLength > AUDIO_MAX_TEXT_BYTES
  ) {
    throw new Error("Listening track exceeds the canonical audio limit.");
  }
  return track;
}

export function createListeningSessionSnapshot(lesson: Lesson): ListeningSessionSnapshot {
  const selectedItems = selectListeningSessionItems(extractListeningItems(lesson));
  const track = buildListeningTrack(selectedItems);
  return {
    selectedItems,
    selectedItemIds: selectedItems.map((item) => item.id),
    track,
    trackHash: listeningTrackHash(track),
    lessonContentHash: listeningLessonContentHash(lesson),
    selectionVersion: LISTENING_SELECTION_VERSION,
  };
}

export function isListeningSessionSnapshot(
  value: unknown,
  expectedLessonId?: string,
): value is ListeningSessionSnapshot {
  if (!isRecord(value)) return false;
  const selectedItemIds = value.selectedItemIds;
  const selectedItems = value.selectedItems;
  if (
    value.selectionVersion !== LISTENING_SELECTION_VERSION ||
    !Array.isArray(selectedItemIds) ||
    !Array.isArray(selectedItems) ||
    selectedItems.length < 1 ||
    selectedItems.length > MAX_LISTENING_SESSION_ITEMS ||
    selectedItemIds.length !== selectedItems.length ||
    typeof value.track !== "string" ||
    typeof value.trackHash !== "string" ||
    typeof value.lessonContentHash !== "string" ||
    !/^[0-9a-f]{24}$/.test(value.lessonContentHash) ||
    JSON.stringify(selectedItems).length > MAX_LISTENING_SNAPSHOT_JSON_CHARS
  ) {
    return false;
  }
  const ids = new Set<string>();
  const identities = new Set<string>();
  const texts = new Set<string>();
  for (let index = 0; index < selectedItems.length; index += 1) {
    const item = selectedItems[index];
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      selectedItemIds[index] !== item.id ||
      typeof item.lessonId !== "string" ||
      (expectedLessonId !== undefined && item.lessonId !== expectedLessonId) ||
      !["shadowing", "example", "sentence_mining", "vocabulary"].includes(
        String(item.sourceType),
      ) ||
      typeof item.sourceItemId !== "string" ||
      !item.sourceItemId ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      item.text.length > AUDIO_MAX_TEXT_CHARS ||
      new TextEncoder().encode(item.text).byteLength > AUDIO_MAX_TEXT_BYTES ||
      (["targetPhrase", "meaning", "sourceContext", "speakingPracticeItemId"] as const).some(
        (field) => item[field] !== undefined && typeof item[field] !== "string",
      ) ||
      item.id !==
        listeningItemId(item.lessonId, item.sourceType as ListeningSourceType, item.sourceItemId)
    ) {
      return false;
    }
    const identity = `${item.sourceType}|${item.sourceItemId}`;
    const normalizedText = item.text.toLocaleLowerCase("en-US");
    if (ids.has(item.id) || identities.has(identity) || texts.has(normalizedText)) return false;
    ids.add(item.id);
    identities.add(identity);
    texts.add(normalizedText);
  }
  try {
    return (
      buildListeningTrack(selectedItems as unknown as ListeningItem[]) === value.track &&
      listeningTrackHash(value.track) === value.trackHash
    );
  } catch {
    return false;
  }
}

export function buildListeningTrackFromTranscript(
  transcript: string | undefined,
  fallbackItems: ListeningItem[],
  maximumLength = 620,
): string {
  const normalized = transcript?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    const selected = selectListeningSessionItems(fallbackItems);
    return buildListeningTrack(selected);
  }
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
