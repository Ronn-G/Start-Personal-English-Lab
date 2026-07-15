# Data schemas (Sprint 2)

Three independent integer versions exist: SQLite database **2** (`PRAGMA user_version`), Lesson document **1** (`CURRENT_LESSON_SCHEMA_VERSION`), and Lesson progress **1** (`CURRENT_PROGRESS_SCHEMA_VERSION`).

## Lesson v1 and stable IDs

`Lesson` owns `id`, `schemaVersion`, `createdAt`, `updatedAt` and all learning content. Stable UUIDs exist on vocabulary, idiom/slang, example sentence, quiz question, shadowing line, sentence-mining item and Anki card. Valid IDs survive normalization. Missing, invalid or duplicate IDs are assigned/repaired once by the app; AI is not trusted to generate them. Duplicate detection spans the whole lesson.

The shared client-compatible pipeline in `src/lib/lesson-schema.ts` is:

```text
raw text -> strip fences -> JSON parse -> legacy-version check -> immutable migration
-> assign/repair IDs -> canonical validation -> typed result + diagnostics
```

Manual paste and automatic Gemini generation both use it. Malformed JSON is never silently rewritten. Legacy v0 normalization prefers wrapper timestamps; without one it uses fixed fallback `1970-01-01T00:00:00.000Z`, so repeated reads do not invent time. Future Sprint 3 must persist a normalized result before treating generated IDs as durable.

## Progress v1

`LessonProgress` contains `lessonId`, `progressVersion`, ID-keyed `quizItems`/`learningItems`, `visitedSections`, extensible `practiceHistory`, and timestamps. Quiz state includes selected answer, correctness, attempt count, answered time and completion. Learning state includes `new | learning | learned`, update time and user-selected flag. Practice history stores metadata/feedback, never audio.

Progress uses IDs because indexes change when lesson arrays are reordered. Lesson content describes what is taught; progress separately describes user interaction.

`migrateLegacyProgress()` is pure. With the matching canonical Lesson it deduplicates legacy quiz indexes, maps valid indexes to quiz IDs, and warns/skips wrong-type or out-of-range values without writing storage.

## Database, boundaries and future versions

SQLite still stores whole documents in `lesson_json` and `progress_json`; item tables remain out of scope. Migration 2 transactionally normalizes version-1 database payloads to canonical documents while retaining unknown legacy fields. Repository reads/writes validate canonical documents and preserve IDs. Databases newer than v2 are rejected.

To add a version: increment the relevant integer, add an immutable `vN -> vN+1` migration, retain diagnostics/fixtures for supported inputs, and update producers, validators, repository tests and this document. Database and document versions must never be conflated.

Not migrated in Sprint 2: existing localStorage lessons/progress or keys, vocabulary flips, visited tabs, quiz score and historical speaking feedback. No legacy key is automatically deleted or overwritten; Sprint 3 must preview, persist and verify migration before switching UI source of truth.
