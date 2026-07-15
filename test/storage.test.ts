import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { migrateLegacyProgress, validateLessonProgress } from "../src/lib/lesson-progress";
import { normalizeLesson, parseLessonText, validateCanonicalLesson } from "../src/lib/lesson-schema";
import { openStorageDatabase } from "../src/server/storage/database";
import { StorageError } from "../src/server/storage/errors";
import { CURRENT_DATABASE_VERSION, MIGRATIONS, runMigrations } from "../src/server/storage/migrations";
import { SqliteStorageRepository } from "../src/server/storage/sqlite-repository";
import type { Lesson } from "../src/types/lesson";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const temp = () => { const path = mkdtempSync(join(tmpdir(), "pel-test-")); dirs.push(path); return path; };
const uuid = (group: number, index = 0) => `${String(group).padStart(8,"0")}-0000-4000-8000-${String(index).padStart(12,"0")}`;

function legacyLesson(): Record<string, unknown> {
  return {
    title: "Bài kiểm thử", summary: "Tóm tắt bài kiểm thử.",
    vocabulary: Array.from({length:20},(_,i)=>({word:`word ${i}`,phonetic:"/wɜːd/",definition:"định nghĩa",vietnamese:"từ"})),
    idiomsAndSlang:[{phrase:"break the ice",meaning:"bắt chuyện",vietnamese:"phá tan im lặng"}],
    exampleSentences:Array.from({length:5},(_,i)=>({sentence:`Sentence ${i}`,keyPhrase:"phrase",vietnamese:"Câu"})),
    quiz:Array.from({length:5},(_,i)=>({question:`Question ${i}`,options:["A","B","C","D"],correctAnswer:i%4,explanation:"Giải thích"})),
    deepPractice:{shadowingPractice:{steps:["one","two","three"],lines:Array.from({length:3},(_,i)=>({line:`Line ${i}`,focus:"focus",vietnamese:"dòng"}))},sentenceMining:Array.from({length:3},(_,i)=>({sentence:`Mine ${i}`,pattern:"pattern",whyUseful:"useful",remixPrompt:"remix"})),reviewPlan:[1,2,4,7].map(day=>({day:`Day ${day}`,task:"review"})),ankiCards:Array.from({length:5},(_,i)=>({front:`Front ${i}`,back:"Back"}))}
  };
}
function lesson(): Lesson { const result=normalizeLesson(legacyLesson(),{id:uuid(9),createdAt:"2026-01-01T00:00:00.000Z",generateId:(()=>{let i=1;return()=>uuid(8,i++);})()}); assert.ok(result.data); return result.data; }
function progress(item: Lesson, lessonId=item.id) { return {lessonId,progressVersion:1 as const,quizItems:{},learningItems:{},visitedSections:[],practiceHistory:[],createdAt:item.createdAt,updatedAt:item.updatedAt}; }

test("canonical Lesson validation and legacy normalization assign stable IDs",()=>{ const normalized=normalizeLesson(legacyLesson(),{id:uuid(9),createdAt:"2026-01-01T00:00:00.000Z",generateId:(()=>{let i=1;return()=>uuid(7,i++);})()}); assert.equal(normalized.success,true); assert.equal(validateCanonicalLesson(normalized.data).success,true); const again=normalizeLesson(normalized.data); assert.deepEqual(again.data,normalized.data); });
test("duplicate item IDs are repaired while valid IDs are preserved",()=>{ const raw=legacyLesson(); const shared=uuid(6); (raw.vocabulary as Array<Record<string,unknown>>)[0].id=shared; (raw.vocabulary as Array<Record<string,unknown>>)[1].id=shared; let next=1; const result=normalizeLesson(raw,{id:uuid(9),createdAt:"2026-01-01T00:00:00Z",generateId:()=>uuid(5,next++)}); assert.equal(result.data?.vocabulary[0].id,shared); assert.equal(result.data?.vocabulary[1].id,uuid(5,1)); assert.ok(result.diagnostics.some(d=>d.code==="REPAIRED_ITEM_ID")); });
test("parser handles fenced JSON and reports malformed or unsupported documents",()=>{ assert.equal(parseLessonText(`Đây là JSON:\n\`\`\`json\n${JSON.stringify(legacyLesson())}\n\`\`\`\nHết.`).success,true); assert.equal(parseLessonText("{broken").diagnostics[0].code,"MALFORMED_JSON"); assert.equal(parseLessonText(JSON.stringify({...legacyLesson(),schemaVersion:99})).diagnostics[0].code,"UNSUPPORTED_SCHEMA_VERSION"); });
test("legacy quiz indexes migrate to IDs, deduplicate, and warn out of range",()=>{ const item=lesson(); const result=migrateLegacyProgress({answeredQuestions:[0,0,3,99,"x"],visitedTabs:["quiz"]},item); assert.equal(result.success,true); assert.deepEqual(Object.keys(result.data!.quizItems),[item.quiz[0].id,item.quiz[3].id]); assert.equal(result.diagnostics.length,2); assert.equal(validateLessonProgress(result.data).success,true); });
test("canonical Progress rejects index-based shape",()=>{ assert.equal(validateLessonProgress({answeredQuestions:[0]}).success,false); });
test("database migrates 1 to 2 without losing legacy content and rejects newer versions",()=>{ const db=new DatabaseSync(":memory:"); runMigrations(db,[MIGRATIONS[0]]); const id=uuid(4); const legacy=JSON.stringify({...legacyLesson(),unknownLegacyField:"kept"}); db.prepare("INSERT INTO lessons(id,schema_version,title,summary,lesson_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id,1,"title","summary",legacy,"2026-01-01","2026-01-01"); db.prepare("INSERT INTO lesson_progress(lesson_id,progress_version,progress_json,created_at,updated_at) VALUES(?,?,?,?,?)").run(id,1,JSON.stringify({answeredQuestions:[0,99]}),"2026-01-01","2026-01-01"); assert.equal(runMigrations(db),2); const migrated=JSON.parse((db.prepare("SELECT lesson_json FROM lessons WHERE id=?").get(id) as {lesson_json:string}).lesson_json); assert.equal(migrated.title,"Bài kiểm thử"); assert.equal(migrated.unknownLegacyField,"kept"); assert.equal(validateCanonicalLesson(migrated).success,true); const migratedProgress=JSON.parse((db.prepare("SELECT progress_json FROM lesson_progress WHERE lesson_id=?").get(id) as {progress_json:string}).progress_json); assert.equal(validateLessonProgress(migratedProgress).success,true); db.close(); const future=new DatabaseSync(":memory:"); future.exec("PRAGMA user_version=99"); assert.throws(()=>runMigrations(future),(e)=>e instanceof StorageError&&e.code==="UNSUPPORTED_DATABASE_VERSION"); future.close(); });
test("new database v2 and repository preserve canonical IDs and progress",async()=>{ const opened=openStorageDatabase(join(temp(),"db.sqlite3")); assert.equal(opened.schemaVersion,CURRENT_DATABASE_VERSION); const repo=new SqliteStorageRepository(opened.database); const source=lesson(); const created=await repo.createLesson({id:source.id,lesson:source}); assert.deepEqual(created.lesson,source); const saved=await repo.saveLessonProgress(source.id,progress(source)); assert.deepEqual((await repo.getLesson(source.id))?.lesson,source); assert.deepEqual(await repo.getLessonProgress(source.id),saved); opened.database.close(); });
test("failed migration rolls back",()=>{ const db=new DatabaseSync(":memory:"); assert.throws(()=>runMigrations(db,[{version:1,name:"fail",up(d){d.exec("CREATE TABLE nope(id TEXT)");throw new Error("boom");}}])); assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='nope'").get(),undefined); db.close(); });
