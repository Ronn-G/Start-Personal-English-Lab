# Backup and restore (Sprint 4)

Sprint 5 audio cache files and SQLite `audio_cache` operational metadata remain excluded. Merge and Replace do not delete reusable text-keyed audio cache.

Personal English Lab exports one canonical UTF-8 JSON document with `backupFormat: "personal-english-lab"` and independent `backupVersion: 1`. Backup version is separate from app, SQLite (v4), Lesson (v1), and Progress (v1) versions. Future formats must use an explicit migration step; a newer unsupported version is rejected before any write.

The backup contains active canonical lessons, their stable lesson/item UUIDs, canonical progress, timestamps, source app/schema metadata, an empty allow-listed `settings` object, and a SHA-256 checksum over a deterministic canonical payload. It excludes soft-deleted lessons by default, API keys, environment variables/files, paths, logs, caches, audio/models, migration diagnostics, legacy localStorage and all credentials. Current localStorage theme/preferences are intentionally not backed up.

## Restore flow

Choose a `.json` file of at most 8 MB. The browser parses it without logging or writing it, then sends the parsed object for a server dry-run. The server validates the envelope, versions, every lesson/progress record, duplicate IDs, orphan progress and checksum, and compares it with current SQLite data. The preview shows counts, duplicates, conflicts, source metadata and prior-import warnings.

- **Merge:** new IDs are inserted; identical content is not duplicated. Same ID/different content is preserved as a second lesson under a fresh UUID, and its progress lesson ID is remapped. Stable item IDs remain unchanged. Progress resolution is a pure function: attempt counts never decrease, completion is never downgraded, and newer values win otherwise.
- **Replace all:** only an entirely valid preview can proceed and UI requires final confirmation. The transaction deletes current lesson/progress rows, inserts the backup, validates written lessons, records a receipt, then commits. Any error rolls back the complete operation. Settings outside the backup, environment configuration and legacy localStorage are untouched.

Successful imports store only a compact receipt (UUID, time, source checksum, mode, counts, result and warning count), never the backup blob. Re-importing the same checksum produces a warning and requires explicit confirmation. The checksum detects accidental corruption; it is not a signature, encryption, or protection against a maliciously crafted file.

To restore on a new machine, install/start the app, open **Sao lưu và khôi phục**, select the JSON, inspect the preview, then choose Replace all and confirm. Configure `GEMINI_API_KEY` separately because secrets are deliberately absent. Cloud sync, encryption, automatic backup and Anki export are outside Sprint 4. A clean extracted portable ZIP smoke test remains a release-time manual check.
# Sprint 6 speaking compatibility

Backup v1 now has optional `speakingProgress` and `speakingSessions` collections. Their absence means no speaking history, so pre-Sprint-6 backups remain valid. Counters merge by maximum, status by explicit rank, first practice by earliest timestamp, last/update by latest timestamp, and self-rating from the newest record. Lesson-ID conflicts remap item IDs through stable source type and source item ID. An active session is imported only when every reference remaps; between two active sessions, the farther session wins, then the newer one. Replace includes speaking rows in the existing transaction and never deletes audio cache.
# Personal sentence data

Speaking sessions may contain optional per-item `drafts` and validated `checks`. Their keys are remapped with stable speaking item identities during import; old backups without these fields remain valid. Raw prompts, provider responses, secrets, and audio are never exported.
