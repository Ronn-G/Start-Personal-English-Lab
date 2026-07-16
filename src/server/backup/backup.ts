import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validateCanonicalLesson } from "../../lib/lesson-schema";
import { validateLessonProgress, type LessonProgress } from "../../lib/lesson-progress";
import type { Lesson } from "../../types/lesson";
import { CURRENT_LESSON_SCHEMA_VERSION } from "../../types/lesson";
import { CURRENT_DATABASE_VERSION } from "../storage/migrations";

export const BACKUP_FORMAT = "personal-english-lab";
export const CURRENT_BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 8_000_000;

export interface BackupDocument {
  backupFormat: typeof BACKUP_FORMAT; backupVersion: 1; exportedAt: string; appVersion: string;
  databaseSchemaVersion: number; lessonSchemaVersion: number; progressSchemaVersion: number;
  lessons: Lesson[]; progress: LessonProgress[]; settings: Record<string, never>;
  integrity: { algorithm: "SHA-256"; checksum: string };
}
export interface BackupDiagnostic { code: string; path: string; message: string }
export interface ImportPreview {
  valid: boolean; exportedAt?: string; appVersion?: string; databaseSchemaVersion?: number;
  lessonCount: number; progressCount: number; validRecords: number; invalidRecords: number;
  duplicates: number; conflicts: number; newLessons: number; updatedLessons: number;
  previouslyImported: boolean; warnings: string[]; diagnostics: BackupDiagnostic[]; fingerprint?: string;
}
type BareBackup = Omit<BackupDocument, "integrity">;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function checksum(payload: BareBackup): string { return createHash("sha256").update(stable(payload), "utf8").digest("hex"); }
export function contentFingerprint(lesson: Lesson): string {
  const copy = structuredClone(lesson) as unknown as Record<string, unknown>;
  delete copy.id; delete copy.createdAt; delete copy.updatedAt;
  return createHash("sha256").update(stable(copy)).digest("hex");
}
function bare(document: BackupDocument): BareBackup { return { backupFormat:document.backupFormat,backupVersion:document.backupVersion,exportedAt:document.exportedAt,appVersion:document.appVersion,databaseSchemaVersion:document.databaseSchemaVersion,lessonSchemaVersion:document.lessonSchemaVersion,progressSchemaVersion:document.progressSchemaVersion,lessons:document.lessons,progress:document.progress,settings:document.settings }; }

export function validateBackup(value: unknown): { document?: BackupDocument; diagnostics: BackupDiagnostic[] } {
  const d: BackupDiagnostic[] = [];
  if (!record(value)) return { diagnostics: [{ code: "INVALID_BACKUP", path: "$", message: "Backup phải là JSON object." }] };
  if (value.backupFormat !== BACKUP_FORMAT) d.push({ code: "INVALID_FORMAT", path: "$.backupFormat", message: "Sai định dạng backup." });
  if (value.backupVersion !== CURRENT_BACKUP_VERSION) d.push({ code: "UNSUPPORTED_BACKUP_VERSION", path: "$.backupVersion", message: `Chỉ hỗ trợ backup version ${CURRENT_BACKUP_VERSION}.` });
  for (const key of ["exportedAt","appVersion","databaseSchemaVersion","lessonSchemaVersion","progressSchemaVersion","lessons","progress","settings","integrity"]) if (!(key in value)) d.push({ code: "MISSING_FIELD", path: `$.${key}`, message: `Thiếu field ${key}.` });
  if (!Array.isArray(value.lessons) || !Array.isArray(value.progress) || value.lessons?.length > 500 || value.progress?.length > 500) d.push({ code: "INVALID_COLLECTION", path: "$", message: "Danh sách lesson/progress không hợp lệ hoặc quá 500 record." });
  if (value.lessonSchemaVersion !== 1 || value.progressSchemaVersion !== 1) d.push({ code: "UNSUPPORTED_DOCUMENT_VERSION", path: "$", message: "Schema lesson/progress không được hỗ trợ." });
  const ids = new Set<string>(); const itemIds = new Map<string, Set<string>>();
  if (Array.isArray(value.lessons)) value.lessons.forEach((lesson, i) => {
    const result = validateCanonicalLesson(lesson);
    if (!result.success) d.push({ code: "INVALID_LESSON", path: `$.lessons[${i}]`, message: result.diagnostics.map(x=>x.message).join("; ") });
    else if (ids.has((lesson as Lesson).id)) d.push({ code: "DUPLICATE_LESSON_ID", path: `$.lessons[${i}].id`, message: "Lesson ID bị trùng trong backup." });
    else { const data=lesson as Lesson; ids.add(data.id); itemIds.set(data.id,new Set([...data.vocabulary,...data.idiomsAndSlang,...data.exampleSentences,...data.quiz,...data.deepPractice.shadowingPractice.lines,...data.deepPractice.sentenceMining,...data.deepPractice.ankiCards].map(x=>x.id))); }
  });
  if (Array.isArray(value.progress)) value.progress.forEach((progress, i) => {
    const result = validateLessonProgress(progress);
    if (!result.success) d.push({ code: "INVALID_PROGRESS", path: `$.progress[${i}]`, message: result.diagnostics.map(x=>x.message).join("; ") });
    else if (!ids.has((progress as LessonProgress).lessonId)) d.push({ code: "ORPHAN_PROGRESS", path: `$.progress[${i}].lessonId`, message: "Progress không có lesson tương ứng." });
    else { const data=progress as LessonProgress, allowed=itemIds.get(data.lessonId)!; const bad=[...Object.keys(data.quizItems),...Object.keys(data.learningItems)].find(id=>!allowed.has(id)); if(bad)d.push({code:"ITEM_ID_MISMATCH",path:`$.progress[${i}]`,message:`Progress tham chiếu item ID không thuộc lesson: ${bad}.`}); }
  });
  if (d.length) return { diagnostics: d };
  const document = value as unknown as BackupDocument;
  if (!record(document.integrity) || document.integrity.algorithm !== "SHA-256" || document.integrity.checksum !== checksum(bare(document))) d.push({ code: "CHECKSUM_MISMATCH", path: "$.integrity.checksum", message: "Checksum không khớp; file có thể đã hỏng hoặc bị sửa." });
  return d.length ? { diagnostics: d } : { document, diagnostics: [] };
}

export function exportBackup(database: DatabaseSync, appVersion: string, now = new Date().toISOString()): BackupDocument {
  database.exec("BEGIN");
  try {
    const lessons = (database.prepare("SELECT lesson_json FROM lessons WHERE deleted_at IS NULL ORDER BY id").all() as {lesson_json:string}[]).map(r=>JSON.parse(r.lesson_json) as Lesson);
    const progress = (database.prepare("SELECT p.progress_json FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.deleted_at IS NULL ORDER BY p.lesson_id").all() as {progress_json:string}[]).map(r=>JSON.parse(r.progress_json) as LessonProgress);
    const payload: BareBackup = { backupFormat: BACKUP_FORMAT, backupVersion: 1, exportedAt: now, appVersion, databaseSchemaVersion: CURRENT_DATABASE_VERSION, lessonSchemaVersion: CURRENT_LESSON_SCHEMA_VERSION, progressSchemaVersion: 1, lessons, progress, settings: {} };
    const document: BackupDocument = { ...payload, integrity: { algorithm: "SHA-256", checksum: checksum(payload) } };
    const validated = validateBackup(document); if (!validated.document) throw new Error(`Dữ liệu SQLite không hợp lệ: ${validated.diagnostics.map(x=>x.message).join("; ")}`);
    database.exec("COMMIT"); return document;
  } catch (e) { database.exec("ROLLBACK"); throw e; }
}

function existing(database: DatabaseSync): Map<string, Lesson> { return new Map((database.prepare("SELECT id,lesson_json FROM lessons WHERE deleted_at IS NULL").all() as {id:string;lesson_json:string}[]).map(r=>[r.id,JSON.parse(r.lesson_json) as Lesson])); }
export function previewImport(database: DatabaseSync, value: unknown): ImportPreview {
  const validated=validateBackup(value); const doc=validated.document;
  if (!doc) return { valid:false,lessonCount:Array.isArray((value as Record<string,unknown>)?.lessons)?((value as Record<string,unknown>).lessons as unknown[]).length:0,progressCount:0,validRecords:0,invalidRecords:validated.diagnostics.length,duplicates:0,conflicts:0,newLessons:0,updatedLessons:0,previouslyImported:false,warnings:[],diagnostics:validated.diagnostics };
  const current=existing(database); const fingerprints=new Map([...current.values()].map(l=>[contentFingerprint(l),l.id])); let duplicates=0,conflicts=0,newLessons=0;
  for(const lesson of doc.lessons){ const same=current.get(lesson.id); if(same){ if(contentFingerprint(same)===contentFingerprint(lesson)) duplicates++; else {conflicts++;newLessons++;} } else if(fingerprints.has(contentFingerprint(lesson))) duplicates++; else newLessons++; }
  const fingerprint=doc.integrity.checksum; const prior=Boolean(database.prepare("SELECT 1 FROM import_receipts WHERE source_fingerprint=? AND result='success'").get(fingerprint));
  const warnings:string[]=[]; if(conflicts) warnings.push(`${conflicts} xung đột ID sẽ được giữ cả hai bằng ID mới khi Merge.`); if(prior) warnings.push("Backup này đã từng được import; hãy xác nhận nếu muốn tiếp tục.");
  return {valid:true,exportedAt:doc.exportedAt,appVersion:doc.appVersion,databaseSchemaVersion:doc.databaseSchemaVersion,lessonCount:doc.lessons.length,progressCount:doc.progress.length,validRecords:doc.lessons.length+doc.progress.length,invalidRecords:0,duplicates,conflicts,newLessons,updatedLessons:duplicates,previouslyImported:prior,warnings,diagnostics:[],fingerprint};
}

export function mergeProgress(a: LessonProgress | undefined, b: LessonProgress): LessonProgress {
  if(!a) return b; const newer=Date.parse(b.updatedAt)>=Date.parse(a.updatedAt)?b:a; const older=newer===b?a:b;
  const quizItems={...older.quizItems,...newer.quizItems}; for(const id of new Set([...Object.keys(a.quizItems),...Object.keys(b.quizItems)])){const x=a.quizItems[id],y=b.quizItems[id];if(x&&y)quizItems[id]={...(Date.parse(y.answeredAt)>=Date.parse(x.answeredAt)?y:x),attemptCount:Math.max(x.attemptCount,y.attemptCount),completed:x.completed||y.completed};}
  return {...newer,quizItems,learningItems:{...older.learningItems,...newer.learningItems},visitedSections:[...new Set([...a.visitedSections,...b.visitedSections])],practiceHistory:[...new Map([...a.practiceHistory,...b.practiceHistory].map(x=>[x.id,x])).values()],createdAt:Date.parse(a.createdAt)<Date.parse(b.createdAt)?a.createdAt:b.createdAt};
}

export function importBackup(database: DatabaseSync, value: unknown, mode: "merge"|"replace", allowRepeat=false): ImportPreview {
  const preview=previewImport(database,value); if(!preview.valid) throw new Error(preview.diagnostics.map(x=>x.message).join("; ")); if(preview.previouslyImported&&!allowRepeat) throw new Error("Backup này đã được import. Cần xác nhận import lại.");
  const doc=validateBackup(value).document!; database.exec("BEGIN IMMEDIATE");
  try {
    if(mode==="replace"){database.exec("DELETE FROM lesson_progress; DELETE FROM legacy_migration_items; DELETE FROM lessons;");}
    const current=existing(database); const byFingerprint=new Map([...current.values()].map(l=>[contentFingerprint(l),l.id])); const remap=new Map<string,string>(); const now=new Date().toISOString();
    for(const source of doc.lessons){let id=source.id;const same=current.get(id);const fp=contentFingerprint(source);if(same&&contentFingerprint(same)!==fp)id=randomUUID();else if(!same&&byFingerprint.has(fp))id=byFingerprint.get(fp)!;remap.set(source.id,id);if(current.has(id)||database.prepare("SELECT 1 FROM lessons WHERE id=?").get(id))continue;const lesson={...source,id};database.prepare("INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)").run(id,1,lesson.title,lesson.summary,JSON.stringify(lesson),lesson.createdAt,lesson.updatedAt);}
    for(const source of doc.progress){const id=remap.get(source.lessonId)!;const incoming={...source,lessonId:id};const row=database.prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?").get(id) as {progress_json:string}|undefined;const merged=mode==="merge"?mergeProgress(row?JSON.parse(row.progress_json):undefined,incoming):incoming;database.prepare("INSERT INTO lesson_progress(lesson_id,progress_version,progress_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(lesson_id) DO UPDATE SET progress_json=excluded.progress_json,progress_version=excluded.progress_version,updated_at=excluded.updated_at").run(id,1,JSON.stringify(merged),merged.createdAt,merged.updatedAt);}
    for(const [oldId,id] of remap){const l=database.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as {lesson_json:string}|undefined;if(!l||!validateCanonicalLesson(JSON.parse(l.lesson_json)).success)throw new Error(`Verify lesson thất bại: ${oldId}`);}
    for(const source of doc.progress){const id=remap.get(source.lessonId)!;const row=database.prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?").get(id) as {progress_json:string}|undefined;const checked=row?validateLessonProgress(JSON.parse(row.progress_json)):undefined;if(!checked?.success||checked.data?.lessonId!==id)throw new Error(`Verify progress thất bại: ${source.lessonId}`);}
    const importId=randomUUID();database.prepare("INSERT INTO import_receipts VALUES(?,?,?,?,?,?,?,?)").run(importId,now,doc.integrity.checksum,mode,doc.lessons.length,doc.progress.length,"success",preview.warnings.length);database.exec("COMMIT");return preview;
  }catch(e){database.exec("ROLLBACK");throw e;}
}
