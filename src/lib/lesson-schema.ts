import { CURRENT_LESSON_SCHEMA_VERSION, type Lesson } from "../types/lesson";

export type DiagnosticSeverity = "error" | "warning";
export interface Diagnostic { code: string; path: string; message: string; severity: DiagnosticSeverity }
export interface ParseResult<T> { success: boolean; data?: T; diagnostics: Diagnostic[] }
export interface NormalizeOptions { id?: string; createdAt?: string; updatedAt?: string; generateId?: () => string }

const LEGACY_TIMESTAMP_FALLBACK = "1970-01-01T00:00:00.000Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const iso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const diagnostic = (code: string, path: string, message: string, severity: DiagnosticSeverity = "error"): Diagnostic => ({ code, path, message, severity });

export function stripJsonFences(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (match?.[1] ?? trimmed).trim();
}

function defaultId(): string {
  return globalThis.crypto.randomUUID();
}

function validateStringFields(value: Record<string, unknown>, path: string, fields: readonly string[], diagnostics: Diagnostic[]) {
  for (const field of fields) if (!text(value[field])) diagnostics.push(diagnostic("INVALID_FIELD", `${path}.${field}`, `${field} phải là chuỗi không rỗng.`));
}

export function validateCanonicalLesson(value: unknown): ParseResult<Lesson> {
  const diagnostics: Diagnostic[] = [];
  if (!record(value)) return { success: false, diagnostics: [diagnostic("INVALID_TYPE", "$", "Lesson phải là JSON object.")] };
  if (value.schemaVersion !== CURRENT_LESSON_SCHEMA_VERSION) diagnostics.push(diagnostic("UNSUPPORTED_SCHEMA_VERSION", "$.schemaVersion", `Chỉ hỗ trợ Lesson schema version ${CURRENT_LESSON_SCHEMA_VERSION}.`));
  if (!UUID.test(String(value.id ?? ""))) diagnostics.push(diagnostic("INVALID_ID", "$.id", "Lesson ID phải là UUID hợp lệ."));
  if (!iso(value.createdAt)) diagnostics.push(diagnostic("INVALID_TIMESTAMP", "$.createdAt", "createdAt không hợp lệ."));
  if (!iso(value.updatedAt)) diagnostics.push(diagnostic("INVALID_TIMESTAMP", "$.updatedAt", "updatedAt không hợp lệ."));
  validateStringFields(value, "$", ["title", "summary"], diagnostics);
  const specs = [
    ["vocabulary", 20, ["id", "word", "definition", "vietnamese"]],
    ["idiomsAndSlang", null, ["id", "phrase", "meaning", "vietnamese"]],
    ["exampleSentences", 5, ["id", "sentence", "keyPhrase", "vietnamese"]],
    ["quiz", 5, ["id", "question", "explanation"]],
  ] as const;
  const ids = new Set<string>();
  const checkItems = (items: unknown, path: string, expected: number | null, fields: readonly string[]) => {
    if (!Array.isArray(items)) { diagnostics.push(diagnostic("INVALID_TYPE", path, `${path} phải là array.`)); return; }
    if (expected !== null && items.length !== expected) diagnostics.push(diagnostic("INVALID_COUNT", path, `${path} phải có ${expected} phần tử.`));
    items.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (!record(item)) { diagnostics.push(diagnostic("INVALID_TYPE", itemPath, "Item phải là object.")); return; }
      validateStringFields(item, itemPath, fields, diagnostics);
      const id = item.id;
      if (!text(id) || !UUID.test(id)) diagnostics.push(diagnostic("INVALID_ID", `${itemPath}.id`, "Item ID phải là UUID hợp lệ."));
      else if (ids.has(id)) diagnostics.push(diagnostic("DUPLICATE_ID", `${itemPath}.id`, "Item ID bị trùng trong lesson.")); else ids.add(id);
    });
  };
  for (const [field, count, fields] of specs) checkItems(value[field], `$.${field}`, count, fields);
  if (Array.isArray(value.quiz)) value.quiz.forEach((q, i) => { if (record(q) && (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some((o) => !text(o)))) diagnostics.push(diagnostic("INVALID_OPTIONS", `$.quiz[${i}].options`, "Quiz phải có 4 lựa chọn.")); if (record(q) && ![0,1,2,3].includes(Number(q.correctAnswer))) diagnostics.push(diagnostic("INVALID_ENUM", `$.quiz[${i}].correctAnswer`, "correctAnswer phải từ 0 đến 3.")); });
  const deep = value.deepPractice;
  if (!record(deep)) diagnostics.push(diagnostic("INVALID_TYPE", "$.deepPractice", "deepPractice phải là object."));
  else {
    const shadow = deep.shadowingPractice;
    if (!record(shadow) || !Array.isArray(shadow.steps) || shadow.steps.length !== 3 || shadow.steps.some((s) => !text(s))) diagnostics.push(diagnostic("INVALID_COUNT", "$.deepPractice.shadowingPractice.steps", "Shadowing phải có 3 bước."));
    checkItems(record(shadow) ? shadow.lines : undefined, "$.deepPractice.shadowingPractice.lines", 3, ["id", "line", "focus", "vietnamese"]);
    checkItems(deep.sentenceMining, "$.deepPractice.sentenceMining", 3, ["id", "sentence", "pattern", "whyUseful", "remixPrompt"]);
    checkItems(deep.ankiCards, "$.deepPractice.ankiCards", 5, ["id", "front", "back"]);
    if (!Array.isArray(deep.reviewPlan) || deep.reviewPlan.length !== 4) diagnostics.push(diagnostic("INVALID_COUNT", "$.deepPractice.reviewPlan", "Review plan phải có 4 mục."));
    else deep.reviewPlan.forEach((item, i) => { if (!record(item)) diagnostics.push(diagnostic("INVALID_TYPE", `$.deepPractice.reviewPlan[${i}]`, "Review item phải là object.")); else validateStringFields(item, `$.deepPractice.reviewPlan[${i}]`, ["day", "task"], diagnostics); });
  }
  return { success: diagnostics.every((d) => d.severity !== "error"), data: diagnostics.some((d) => d.severity === "error") ? undefined : value as unknown as Lesson, diagnostics };
}

export function normalizeLesson(value: unknown, options: NormalizeOptions = {}): ParseResult<Lesson> {
  if (!record(value)) return { success: false, diagnostics: [diagnostic("INVALID_TYPE", "$", "Lesson phải là JSON object.")] };
  if (value.schemaVersion !== undefined && value.schemaVersion !== 0 && value.schemaVersion !== CURRENT_LESSON_SCHEMA_VERSION) return { success: false, diagnostics: [diagnostic("UNSUPPORTED_SCHEMA_VERSION", "$.schemaVersion", `Không hỗ trợ Lesson schema version ${String(value.schemaVersion)}.`)] };
  const generate = options.generateId ?? defaultId;
  const copy = structuredClone(value) as Record<string, unknown>;
  const warnings: Diagnostic[] = [];
  const used = new Set<string>();
  const assign = (target: Record<string, unknown>, path: string) => {
    const current = target.id;
    if (text(current) && UUID.test(current) && !used.has(current)) { used.add(current); return; }
    const replacement = generate(); target.id = replacement; used.add(replacement);
    warnings.push(diagnostic(text(current) ? "REPAIRED_ITEM_ID" : "ASSIGNED_ITEM_ID", `${path}.id`, text(current) ? "Đã thay item ID không hợp lệ hoặc bị trùng." : "Đã gán stable ID cho item legacy.", "warning"));
  };
  const lessonId = text(copy.id) && UUID.test(copy.id) ? copy.id : options.id ?? generate();
  const createdAt = iso(copy.createdAt) ? copy.createdAt : iso(options.createdAt) ? options.createdAt : LEGACY_TIMESTAMP_FALLBACK;
  const updatedAt = iso(copy.updatedAt) ? copy.updatedAt : iso(options.updatedAt) ? options.updatedAt : createdAt;
  copy.id = lessonId; copy.schemaVersion = CURRENT_LESSON_SCHEMA_VERSION; copy.createdAt = createdAt; copy.updatedAt = updatedAt;
  for (const field of ["vocabulary", "idiomsAndSlang", "exampleSentences", "quiz"] as const) if (Array.isArray(copy[field])) copy[field].forEach((item, i) => { if (record(item)) assign(item, `$.${field}[${i}]`); });
  if (record(copy.deepPractice)) {
    const deep = copy.deepPractice;
    if (record(deep.shadowingPractice) && Array.isArray(deep.shadowingPractice.lines)) deep.shadowingPractice.lines.forEach((item, i) => { if (record(item)) assign(item, `$.deepPractice.shadowingPractice.lines[${i}]`); });
    for (const field of ["sentenceMining", "ankiCards"] as const) if (Array.isArray(deep[field])) deep[field].forEach((item, i) => { if (record(item)) assign(item, `$.deepPractice.${field}[${i}]`); });
  }
  const checked = validateCanonicalLesson(copy);
  return { success: checked.success, data: checked.data, diagnostics: [...warnings, ...checked.diagnostics] };
}

export function parseLessonText(raw: string, options: NormalizeOptions = {}): ParseResult<Lesson> {
  let parsed: unknown;
  try { parsed = JSON.parse(stripJsonFences(raw)); }
  catch { return { success: false, diagnostics: [diagnostic("MALFORMED_JSON", "$", "JSON không hợp lệ. Hãy kiểm tra dấu ngoặc, dấu phẩy và dấu ngoặc kép.")] }; }
  return normalizeLesson(parsed, options);
}

export function formatLessonDiagnostics(result: ParseResult<unknown>): string {
  return result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.path}: ${d.message}`).join("\n") || "Dữ liệu lesson không hợp lệ.";
}
