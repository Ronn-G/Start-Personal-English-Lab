# Personal English Lab — AI handoff

Backup Integrity v2 raises SQLite to schema 11 and backup format 2. Backup now round-trips the exact
lesson source/transcript columns, validates Speaking payloads independently from checksum, remaps
all source identities transactionally, and verifies restored data before commit. Schema v11 adds
safe CHECK constraints for Speaking counters, index, status/source, and the existing five steps;
it does not change the Speaking Ladder state machine. Backup v1 remains importable with an explicit
empty-source warning.

Immersion Listening Loop bookmarks were added in schema 9; schema 10 added typed audio recovery
metadata without deleting cache data. `/api/listening`, `ListeningService` and
`ListeningPractice` add resumable First Listen → Check Meaning → Second Listen → Sentence Review →
Final Re-listen without replacing Speaking Ladder. Listening items derive from stable Lesson v1
source UUIDs. Check Meaning and Sentence Review share the visible Kokoro-first audio lifecycle and
contain no per-sentence assessment. `saved_for_relisten` remains optional for old backups. Run
`npm run smoke:listening` with the suite.

Personal English Lab `0.1.0` là prototype local-first dùng Next.js App Router, React, TypeScript
và Node.js 24. Source of truth là repository này; không sửa artifact portable.

## Bản đồ code

- `src/app`: pages, layout và API route.
- `src/components`: UI và learning flow.
- `src/lib`: lesson/progress/speaking domain và client helpers.
- `src/server`: SQLite repository, migration, backup và audio cache.
- `src/types`: canonical lesson types.
- `tools`: local smoke tests và tooling.
- `test`: Node test suite.

SQLite là nguồn dữ liệu chính. Database schema 11, lesson schema 1, progress schema 1 và backup
version 2. `localStorage` chỉ dùng cho migration legacy và theme. Không đổi schema, backup format,
API contract hay persisted data nếu sprint không yêu cầu migration rõ ràng.

Backup dùng SHA-256, hỗ trợ merge/replace, gồm speaking progress và active session, không gồm audio
cache hoặc secret. Speaking Ladder hiện là Read → Recall → Keywords → Personalize → Free Speak.
Không tự thêm Shadow hoặc đổi thứ tự.

Sprint 8 đã tái sử dụng Progress v1: `learningItems` lưu vocabulary review theo UUID,
`visitedSections` lưu stable section key, và `practiceHistory` lưu Active Practice writing/speaking.
Client gửi command nhỏ qua `PATCH /api/storage/lessons/[id]/progress`; repository read-modify-write
trong `BEGIN IMMEDIATE`, nên quiz và các learning activity không ghi đè nhau. History chỉ được tạo
sau feedback thành công, có feedback typed đầy đủ và bị giới hạn ở 20 record mới nhất. Không có
SQLite migration riêng ở sprint đó; Progress schema vẫn là v1 backward-compatible.

Audio ưu tiên Kokoro local, có disk cache, process-wide concurrency-1 queue và Python synthesis
lock. Web Speech chỉ nằm trong `useAppAudio` và chỉ fallback sau typed Kokoro prepare failure.

Development đầy đủ chạy bằng `npm run dev:full`. Launcher đọc `KOKORO_*` từ `.env.local`, validate
runtime, chờ model-ready health và chỉ cleanup process do chính nó tạo. Chạy riêng TTS bằng
`npm run tts:kokoro`. Audio UI báo preparing/ready/browser/failed; `Retry Kokoro` là manual
Kokoro-only recovery, không phát hoặc fallback.

## Verification bắt buộc

```powershell
npm run format:check
npm run lint
npm test
npm run smoke:storage
npm run smoke:backup
npm run smoke:audio
npm run smoke:speaking
npm run smoke:listening
npm run build
```

Không commit `.env`, `.data`, SQLite, audio cache, logs, backup cá nhân, model hoặc ZIP. Portable
packaging được hoãn tới final release sprint sau khi app hoàn thiện chức năng.

Portable packaging remains deferred until the final release sprint.

Xem `docs/development-checklist.md`, `docs/versioning-and-release.md` và các tài liệu kiến trúc
trong `docs/` trước khi thay đổi.
