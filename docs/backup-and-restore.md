# Backup and restore

Personal English Lab exports canonical UTF-8 JSON with
`backupFormat: "personal-english-lab"` and `backupVersion: 2`. Backup version is independent from
the app version, SQLite schema (v11), Lesson schema (v1), and Progress schema (v1).

## What v2 contains

- Canonical active lessons and stable lesson/item IDs.
- Canonical lesson progress, including learning items, visited sections, practice history, and quiz
  attempts.
- One `lessonSources` snapshot per lesson, linked by stable `lessonId`. Its exact fields are
  `title`, `url`, `channel`, `originalTranscript`, `processedTranscript`, `wasTruncated`, and
  `updatedAt`. Nullable strings are represented explicitly as `null`.
- Speaking progress and sessions, including session-scoped drafts and validated sentence checks.
- Listening sessions, listening item progress, and `savedForRelisten` bookmarks.
- Export/app/schema timestamps and an SHA-256 checksum over a deterministic canonical payload.

The backup deliberately excludes API keys, environment files, machine/SQLite paths, WAV data,
audio-cache metadata, Kokoro models, logs, temporary playback state, migration diagnostics, legacy
localStorage, and credentials. Source validation accepts only HTTP(S) URLs and rejects unexpected
fields and `data:audio/...` content.

## Backward compatibility

Version 1 remains importable. A v1 document has no reliable `lessonSources` contract, so source
title/URL/channel/transcripts restore as empty and `wasTruncated` restores as `false`. Dry-run and
the UI show an explicit warning before import. Missing optional Speaking or Listening collections
still mean that the older backup contains no history for that feature. The original v1 checksum is
verified before legacy Progress defaults are normalized.

Version 2 requires exactly one source record for every lesson. Missing, duplicate, orphaned,
oversized, machine-local, or structurally unknown source data makes dry-run invalid.

## Merge policy

- A lesson with no conflict keeps its stable ID.
- Identical canonical content is deduplicated. A different incoming ID is remapped to the existing
  lesson ID.
- The same ID with different canonical content is assigned a fresh UUID, unless that exact content
  was already imported; retries therefore remain idempotent.
- Lesson source data follows the final lesson ID. Source metadata is one atomic snapshot: the newer
  `updatedAt` wins as a whole. Fields are never mixed independently.
- Lesson progress keeps monotonic attempts/completion/ranks. Speaking and Listening identities are
  remapped through source type plus stable source-item ID.
- Session IDs are preserved unless they collide with a different lesson. One active session per
  lesson is retained according to documented progress/recency rules.

## Replace policy and verification

Replace deletes and restores lessons, sources, Progress, Speaking, and Listening inside one
`BEGIN IMMEDIATE` transaction. It does not delete device-local audio cache or settings outside the
backup. Before commit, import verifies:

- lesson and per-type record counts for Replace;
- every source field against the selected source snapshot;
- canonical Progress;
- Speaking item/source identity, counters, session item/step/state shape, and one active session;
- Listening item/source identity, counters, session state, and one active session;
- foreign keys and absence of orphan records.

Any insert or verification error rolls back the entire operation. A success receipt is written only
after these checks pass.

## Validation and limits

The exact serialized backup limit is **8,000,000 UTF-8 bytes**. Export validates this before returning
a file. The import request limit is **8,064,000 bytes**, leaving explicit JSON-envelope overhead, and
the browser rejects files above the backup limit before dry-run.

Every app write that can change backed-up state runs inside a transaction and validates the exact v2
snapshot before commit. The write is rolled back if the resulting database would exceed 8,000,000
bytes or fail backup validation. This also applies to Merge imports and legacy migration, so two
individually valid databases cannot be combined into an unbackupable state.

Collection limits are:

- lessons, lesson sources, and lesson progress: 500 each;
- Speaking progress: 5,000;
- Speaking sessions: 2,000;
- Listening sessions: 2,000;
- Listening item progress: 25,000.

The 500-lesson limit is enforced when a lesson is created. Speaking and Listening session limits are
enforced when a new session is created. Item-progress ceilings cover the bounded set of source items
available across 500 canonical lessons. Boundary tests cover limit minus one, exact limit, and limit
plus one; byte tests use the same predicate as export/import validation.

Transcripts are capped at 2,000,000 characters and 4,000,000 UTF-8 bytes per field; source labels,
URLs, drafts, checks, hashes, and notes have smaller field-specific limits. Diagnostics name the
exact JSON path (for example `$.lessonSources[2].originalTranscript` or
`$.speakingSessions[1].currentStep`) and never include full transcript content.

## Integrity and recovery drill

The SHA-256 checksum detects accidental corruption. It is **not** a signature, encryption, or proof
that a crafted file is trustworthy; all content is validated independently after checksum
recalculation.

Recovery drill:

1. Export a v2 backup and keep the JSON file outside the app data directory.
2. Open **Sao lưu và khôi phục**, select the file, and inspect version, source availability, all
   per-type counts, conflicts, remaps, invalid records, and warnings.
3. Choose Replace and confirm the explicit destructive prompt.
4. Reopen the lesson and verify original/processed transcripts, source URL/title/channel,
   `wasTruncated`, canonical lesson content, Progress, Speaking, Listening, and Re-listen bookmarks.
5. Configure API keys separately; secrets are intentionally never restored.

Audio cache and WAV files remain device-local and reusable across Merge/Replace. Portable packaging,
cloud sync, encryption, and automatic scheduled backup remain outside this sprint.
