# localStorage to SQLite migration (Sprint 3)

Sprint 3 makes SQLite the lesson-library and quiz-progress source of truth. Migration is user-confirmed and never deletes, renames, or rewrites legacy browser data.

## Legacy input

The client reader reads only `personal-english-lab-saved-lessons` and progress keys derived from each wrapper: `personal-english-lab-progress:<legacy lesson id>`, then the historical fallback `personal-english-lab-progress:<title>:<summary>`. `personal-english-lab-theme` is not sent. Unrelated browser keys are never scanned. Each valid wrapper is processed independently; malformed records become diagnostics and do not crash the app.

## Flow

1. The banner reports the detected record count. Nothing is written automatically.
2. **Kiểm tra dữ liệu** sends the whitelisted records to `POST /api/storage/migration` with `action: dry-run`. The server normalizes Lesson v1, converts answered quiz indexes to stable quiz UUIDs, checks duplicates and returns a preview. Dry-run writes neither SQLite nor localStorage.
3. **Chuyển dữ liệu** repeats validation and commits valid records in one `BEGIN IMMEDIATE` transaction. Invalid records are explicitly skipped and produce `completed-with-warnings`.
4. Every written Lesson and LessonProgress document is read back and validated before commit. Completion metadata is written only after verification.
5. Retry uses the same fingerprint and receipt, so it reuses the SQLite lesson ID rather than inserting a duplicate.

## Identity and duplicates

The SHA-256 fingerprint uses a stable, recursively key-sorted representation of lesson content and excludes generated IDs, schema version, and timestamps. It does not use title alone: same-title lessons with different content remain distinct. Deterministic UUIDs are derived from the fingerprint for a legacy lesson and its items. Existing canonical SQLite content is also fingerprinted, so a matching lesson is treated as existing. Receipts are stored in `legacy_migration_items` under migration ID `localstorage-lessons-v1`.

## Transaction, verification, and rollback

Schema v3 adds `legacy_migration_items`; v2→v3 is transactional. A critical insert/verification failure rolls back lessons, progress, receipts, and completion state. The authoritative migration state is JSON in `app_metadata` (`migration:localstorage-lessons-v1`), with timestamps, detected/migrated/skipped/warning counts and fingerprint count. States supported by the contract are `not-started`, `preview-ready`, `in-progress`, `completed`, `completed-with-warnings`, `failed`, and `skipped`; dry-run deliberately remains read-only, so its preview state lives in the current UI session.

Legacy localStorage remains the rollback copy. To retry, reload the app, choose **Kiểm tra dữ liệu**, inspect warnings, then confirm again. Fix malformed JSON in a separate recovery workflow only after making a manual copy; this sprint never modifies it. Database health is available at `/api/storage/health`; inspect `PRAGMA user_version`, `app_metadata`, and `legacy_migration_items` only while the app is stopped or through a safe SQLite tool.

After migration, list/create/open/delete and canonical quiz progress use the SQLite API. If migration is deferred, the old data remains intact but is not silently used as a writable source. A future backup/export sprint may offer verified export and, only under a separately approved cleanup policy, removal of legacy keys. No cleanup is implemented here.
