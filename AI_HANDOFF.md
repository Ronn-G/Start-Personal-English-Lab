# Personal English Lab — AI handoff

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

SQLite là nguồn dữ liệu chính. Database schema 7, lesson schema 1, progress schema 1 và backup
version 1. `localStorage` chỉ dùng cho migration legacy và theme. Không đổi schema, backup format,
API contract hay persisted data nếu sprint không yêu cầu migration rõ ràng.

Backup dùng SHA-256, hỗ trợ merge/replace, gồm speaking progress và active session, không gồm audio
cache hoặc secret. Speaking Ladder hiện là Read → Recall → Keywords → Personalize → Free Speak.
Không tự thêm Shadow hoặc đổi thứ tự.

Audio ưu tiên Kokoro local, có disk cache và fallback Web Speech ở client. Smoke tests không cần
Kokoro model thật.

## Verification bắt buộc

```powershell
npm run format:check
npm run lint
npm test
npm run smoke:storage
npm run smoke:backup
npm run smoke:audio
npm run smoke:speaking
npm run build
```

Không commit `.env`, `.data`, SQLite, audio cache, logs, backup cá nhân, model hoặc ZIP. Portable
packaging được hoãn tới final release sprint sau khi app hoàn thiện chức năng.

Xem `docs/development-checklist.md`, `docs/versioning-and-release.md` và các tài liệu kiến trúc
trong `docs/` trước khi thay đổi.
