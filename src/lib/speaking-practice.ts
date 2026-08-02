import type { Lesson } from "../types/lesson";

export const SPEAKING_NORMALIZATION_VERSION = 1;
export const LADDER_STEPS = ["read", "recall", "keywords", "personalize", "free_speak"] as const;
export type LadderStep = (typeof LADDER_STEPS)[number];
export type SpeakingSource = "shadowing" | "example" | "sentence_mining" | "vocabulary";
export interface PracticeCandidate {
  id: string;
  lessonId: string;
  sourceType: SpeakingSource;
  sourceItemId: string;
  sourceText: string;
  text: string;
  targetPhrase?: string;
}
export interface PracticeTask extends PracticeCandidate {
  steps: LadderStep[];
  recallMask: string;
  keywords: string[];
  personalization: string;
  personalizationQuestion?: string;
}

export function normalizeSpeakingText(value: string): string {
  return value
    .replace(/[_]+/g, " ")
    .replace(/\s*\/\s*/g, ", ")
    .replace(/[\[\]{}*`~]/g, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
const normKey = (v: string) =>
  normalizeSpeakingText(v)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9']+/g, " ")
    .trim();
function stableId(lessonId: string, type: SpeakingSource, itemId: string, text: string) {
  const input = `${SPEAKING_NORMALIZATION_VERSION}|${lessonId}|${type}|${itemId || normKey(text)}`;
  let a = 2166136261,
    b = 2246822519,
    c = 3266489917;
  for (let i = 0; i < input.length; i++) {
    a = Math.imul(a ^ input.charCodeAt(i), 16777619);
    b = Math.imul(b ^ input.charCodeAt(i), 3266489917);
    c = Math.imul(c ^ input.charCodeAt(i), 668265263);
  }
  return `sp-${[a, b, c].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("")}`;
}
function acceptable(text: string) {
  const words = normKey(text).split(" ").filter(Boolean);
  return words.length >= 3 && words.length <= 28 && /[.!?]$/.test(text);
}
export function extractPracticeCandidates(lesson: Lesson): PracticeCandidate[] {
  const raw: Array<readonly [SpeakingSource, string, string, string | undefined]> = [
    ...(lesson.deepPractice?.shadowingPractice.lines ?? []).map(
      (x) => ["shadowing", x.id, x.line, x.focus] as const,
    ),
    ...lesson.exampleSentences.map((x) => ["example", x.id, x.sentence, x.keyPhrase] as const),
    ...(lesson.deepPractice?.sentenceMining ?? []).map(
      (x) => ["sentence_mining", x.id, x.sentence, x.pattern] as const,
    ),
    ...lesson.vocabulary
      .filter((x) => x.context)
      .map((x) => ["vocabulary", x.id, x.context!, x.word] as const),
  ];
  const seen = new Set<string>();
  const out: PracticeCandidate[] = [];
  for (const [sourceType, sourceItemId, sourceText, target] of raw) {
    const text = normalizeSpeakingText(sourceText),
      key = normKey(text);
    if (!acceptable(text) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: stableId(lesson.id, sourceType, sourceItemId, text),
      lessonId: lesson.id,
      sourceType,
      sourceItemId,
      sourceText,
      text,
      targetPhrase: target ? normalizeSpeakingText(target) : undefined,
    });
  }
  return out;
}
const stop = new Set(
  "a an the i you he she it we they am is are was were be been being do does did to of in on at for from with and or but because that this my your our their can could would should will just very really".split(
    " ",
  ),
);
const weakKeyword = new Set("need want thing really just good make".split(" "));
function tokens(text: string) {
  return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
}
export function buildRecallMask(c: PracticeCandidate): string {
  const target = c.targetPhrase?.trim();
  if (target && new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(c.text))
    return c.text.replace(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "______");
  const choices = tokens(c.text).filter((w) => !stop.has(w.toLowerCase()) && w.length > 3);
  const selected = choices
    .filter((_, i) => i % 2 === 0)
    .slice(0, Math.max(1, Math.min(3, Math.floor(tokens(c.text).length / 4))));
  let result = c.text;
  for (const word of selected) result = result.replace(new RegExp(`\\b${word}\\b`, "i"), "______");
  return result;
}
function addChunk(result: string[], value: string | undefined) {
  if (!value) return;
  const chunk = value
    .trim()
    .replace(/^[,;:.!?\s]+|[,;:.!?\s]+$/g, "")
    .replace(/^(?:the|a|an)\s+/i, "");
  if (!chunk || tokens(chunk).length > 5 || weakKeyword.has(chunk.toLowerCase())) return;
  if (
    !result.some(
      (x) =>
        x.toLowerCase() === chunk.toLowerCase() || x.toLowerCase().includes(chunk.toLowerCase()),
    )
  )
    result.push(chunk);
}
export function extractKeywords(c: PracticeCandidate): string[] {
  const text = c.text.replace(/[.!?]+$/g, "");
  const contrast = text.match(
    /\b(stop\s+\w+)(?:\s+on)?\s+(?:the\s+)?(.+?)\s+and\s+((?:start|enjoy|keep|try|focus|practice|use|learn|work|make)\b.+)$/i,
  );
  const result: string[] = [];
  if (contrast) {
    addChunk(result, contrast[1]);
    addChunk(result, contrast[2]);
    addChunk(result, contrast[3]);
  } else {
    const clauses = text.split(/\s+(?:and|but|because|so)\s+|[,;:]/i);
    for (const clause of clauses) {
      const words = tokens(clause);
      const meaningful = words.filter(
        (w) => !stop.has(w.toLowerCase()) && !weakKeyword.has(w.toLowerCase()),
      );
      if (!meaningful.length) continue;
      const first = words.findIndex((w) => w === meaningful[0]);
      addChunk(
        result,
        words.slice(Math.max(0, first - 1), Math.min(words.length, first + 3)).join(" "),
      );
    }
  }
  if (c.targetPhrase) {
    const target = c.targetPhrase.trim();
    const position = text.toLowerCase().indexOf(target.toLowerCase());
    if (position >= 0 && !result.some((x) => x.toLowerCase().includes(target.toLowerCase()))) {
      result.push(target);
      result.sort(
        (a, b) =>
          text.toLowerCase().indexOf(a.toLowerCase()) - text.toLowerCase().indexOf(b.toLowerCase()),
      );
    }
  }
  if (result.length < 2) {
    for (const word of tokens(text))
      if (!stop.has(word.toLowerCase()) && !weakKeyword.has(word.toLowerCase()) && word.length > 3)
        addChunk(result, word);
  }
  return result.slice(0, 4);
}
export function personalizationPrompt(c: PracticeCandidate): {
  pattern: string;
  question?: string;
} {
  const t = c.text.trim().replace(/[.!?]+$/g, "");
  let m;
  if (/^I need to stop focusing on\s+.+?\s+and\s+(?:enjoy|start)\s+.+$/i.test(t))
    return {
      question: "What do you focus on too much, and what should you do instead?",
      pattern: "I need to stop focusing on ______ and start ______.",
    };
  if ((m = t.match(/^Be\s+(.+?)\s+with yourself$/i)))
    return {
      question: `What do you need to be ${m[1].toLowerCase()} with yourself about?`,
      pattern: `I need to be ${m[1].toLowerCase()} with myself about ______.`,
    };
  if (/^I need to\s+.+$/i.test(t))
    return { question: "What do you need to do in your real life?", pattern: "I need to ______." };
  if (/^I want to\s+.+$/i.test(t))
    return {
      question: "What do you want to do, and why?",
      pattern: "I want to ______ because ______.",
    };
  if (/^I keep\s+.+$/i.test(t))
    return {
      question: "What do you keep doing, and why?",
      pattern: "I keep ______ because ______.",
    };
  if (/^I find it hard to\s+.+$/i.test(t))
    return {
      question: "What is hard for you right now, and why?",
      pattern: "I find it hard to ______ because ______.",
    };
  if (/^The reason is\b/i.test(t))
    return { question: "What is the real reason for you?", pattern: "The reason is ______." };
  if (/^I used to\s+.+$/i.test(t))
    return {
      question: "What did you use to do, and what do you do now?",
      pattern: "I used to ______, but now I ______.",
    };
  if (/^I(?:’|')m trying to\s+.+$/i.test(t))
    return {
      question: "What are you trying to do, and how?",
      pattern: "I’m trying to ______ by ______.",
    };
  return { pattern: "Say the same idea using something from your real life." };
}
export function personalizationPattern(c: PracticeCandidate): string {
  return personalizationPrompt(c).pattern;
}
export function personalizationScore(c: PracticeCandidate): number {
  const count = tokens(c.text).length,
    clauses = (c.text.match(/[,;:]|\b(?:although|however|which|while)\b/gi) ?? []).length,
    prompt = personalizationPrompt(c);
  let score =
    (c.targetPhrase ? 5 : 0) +
    (count >= 6 && count <= 18 ? 4 : 0) -
    clauses * 2 +
    (prompt.pattern.startsWith("Say the same") ? -6 : 8);
  if (
    /\b(I|my|me|we|our|because|when|every day|usually|keep|need to|want to|used to|trying to)\b/i.test(
      c.text,
    )
  )
    score += 3;
  if (/\b(catch-22|self-loathing|epistemological|ontological)\b/i.test(c.text)) score -= 8;
  return score;
}
export function buildSpeakingSession(lesson: Lesson): PracticeTask[] {
  const candidates = extractPracticeCandidates(lesson);
  const picked = [
    ...candidates.filter((x) => x.sourceType === "shadowing").slice(0, 2),
    ...candidates.filter((x) => x.sourceType === "example").slice(0, 3),
    ...candidates
      .filter((x) => ["sentence_mining", "vocabulary"].includes(x.sourceType))
      .slice(0, 1),
  ];
  const unique = [...new Map(picked.map((x) => [x.id, x])).values()].slice(0, 7);
  if (unique.length > 1) {
    const best = [...unique].sort((a, b) => personalizationScore(b) - personalizationScore(a))[0],
      index = unique.findIndex((x) => x.id === best.id);
    unique.splice(index, 1);
    unique.push(best);
  }
  return unique.map((c, i) => ({
    ...c,
    steps: i === unique.length - 1 ? [...LADDER_STEPS] : LADDER_STEPS.slice(0, 4),
    recallMask: buildRecallMask(c),
    keywords: extractKeywords(c),
    personalization: personalizationPattern(c),
    personalizationQuestion: personalizationPrompt(c).question,
  }));
}

export function buildSpeakingTasksForIds(
  lesson: Lesson,
  itemIds: readonly string[],
): PracticeTask[] {
  const tasks = buildSpeakingSession(lesson);
  const selected = itemIds
    .map((id) => tasks.find((task) => task.id === id))
    .filter((task): task is PracticeTask => Boolean(task));
  return selected.map((task, index) => ({
    ...task,
    steps: index === selected.length - 1 ? [...LADDER_STEPS] : LADDER_STEPS.slice(0, 4),
  }));
}
