# Personal English Lab

Ứng dụng local-first tạo bài học tiếng Anh từ transcript. App dùng Next.js 16 App Router,
React 19, TypeScript và SQLite qua `node:sqlite`.

## Phát triển

Yêu cầu Node.js 24 trở lên.

```powershell
npm install
npm run dev:full
```

`dev:full` đọc cấu hình Kokoro từ `.env.local`, kiểm tra Python/model/voices, chờ health
thành công rồi chạy Next.js. Chạy riêng Kokoro bằng `npm run tts:kokoro`.

```powershell
Invoke-RestMethod http://127.0.0.1:5050/health
Test-NetConnection 127.0.0.1 -Port 5050
```

Mọi nút nghe dùng chung lifecycle Kokoro-first: preparing, ready, browser fallback hoặc failed đều
được hiển thị. Browser voice chỉ chạy sau typed Kokoro preparation failure từ thao tác Play; lỗi
media/cancellation/storage không fallback, và `Retry Kokoro` chỉ chuẩn bị lại Kokoro.

Entry point nằm trong `src/app`; UI ở `src/components`; domain/client helpers ở `src/lib`;
SQLite, backup và audio cache ở `src/server`; kiểu dữ liệu ở `src/types`. Công cụ và test nằm
trong `tools` và `test`.

Tạo `.env.local` nếu dùng Gemini:

```env
GEMINI_API_KEY=your_key
GEMINI_MODEL=gemini-3.5-flash
```

Thêm cấu hình Kokoro vào cùng file bằng path local của máy, dựa trên placeholder trong
`.env.example`. Nếu launcher dừng sớm, kiểm tra lần lượt Python executable, model, voices, port
5050 và `.logs/kokoro-dev.stderr.log`. Lỗi import Python/ONNX xuất hiện trong log; health timeout
không được báo thành công giả.

## Dữ liệu, backup và audio

SQLite trong data directory là nguồn dữ liệu chính. `localStorage` chỉ còn phục vụ migration dữ
liệu cũ và theme. Database schema hiện là 11; lesson schema và progress schema là 1. Xóa lesson là
soft delete.

Backup version 2 hỗ trợ Merge và Replace, có SHA-256 checksum, gồm lesson, source/transcript,
progress, Speaking, Listening và Re-listen bookmarks. Backup v1 cũ vẫn import được với cảnh báo
source rỗng. Backup không gồm audio cache, API key, environment, machine path hay metadata nhạy cảm.
Xem [backup and restore](docs/backup-and-restore.md).

Kokoro chạy local tại `127.0.0.1:5050`; app lưu WAV và metadata trong audio cache. Server queue và
Python synthesis lock serialize model calls. App health ở `/api/audio/health`; Web Speech chỉ là
fallback có nhãn sau lỗi prepare Kokoro. Xem [audio lifecycle](docs/audio-cache.md).

Speaking Ladder hiện tại là Read → Recall → Keywords → Personalize → Free Speak. Việc đổi ladder
hoặc thêm Shadow không thuộc baseline này.

Immersion Listening Loop chạy trước Speaking Ladder: First Listen → Check Meaning → Second Listen →
Sentence Review → Final Re-listen. Session, transcript reveal theo phiên và sentence counters được
lưu trong SQLite; Check Meaning và Sentence Review không có đánh giá theo từng câu. `Save for
re-listen` là bookmark rõ nghĩa, không phải difficulty rating; dashboard Re-listen chỉ hiện câu đã
lưu. Các field recognition/difficult cũ được giữ để tương thích nhưng app mới không ghi hoặc hiển
thị. Audio luyện nghe là Kokoro practice audio từ transcript/câu đã lưu, không được trình bày như
original YouTube audio.

Tiến độ học được lưu trong SQLite theo stable item UUID. Lật thẻ từ vựng đánh dấu item là `learned`;
mở tab chỉ ghi `visited` và UI hiển thị “Đã xem”, không xem đó là hoàn thành. Quiz, vocabulary,
section visit và Active Practice dùng các command cập nhật transaction phía server để tránh ghi đè
lẫn nhau. Active Practice chỉ lưu câu trả lời sau khi nhận feedback thành công và giữ tối đa 20 bản
ghi gần nhất mỗi lesson. Các trạng thái này được phục hồi khi reload hoặc quay lại lesson.

## Verification

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

Portable packaging được hoãn tới final release sprint sau khi app hoàn thiện chức năng.

Portable packaging remains deferred until the final release sprint.

## Tài liệu

- [Kiến trúc hiện tại](docs/current-architecture.md)
- [Storage](docs/storage-architecture.md)
- [Backup và restore](docs/backup-and-restore.md)
- [Audio cache](docs/audio-cache.md)
- [Speaking Ladder](docs/guided-speaking-ladder.md)
- [Immersion Listening Loop](docs/immersion-listening-loop.md)
- [Development checklist](docs/development-checklist.md)
- [Versioning và release](docs/versioning-and-release.md)
- [License review](docs/license-review-needed.md)
