# SQLite Storage Architecture

> Schema v9 adds an indexed `saved_for_relisten` bookmark to the v8 listening tables. Listening
> commands resolve lesson/source identity server-side, enforce one active session per lesson,
> validate sequential business steps and update bookmarks transactionally. Recognition/difficulty
> columns remain legacy compatibility data; listening and speaking progress remain independent.

> Sprint 5 stores WAV files in `<data-directory>/audio-cache`, not SQLite. Schema v5 adds `audio_cache` metadata with generating/ready/failed/stale state, size/config/access/failure fields. Missing ready files are marked stale; cleanup uses last-accessed LRU and a 500 MB default.

> Sprint 4 uses database schema v4. Migration 4 transactionally creates `import_receipts` with source SHA-256 fingerprint, mode, counts, result and warning count. Export reads active lessons and progress in one transaction. Merge/replace write and verify in one `BEGIN IMMEDIATE` transaction; any failure rolls back. Backup JSON blobs and secrets are never stored.

> Sprint 3 makes SQLite the UI source of truth and adds an explicit, previewed localStorage migration. Legacy browser data remains untouched as a temporary rollback copy.

## 1. Why SQLite

SQLite is the long-term source of truth because Personal English Lab is a single-user, local-first desktop-style application that needs durable structured data, transactions, migrations and straightforward file backup.

- localStorage remains useful for small browser preferences and transition compatibility, but it has a small quota, weak error reporting, no transaction across records, no server access and is tied to one browser profile.
- IndexedDB has more capacity than localStorage but remains browser-profile storage. Its backup/portable lifecycle is harder to control and it cannot be the server-side source of truth for the standalone Node application.
- SQLite provides ACID transactions, constraints, indexes, schema versioning and one primary file that can be backed up independently from the immutable app artifact.

The selected driver is Node.js built-in `node:sqlite` using `DatabaseSync`. It avoids a separate native addon and ABI-specific `.node` binding. The bundled runtime must be Node.js 24 or newer; the portable build verifies this before packaging. The repository methods remain async so the driver can be replaced without changing callers.

## 2. Storage boundaries

```text
React UI (lesson library and quiz progress use SQLite)
        |
future opt-in
        v
src/lib/storage-client.ts
        |
internal /api/storage Route Handlers (Node.js runtime only)
        |
StorageRepository async interfaces
        |
SqliteStorageRepository + mappers + validation
        |
node:sqlite -> personal-english-lab.sqlite3
```

Driver imports exist only under `src/server/storage`. Client Components must not import those modules at runtime. `storage-client.ts` imports domain contracts with `import type` and communicates only through internal HTTP APIs.

Repository capabilities:

- `listLessons`
- `getLesson`
- `createLesson`
- `updateLesson`
- `deleteLesson` (soft delete)
- `getLessonProgress`
- `saveLessonProgress`
- `getSetting` and `setSetting` for application metadata/settings

Database rows are mapped to domain objects. Raw snake_case rows are never returned directly to the API/UI.

## 3. Data directory

One server-side resolver in `src/server/storage/data-directory.ts` owns path selection.

Priority:

1. `PERSONAL_ENGLISH_LAB_DATA_DIR` when configured. Relative values resolve from the server working directory; an absolute path is recommended for production.
2. Development/test fallback: `<fluent>/.data`.
3. Production Windows fallback: `%LOCALAPPDATA%\PersonalEnglishLab`, then `%APPDATA%`, then the user's `AppData\Local` directory.
4. Non-Windows production fallback: `$XDG_DATA_HOME/personal-english-lab` or `~/.local/share/personal-english-lab`.

The database filename is `personal-english-lab.sqlite3`. The portable launcher explicitly sets `PERSONAL_ENGLISH_LAB_DATA_DIR` to Local AppData, so an app update or re-extraction does not overwrite user data. The database, WAL/SHM/journal files and `.data` are gitignored. Build scripts do not copy a development database into the artifact.

## 4. Database schema version 3

Migration 2 transactionally converts version-1 database JSON to canonical Lesson v1 and Progress v1 while retaining unknown legacy fields. This is database migration only; localStorage remains untouched for explicit Sprint 3 migration. New repository writes require canonical documents.

Migration 3 transactionally adds `legacy_migration_items`, keyed by migration ID and SHA-256 legacy fingerprint. It retains the mapped lesson UUID, item status, diagnostics, and timestamps. `app_metadata` stores the authoritative migration status and aggregate receipt.

SQLite `PRAGMA user_version` is the authoritative migration counter. `app_metadata.schema_version` mirrors it for diagnostics.

### `app_metadata`

| Column       | Purpose                |
| ------------ | ---------------------- |
| `key`        | text primary key       |
| `value`      | setting/metadata value |
| `updated_at` | ISO timestamp          |

### `lessons`

| Column                                         | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `id`                                           | stable UUID, primary key; never title/index based           |
| `schema_version`                               | version of the Lesson JSON payload                          |
| `title`, `summary`                             | searchable/display metadata                                 |
| `lesson_depth`                                 | nullable future depth classification                        |
| `lesson_json`                                  | full transitional Lesson payload, checked with `json_valid` |
| `created_at`, `updated_at`                     | ISO timestamps                                              |
| `source_title`, `source_url`, `source_channel` | nullable source metadata                                    |
| `original_transcript`, `processed_transcript`  | nullable transcript variants                                |
| `was_truncated`                                | SQLite integer boolean constrained to 0/1                   |
| `deleted_at`                                   | nullable soft-delete timestamp                              |

### `lesson_progress`

| Column                     | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `lesson_id`                | primary/foreign key to `lessons.id`                      |
| `progress_version`         | version of progress JSON                                 |
| `progress_json`            | transitional progress payload, checked with `json_valid` |
| `created_at`, `updated_at` | ISO timestamps                                           |

Vocabulary, quiz and speaking items are intentionally not normalized in Sprint 1. Their future stable IDs can be introduced with a later payload migration before extracting item tables.

## 5. Migration behavior

- Migrations are ordered, integer-versioned functions in `migrations.ts`.
- They run automatically before the first repository access.
- Each migration runs inside `BEGIN IMMEDIATE`/`COMMIT`; an error triggers `ROLLBACK`.
- The database is never deleted or recreated after a migration error.
- A database with `user_version` newer than the app supports is opened only long enough to detect the mismatch, then rejected. No migration/write occurs and API returns a storage-unavailable error.
- Migration 1 creates all three tables, constraints and the lesson ordering index.
- Tests cover a new database, idempotent rerun, newer unsupported version and rollback after an intentionally failing migration.

## 6. API surface and health check

All SQLite routes explicitly use `runtime = "nodejs"` and dynamic request-time execution:

- `GET /api/storage/health`
- `GET|POST /api/storage/lessons`
- `GET|PUT|DELETE /api/storage/lessons/:id`
- `GET|PUT /api/storage/lessons/:id/progress`

Health returns only status, driver name, current schema version and supported schema version. It does not expose the database path, transcripts, secrets or host details.

Request bodies, IDs, Lesson shape and progress shape are validated before writes. Storage errors map to stable codes and HTTP 400/404/409/503. Full transcript/practice payloads are not logged.

## 7. localStorage transition and Sprint 3 migration

Sprint 1 does not change these keys or their behavior:

- `personal-english-lab-saved-lessons`
- `personal-english-lab-progress:*`
- `personal-english-lab-theme`

No localStorage lesson is automatically copied, changed or deleted. The UI now uses SQLite for lesson CRUD and UUID-keyed quiz progress; the migration banner appears only when legacy records exist and completion has not been recorded.

Implemented Sprint 3 migration:

1. Read and preserve the raw localStorage payload as a recoverable backup.
2. Validate every legacy lesson/progress record without mutating either store.
3. Generate stable lesson UUIDs and map both progress-key variants.
4. Import all valid records in one or more explicit transactions with a migration receipt.
5. Show a preview/result to the user, including skipped records and conflicts.
6. Switch reads only after verification; retain localStorage until a separately approved cleanup step.
7. Make the process idempotent so retry cannot duplicate lessons.

Theme and temporary UI state may remain in localStorage. Lessons, durable progress, SRS state and application data should eventually live in SQLite.

## 8. Backup and recovery

For a safe manual backup while the app is stopped, copy the database file from the configured data directory. If backing up while the app is running in WAL mode, use a SQLite-aware online backup/checkpoint procedure; copying only the main file can miss committed pages still in `-wal`.

Do not store backups inside `.next`, the portable app directory or the source repository. A future UI backup feature should use SQLite's backup API, write to a temporary file, verify it, then atomically publish the backup.

## 9. Portable packaging status and risks

- `node:sqlite` is compiled into the Node executable, so there is no separate addon binding to trace/copy.
- The build script resolves the installed `node.exe`, requires major version 24+, and bundles that exact executable.
- The Windows PowerShell build accepts `-PythonSource` and `-TtsSource`; environment fallbacks are `PORTABLE_PYTHON_SOURCE` and `KOKORO_TOOL_DIR`, followed by repository-relative runtime directories.
- Before building, it validates `python.exe`, Kokoro site-packages, server script, model and voice files, and reports the exact missing path with a non-zero exit.
- `.env.local`, API keys and development databases are no longer copied by the portable build script.
- The portable launcher stores data under Local AppData rather than the artifact.
- Next standalone build includes the API route code and treats `node:sqlite` as a built-in module.

Example:

```powershell
.\tools\build_portable.ps1 `
  -PythonSource "D:\PortableRuntime\Python" `
  -TtsSource "D:\Kokoro"
```

The artifact allow-list is the standalone app/static/public assets, Node, Python, Kokoro dependencies/server/model/voices, and launchers. Environment files, `.data`, SQLite files, audio cache, logs, personal backups and API keys must remain outside the artifact. Kokoro health is `http://127.0.0.1:5050/health`.

Remaining risk: Node's v24 documentation currently labels `node:sqlite` release-candidate stability. Portable correctness still requires a clean extracted-artifact smoke test on Windows 10/11, including first-run DB creation, health response, CRUD, restart persistence, no database/API key in ZIP, and behavior under a non-ASCII Windows username.
