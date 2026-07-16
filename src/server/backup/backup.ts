import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validateCanonicalLesson } from "../../lib/lesson-schema";
import { validateLessonProgress, type LessonProgress } from "../../lib/lesson-progress";
import type { Lesson } from "../../types/lesson";
import { CURRENT_LESSON_SCHEMA_VERSION } from "../../types/lesson";
import { CURRENT_DATABASE_VERSION } from "../storage/migrations";
import { extractPracticeCandidates } from "../../lib/speaking-practice";

export const BACKUP_FORMAT = "personal-english-lab";
export const CURRENT_BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 8_000_000;

export interface BackupDocument {
  backupFormat: typeof BACKUP_FORMAT; backupVersion: 1; exportedAt: string; appVersion: string;
  databaseSchemaVersion: number; lessonSchemaVersion: number; progressSchemaVersion: number;
  lessons: Lesson[]; progress: LessonProgress[]; settings: Record<string, never>;
  speakingProgress?: SpeakingProgressBackup[]; speakingSessions?: SpeakingSessionBackup[];
  integrity: { algorithm: "SHA-256"; checksum: string };
}
export interface SpeakingProgressBackup { lessonId:string; practiceItemId:string; sourceType:string; sourceItemId:string; status:"new"|"practicing"|"recalled_with_help"|"recalled"|"personalized"; attemptCount:number; helpCount:number; showAnswerCount:number; recalledCount:number; personalizedCount:number; selfRating?:"hard"|"okay"|"easy"; firstPracticedAt?:string; lastPracticedAt?:string; updatedAt:string }
export interface SpeakingSessionBackup { id:string; lessonId:string; itemIds:string[]; drafts?:Record<string,string>; checks?:Record<string,unknown>; currentItemIndex:number; currentStep:string; status:"active"|"completed"|"cancelled"; createdAt:string; updatedAt:string; completedAt?:string }
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
function bare(document: BackupDocument): BareBackup { const result:BareBackup={ backupFormat:document.backupFormat,backupVersion:document.backupVersion,exportedAt:document.exportedAt,appVersion:document.appVersion,databaseSchemaVersion:document.databaseSchemaVersion,lessonSchemaVersion:document.lessonSchemaVersion,progressSchemaVersion:document.progressSchemaVersion,lessons:document.lessons,progress:document.progress,settings:document.settings };if(document.speakingProgress!==undefined)result.speakingProgress=document.speakingProgress;if(document.speakingSessions!==undefined)result.speakingSessions=document.speakingSessions;return result; }

export function validateBackup(value: unknown): { document?: BackupDocument; diagnostics: BackupDiagnostic[] } {
  const d: BackupDiagnostic[] = [];
  if (!record(value)) return { diagnostics: [{ code: "INVALID_BACKUP", path: "$", message: "Backup pháº£i lÃ  JSON object." }] };
  if (value.backupFormat !== BACKUP_FORMAT) d.push({ code: "INVALID_FORMAT", path: "$.backupFormat", message: "Sai Ä‘á»‹nh dáº¡ng backup." });
  if (value.backupVersion !== CURRENT_BACKUP_VERSION) d.push({ code: "UNSUPPORTED_BACKUP_VERSION", path: "$.backupVersion", message: `Chá»‰ há»— trá»£ backup version ${CURRENT_BACKUP_VERSION}.` });
  for (const key of ["exportedAt","appVersion","databaseSchemaVersion","lessonSchemaVersion","progressSchemaVersion","lessons","progress","settings","integrity"]) if (!(key in value)) d.push({ code: "MISSING_FIELD", path: `$.${key}`, message: `Thiáº¿u field ${key}.` });
  if (!Array.isArray(value.lessons) || !Array.isArray(value.progress) || value.lessons?.length > 500 || value.progress?.length > 500) d.push({ code: "INVALID_COLLECTION", path: "$", message: "Danh sÃ¡ch lesson/progress khÃ´ng há»£p lá»‡ hoáº·c quÃ¡ 500 record." });
  if (value.lessonSchemaVersion !== 1 || value.progressSchemaVersion !== 1) d.push({ code: "UNSUPPORTED_DOCUMENT_VERSION", path: "$", message: "Schema lesson/progress khÃ´ng Ä‘Æ°á»£c há»— trá»£." });
  const ids = new Set<string>(); const itemIds = new Map<string, Set<string>>();
  if (Array.isArray(value.lessons)) value.lessons.forEach((lesson, i) => {
    const result = validateCanonicalLesson(lesson);
    if (!result.success) d.push({ code: "INVALID_LESSON", path: `$.lessons[${i}]`, message: result.diagnostics.map(x=>x.message).join("; ") });
    else if (ids.has((lesson as Lesson).id)) d.push({ code: "DUPLICATE_LESSON_ID", path: `$.lessons[${i}].id`, message: "Lesson ID bá»‹ trÃ¹ng trong backup." });
    else { const data=lesson as Lesson; ids.add(data.id); itemIds.set(data.id,new Set([...data.vocabulary,...data.idiomsAndSlang,...data.exampleSentences,...data.quiz,...data.deepPractice.shadowingPractice.lines,...data.deepPractice.sentenceMining,...data.deepPractice.ankiCards].map(x=>x.id))); }
  });
  if (Array.isArray(value.progress)) value.progress.forEach((progress, i) => {
    const result = validateLessonProgress(progress);
    if (!result.success) d.push({ code: "INVALID_PROGRESS", path: `$.progress[${i}]`, message: result.diagnostics.map(x=>x.message).join("; ") });
    else if (!ids.has((progress as LessonProgress).lessonId)) d.push({ code: "ORPHAN_PROGRESS", path: `$.progress[${i}].lessonId`, message: "Progress khÃ´ng cÃ³ lesson tÆ°Æ¡ng á»©ng." });
    else { const data=progress as LessonProgress, allowed=itemIds.get(data.lessonId)!; const bad=[...Object.keys(data.quizItems),...Object.keys(data.learningItems)].find(id=>!allowed.has(id)); if(bad)d.push({code:"ITEM_ID_MISMATCH",path:`$.progress[${i}]`,message:`Progress tham chiáº¿u item ID khÃ´ng thuá»™c lesson: ${bad}.`}); }
  });
  if (d.length) return { diagnostics: d };
  const document = value as unknown as BackupDocument;
  if (!record(document.integrity) || document.integrity.algorithm !== "SHA-256" || document.integrity.checksum !== checksum(bare(document))) d.push({ code: "CHECKSUM_MISMATCH", path: "$.integrity.checksum", message: "Checksum khÃ´ng khá»›p; file cÃ³ thá»ƒ Ä‘Ã£ há»ng hoáº·c bá»‹ sá»­a." });
  return d.length ? { diagnostics: d } : { document, diagnostics: [] };
}

export function exportBackup(database: DatabaseSync, appVersion: string, now = new Date().toISOString()): BackupDocument {
  database.exec("BEGIN");
  try {
    const lessons = (database.prepare("SELECT lesson_json FROM lessons WHERE deleted_at IS NULL ORDER BY id").all() as {lesson_json:string}[]).map(r=>JSON.parse(r.lesson_json) as Lesson);
    const progress = (database.prepare("SELECT p.progress_json FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.deleted_at IS NULL ORDER BY p.lesson_id").all() as {progress_json:string}[]).map(r=>JSON.parse(r.progress_json) as LessonProgress);
    const speakingProgress=(database.prepare("SELECT p.* FROM speaking_progress p JOIN lessons l ON l.id=p.lesson_id WHERE l.deleted_at IS NULL ORDER BY p.lesson_id,p.practice_item_id").all() as Record<string,unknown>[]).map(r=>({lessonId:String(r.lesson_id),practiceItemId:String(r.practice_item_id),sourceType:String(r.source_type),sourceItemId:String(r.source_item_id),status:r.status as SpeakingProgressBackup["status"],attemptCount:Number(r.attempt_count),helpCount:Number(r.help_count),showAnswerCount:Number(r.show_answer_count),recalledCount:Number(r.recalled_count),personalizedCount:Number(r.personalized_count),...(r.self_rating?{selfRating:r.self_rating as SpeakingProgressBackup["selfRating"]}:{}),...(r.first_practiced_at?{firstPracticedAt:String(r.first_practiced_at)}:{}),...(r.last_practiced_at?{lastPracticedAt:String(r.last_practiced_at)}:{}),updatedAt:String(r.updated_at)}));
    const speakingSessions=(database.prepare("SELECT s.* FROM speaking_sessions s JOIN lessons l ON l.id=s.lesson_id WHERE l.deleted_at IS NULL ORDER BY s.lesson_id,s.updated_at").all() as Record<string,unknown>[]).map(r=>({id:String(r.id),lessonId:String(r.lesson_id),itemIds:JSON.parse(String(r.item_ids_json)) as string[],drafts:JSON.parse(String(r.drafts_json||"{}")) as Record<string,string>,checks:JSON.parse(String(r.checks_json||"{}")) as Record<string,unknown>,currentItemIndex:Number(r.current_item_index),currentStep:String(r.current_step),status:r.status as SpeakingSessionBackup["status"],createdAt:String(r.created_at),updatedAt:String(r.updated_at),...(r.completed_at?{completedAt:String(r.completed_at)}:{})}));
    const payload: BareBackup = { backupFormat: BACKUP_FORMAT, backupVersion: 1, exportedAt: now, appVersion, databaseSchemaVersion: CURRENT_DATABASE_VERSION, lessonSchemaVersion: CURRENT_LESSON_SCHEMA_VERSION, progressSchemaVersion: 1, lessons, progress, speakingProgress, speakingSessions, settings: {} };
    const document: BackupDocument = { ...payload, integrity: { algorithm: "SHA-256", checksum: checksum(payload) } };
    const validated = validateBackup(document); if (!validated.document) throw new Error(`Dá»¯ liá»‡u SQLite khÃ´ng há»£p lá»‡: ${validated.diagnostics.map(x=>x.message).join("; ")}`);
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
  const warnings:string[]=[]; if(conflicts) warnings.push(`${conflicts} xung Ä‘á»™t ID sáº½ Ä‘Æ°á»£c giá»¯ cáº£ hai báº±ng ID má»›i khi Merge.`); if(prior) warnings.push("Backup nÃ y Ä‘Ã£ tá»«ng Ä‘Æ°á»£c import; hÃ£y xÃ¡c nháº­n náº¿u muá»‘n tiáº¿p tá»¥c.");
  return {valid:true,exportedAt:doc.exportedAt,appVersion:doc.appVersion,databaseSchemaVersion:doc.databaseSchemaVersion,lessonCount:doc.lessons.length,progressCount:doc.progress.length,validRecords:doc.lessons.length+doc.progress.length,invalidRecords:0,duplicates,conflicts,newLessons,updatedLessons:duplicates,previouslyImported:prior,warnings,diagnostics:[],fingerprint};
}

export function mergeProgress(a: LessonProgress | undefined, b: LessonProgress): LessonProgress {
  if(!a) return b; const newer=Date.parse(b.updatedAt)>=Date.parse(a.updatedAt)?b:a; const older=newer===b?a:b;
  const quizItems={...older.quizItems,...newer.quizItems}; for(const id of new Set([...Object.keys(a.quizItems),...Object.keys(b.quizItems)])){const x=a.quizItems[id],y=b.quizItems[id];if(x&&y)quizItems[id]={...(Date.parse(y.answeredAt)>=Date.parse(x.answeredAt)?y:x),attemptCount:Math.max(x.attemptCount,y.attemptCount),completed:x.completed||y.completed};}
  return {...newer,quizItems,learningItems:{...older.learningItems,...newer.learningItems},visitedSections:[...new Set([...a.visitedSections,...b.visitedSections])],practiceHistory:[...new Map([...a.practiceHistory,...b.practiceHistory].map(x=>[x.id,x])).values()],createdAt:Date.parse(a.createdAt)<Date.parse(b.createdAt)?a.createdAt:b.createdAt};
}
const speakingRank:Record<SpeakingProgressBackup["status"],number>={new:0,practicing:1,recalled_with_help:2,recalled:3,personalized:4};
export function mergeSpeakingProgress(a:SpeakingProgressBackup|undefined,b:SpeakingProgressBackup):SpeakingProgressBackup{if(!a)return b;const newer=Date.parse(b.updatedAt)>=Date.parse(a.updatedAt)?b:a;return {...newer,status:speakingRank[a.status]>=speakingRank[b.status]?a.status:b.status,attemptCount:Math.max(a.attemptCount,b.attemptCount),helpCount:Math.max(a.helpCount,b.helpCount),showAnswerCount:Math.max(a.showAnswerCount,b.showAnswerCount),recalledCount:Math.max(a.recalledCount,b.recalledCount),personalizedCount:Math.max(a.personalizedCount,b.personalizedCount),firstPracticedAt:(!a.firstPracticedAt?b.firstPracticedAt:!b.firstPracticedAt?a.firstPracticedAt:Date.parse(a.firstPracticedAt)<=Date.parse(b.firstPracticedAt)?a.firstPracticedAt:b.firstPracticedAt),lastPracticedAt:(!a.lastPracticedAt?b.lastPracticedAt:!b.lastPracticedAt?a.lastPracticedAt:Date.parse(a.lastPracticedAt)>=Date.parse(b.lastPracticedAt)?a.lastPracticedAt:b.lastPracticedAt),updatedAt:Date.parse(a.updatedAt)>=Date.parse(b.updatedAt)?a.updatedAt:b.updatedAt};}
function dbSpeaking(row:Record<string,unknown>):SpeakingProgressBackup{return {lessonId:String(row.lesson_id),practiceItemId:String(row.practice_item_id),sourceType:String(row.source_type),sourceItemId:String(row.source_item_id),status:row.status as SpeakingProgressBackup["status"],attemptCount:Number(row.attempt_count),helpCount:Number(row.help_count),showAnswerCount:Number(row.show_answer_count),recalledCount:Number(row.recalled_count),personalizedCount:Number(row.personalized_count),...(row.self_rating?{selfRating:row.self_rating as SpeakingProgressBackup["selfRating"]}:{}),...(row.first_practiced_at?{firstPracticedAt:String(row.first_practiced_at)}:{}),...(row.last_practiced_at?{lastPracticedAt:String(row.last_practiced_at)}:{}),updatedAt:String(row.updated_at)};}

export function importBackup(database: DatabaseSync, value: unknown, mode: "merge"|"replace", allowRepeat=false): ImportPreview {
  const preview=previewImport(database,value); if(!preview.valid) throw new Error(preview.diagnostics.map(x=>x.message).join("; ")); if(preview.previouslyImported&&!allowRepeat) throw new Error("Backup nÃ y Ä‘Ã£ Ä‘Æ°á»£c import. Cáº§n xÃ¡c nháº­n import láº¡i.");
  const doc=validateBackup(value).document!; database.exec("BEGIN IMMEDIATE");
  try {
    if(mode==="replace"){database.exec("DELETE FROM lesson_progress; DELETE FROM legacy_migration_items; DELETE FROM lessons;");}
    const current=existing(database); const byFingerprint=new Map([...current.values()].map(l=>[contentFingerprint(l),l.id])); const remap=new Map<string,string>(); const now=new Date().toISOString();
    for(const source of doc.lessons){let id=source.id;const same=current.get(id);const fp=contentFingerprint(source);if(same&&contentFingerprint(same)!==fp)id=randomUUID();else if(!same&&byFingerprint.has(fp))id=byFingerprint.get(fp)!;remap.set(source.id,id);if(current.has(id)||database.prepare("SELECT 1 FROM lessons WHERE id=?").get(id))continue;const lesson={...source,id};database.prepare("INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at,was_truncated) VALUES(?,?,?,?,?,?,?,0)").run(id,1,lesson.title,lesson.summary,JSON.stringify(lesson),lesson.createdAt,lesson.updatedAt);}
    for(const source of doc.progress){const id=remap.get(source.lessonId)!;const incoming={...source,lessonId:id};const row=database.prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?").get(id) as {progress_json:string}|undefined;const merged=mode==="merge"?mergeProgress(row?JSON.parse(row.progress_json):undefined,incoming):incoming;database.prepare("INSERT INTO lesson_progress(lesson_id,progress_version,progress_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(lesson_id) DO UPDATE SET progress_json=excluded.progress_json,progress_version=excluded.progress_version,updated_at=excluded.updated_at").run(id,1,JSON.stringify(merged),merged.createdAt,merged.updatedAt);}
    for(const source of doc.speakingProgress??[]){const id=remap.get(source.lessonId);if(!id)continue;const targetLessonRow=database.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as {lesson_json:string}|undefined;if(!targetLessonRow)continue;const target=extractPracticeCandidates(JSON.parse(targetLessonRow.lesson_json) as Lesson).find(x=>x.sourceType===source.sourceType&&x.sourceItemId===source.sourceItemId);if(!target)continue;const incoming={...source,lessonId:id,practiceItemId:target.id};const old=database.prepare("SELECT * FROM speaking_progress WHERE lesson_id=? AND practice_item_id=?").get(id,target.id) as Record<string,unknown>|undefined;const merged=mode==="merge"?mergeSpeakingProgress(old?dbSpeaking(old):undefined,incoming):incoming;database.prepare("INSERT INTO speaking_progress(lesson_id,practice_item_id,source_type,source_item_id,status,attempt_count,help_count,show_answer_count,recalled_count,personalized_count,self_rating,first_practiced_at,last_practiced_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lesson_id,practice_item_id) DO UPDATE SET status=excluded.status,attempt_count=excluded.attempt_count,help_count=excluded.help_count,show_answer_count=excluded.show_answer_count,recalled_count=excluded.recalled_count,personalized_count=excluded.personalized_count,self_rating=excluded.self_rating,first_practiced_at=excluded.first_practiced_at,last_practiced_at=excluded.last_practiced_at,updated_at=excluded.updated_at").run(id,target.id,target.sourceType,target.sourceItemId,merged.status,merged.attemptCount,merged.helpCount,merged.showAnswerCount,merged.recalledCount,merged.personalizedCount,merged.selfRating??null,merged.firstPracticedAt??null,merged.lastPracticedAt??null,merged.updatedAt);}
    for(const source of doc.speakingSessions??[]){const id=remap.get(source.lessonId);if(!id)continue;const oldLesson=doc.lessons.find(x=>x.id===source.lessonId),targetRow=database.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as {lesson_json:string}|undefined;if(!oldLesson||!targetRow)continue;const oldCandidates=extractPracticeCandidates(oldLesson),newCandidates=extractPracticeCandidates(JSON.parse(targetRow.lesson_json) as Lesson);const mapped=source.itemIds.map(oldId=>{const old=oldCandidates.find(x=>x.id===oldId);return old&&newCandidates.find(x=>x.sourceType===old.sourceType&&x.sourceItemId===old.sourceItemId)?.id;});if(mapped.some(x=>!x))continue;const local=database.prepare("SELECT * FROM speaking_sessions WHERE lesson_id=? AND status='active'").get(id) as Record<string,unknown>|undefined;if(source.status==="active"&&local&&(Number(local.current_item_index)>source.currentItemIndex||(Number(local.current_item_index)===source.currentItemIndex&&Date.parse(String(local.updated_at))>=Date.parse(source.updatedAt))))continue;if(source.status==="active"&&local)database.prepare("UPDATE speaking_sessions SET status='cancelled',updated_at=? WHERE id=?").run(now,String(local.id));const remapObject=(value:Record<string,unknown>|undefined)=>Object.fromEntries(Object.entries(value??{}).flatMap(([oldId,data])=>{const at=source.itemIds.indexOf(oldId),newId=at>=0?mapped[at]:undefined;return newId?[[newId,data]]:[];}));database.prepare("INSERT INTO speaking_sessions(id,lesson_id,item_ids_json,drafts_json,checks_json,current_item_index,current_step,status,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),id,JSON.stringify(mapped),JSON.stringify(remapObject(source.drafts)),JSON.stringify(remapObject(source.checks)),Math.min(source.currentItemIndex,mapped.length-1),source.currentStep,source.status,source.createdAt,source.updatedAt,source.completedAt??null);}
    for(const [oldId,id] of remap){const l=database.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as {lesson_json:string}|undefined;if(!l||!validateCanonicalLesson(JSON.parse(l.lesson_json)).success)throw new Error(`Verify lesson tháº¥t báº¡i: ${oldId}`);}
    for(const source of doc.progress){const id=remap.get(source.lessonId)!;const row=database.prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?").get(id) as {progress_json:string}|undefined;const checked=row?validateLessonProgress(JSON.parse(row.progress_json)):undefined;if(!checked?.success||checked.data?.lessonId!==id)throw new Error(`Verify progress tháº¥t báº¡i: ${source.lessonId}`);}
    const importId=randomUUID();database.prepare("INSERT INTO import_receipts VALUES(?,?,?,?,?,?,?,?)").run(importId,now,doc.integrity.checksum,mode,doc.lessons.length,doc.progress.length,"success",preview.warnings.length);database.exec("COMMIT");return preview;
  }catch(e){database.exec("ROLLBACK");throw e;}
}
