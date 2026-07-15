# Personal English Lab — Tài liệu bàn giao cho AI và lập trình viên

> Trạng thái tài liệu: 2026-07-15  
> Sản phẩm được mô tả: **Personal English Lab** trong thư mục `fluent/`  
> Phiên bản hiện tại: **0.1.0** (nguồn: `package.json`)  
> Mức ổn định: **prototype cá nhân / local-first**, chưa nên coi là bản production công cộng.

## 1. Mục tiêu sản phẩm

Personal English Lab là web app học tiếng Anh dành cho người Việt. Người dùng dán transcript YouTube, sau đó:

1. Tạo bài học tự động bằng Gemini API; hoặc copy prompt sang ChatGPT/Gemini, nhận JSON rồi dán ngược vào app.
2. Học từ vựng, thành ngữ/cụm khẩu ngữ, câu ví dụ, ngữ pháp, shadowing, sentence mining, lịch ôn và thẻ Anki.
3. Làm quiz và lưu tiến độ trong trình duyệt.
4. Luyện viết hoặc luyện nói, gửi câu trả lời tới Gemini để nhận phản hồi.
5. Nghe tiếng Anh qua Kokoro ONNX chạy hoàn toàn trên máy; nếu Kokoro lỗi thì dùng Web Speech API của trình duyệt.

Ứng dụng không tự lấy transcript từ YouTube. Transcript phải do người dùng tự dán.

## 2. Phạm vi và cấu trúc repository

- `fluent/`: mã nguồn chính của **Personal English Lab**; đây là thư mục cần sửa khi phát triển app tiếng Anh.
- `fluent-chinese/`: biến thể học tiếng Trung, là sản phẩm anh em nhưng không thuộc phạm vi tài liệu này.
- `Personal-English-Lab-Portable/`: artifact đã build, không phải source of truth.
- `Personal-English-Lab-Portable.zip`: gói phát hành hiện tại.

Không sửa trực tiếp file trong artifact portable rồi kỳ vọng thay đổi còn tồn tại. Mọi thay đổi phải thực hiện trong `fluent/`, kiểm tra, sau đó build lại portable.

## 3. Kiến trúc kỹ thuật

### Stack

- Next.js `16.2.7`, App Router, output `standalone`
- React/React DOM `19.2.4`
- TypeScript `5.x`
- Tailwind CSS `4.x`
- Node.js cho Next.js server
- Python 3.12 và `kokoro_onnx` cho TTS cục bộ
- Gemini REST API tại `generativelanguage.googleapis.com/v1beta`
- Không có database, tài khoản người dùng hoặc dịch vụ backend riêng

### Các phần chính

- `src/components/LessonGenerator.tsx`: nhập transcript, tạo/copy prompt, parse JSON thủ công, thư viện bài đã lưu.
- `src/components/LessonDisplay.tsx`: hiển thị bài học và quản lý tiến độ.
- `src/components/lesson/*`: từ vựng, ngữ pháp, quiz, deep practice, nghe và luyện tập chủ động.
- `src/app/api/generate-lesson/route.ts`: kiểm tra transcript và gọi Gemini tạo bài.
- `src/app/api/practice-feedback/route.ts`: gọi Gemini chấm phần luyện viết/nói.
- `src/lib/openai.ts`: prompt, gọi Gemini, parse và kiểm tra cấu trúc JSON. Tên file là di sản; implementation hiện tại dùng Gemini, không dùng OpenAI API.
- `tools/kokoro_server.py`: HTTP server TTS local (`127.0.0.1:5050`).
- `tools/start_app.ps1`: chạy môi trường phát triển và TTS trên máy tác giả.
- `tools/build_portable.ps1`: build và đóng gói bản Windows portable.
- `tools/portable_start.ps1`: khởi động gói portable.

### Luồng dữ liệu

```text
Transcript người dùng
  ├─ luồng thủ công → clipboard → ChatGPT/Gemini → JSON → parse tại trình duyệt
  └─ luồng tự động → POST /api/generate-lesson → Gemini API → Lesson JSON

Lesson JSON → giao diện → localStorage (bài học + tiến độ)

Văn bản cần nghe → POST http://127.0.0.1:5050/tts → WAV trong RAM
                                      └─ lỗi → Web Speech API

Câu luyện viết/nói → POST /api/practice-feedback → Gemini API → phản hồi JSON
```

## 4. Hợp đồng dữ liệu quan trọng

Kiểu dữ liệu chuẩn nằm tại `src/types/lesson.ts`. Một `Lesson` gồm:

- `title`, `summary`
- đúng 20 mục `vocabulary`
- `idiomsAndSlang`
- đúng 5 `exampleSentences`
- đúng 5 câu `quiz`, mỗi câu có 4 lựa chọn và `correctAnswer` từ 0 đến 3
- `deepPractice`: 3 bước + 3 câu shadowing, 3 sentence-mining item, lịch Day 1/2/4/7 và 5 thẻ Anki

Khi thay schema, AI tiếp quản phải sửa đồng bộ:

1. `src/types/lesson.ts`.
2. Prompt và validator trong `src/lib/openai.ts`.
3. Prompt và validator thủ công trong `src/components/LessonGenerator.tsx`.
4. Component hiển thị tương ứng.
5. Dữ liệu cũ trong `localStorage` hoặc cơ chế migration.

Hiện chưa có trường `schemaVersion`; nếu schema tiếp tục thay đổi, nên thêm trường này và viết migration trước khi phát hành.

## 5. Cấu hình và biến môi trường

Tạo `.env.local` từ `.env.example`:

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.5-flash
```

- `GEMINI_API_KEY` bắt buộc với luồng tạo tự động và chấm bài.
- `GEMINI_MODEL` không bắt buộc; code hiện mặc định là `gemini-3.5-flash`.
- Khóa chỉ được đọc ở server-side. Không thêm biến có khóa vào client bundle hoặc prefix `NEXT_PUBLIC_`.
- `.env*` đã được gitignore.

Lưu ý: tên model mặc định có thể thay đổi hoặc không khả dụng theo tài khoản/khu vực. Trước mỗi release phải xác nhận model thực tế với Gemini API và đặt rõ trong `.env.local`.

## 6. Yêu cầu phần cứng và phần mềm

### Bản portable dành cho người dùng (mức tối thiểu đề xuất)

- Windows 10/11 64-bit.
- CPU x64 2 nhân, hỗ trợ AVX/AVX2; 4 nhân được khuyến nghị để TTS nhanh hơn.
- RAM: tối thiểu 4 GB; khuyến nghị 8 GB.
- Dung lượng trống: tối thiểu 2.5 GB để giải nén và chạy. Artifact hiện tại khoảng **1.71 GB** sau giải nén và **741 MB** dạng ZIP.
- Trình duyệt Chromium mới (Chrome hoặc Edge). Speech recognition phụ thuộc trình duyệt và quyền microphone.
- Loa/tai nghe; microphone chỉ cần cho luyện nói.
- Internet cho Gemini API hoặc luồng ChatGPT/Gemini thủ công. TTS Kokoro và bài đã lưu có thể chạy local.

Các con số RAM/CPU là ngưỡng vận hành đề xuất, chưa được xác nhận bằng benchmark trên ma trận thiết bị. Trước release công cộng cần test máy cấu hình thấp và cập nhật lại.

### Máy phát triển

- Windows và PowerShell (các script build hiện chứa đường dẫn Windows tuyệt đối).
- Node.js tương thích Next.js 16 và npm.
- Khoảng 4 GB dung lượng trống cho dependencies, build và artifact.
- Để chạy TTS theo script hiện tại: môi trường Python/model tại `L:\tts_tool`.
- Để build portable theo script hiện tại: Node ở `C:\Program Files\nodejs\node.exe`, Python runtime bundled tại đường dẫn Codex cache ghi trong script, và TTS source tại `L:\tts_tool`.

Các đường dẫn tuyệt đối khiến build chưa tái lập được trên máy khác. Nên chuyển chúng thành tham số script hoặc biến môi trường trước khi mở rộng đội phát triển.

## 7. Chính sách dữ liệu và quyền riêng tư

### Dữ liệu lưu trên máy

- Tối đa 30 bài học được lưu trong `localStorage` với key `personal-english-lab-saved-lessons`.
- Tiến độ từ vựng/quiz lưu trong `localStorage` theo key sinh từ bài học.
- Theme lưu trong `localStorage` với key `personal-english-lab-theme`.
- Không có đồng bộ cloud, tài khoản, mã hóa ở tầng ứng dụng, backup hay khôi phục tự động.
- Xóa dữ liệu trang/site data của trình duyệt sẽ xóa bài học và tiến độ. Dữ liệu cũng không tự chuyển giữa trình duyệt/máy.

### Dữ liệu gửi ra ngoài

- Khi dùng “Tạo bằng Gemini”, transcript (tối đa 14.000 ký tự sau khi cắt) được gửi tới Google Gemini.
- Khi xin phản hồi, tiêu đề bài, câu mẫu, chế độ và câu trả lời/transcript giọng nói được gửi tới Google Gemini.
- Luồng thủ công gửi dữ liệu tới dịch vụ AI mà người dùng chọn khi họ dán prompt/JSON.
- Web Speech Recognition có thể do nhà cung cấp trình duyệt xử lý trên cloud; app không kiểm soát chính sách của dịch vụ đó.
- Kokoro nhận văn bản qua loopback `127.0.0.1`, tạo WAV trong RAM và không chủ động lưu audio xuống đĩa.

### Cam kết/giới hạn hiện tại

- App không có telemetry, quảng cáo, cookie marketing hoặc analytics do dự án tự triển khai.
- Server hiện log độ dài transcript và trạng thái xử lý, không log toàn bộ transcript trong code chủ động.
- Không nên nhập dữ liệu cá nhân nhạy cảm, bí mật công ty hoặc nội dung cần bảo mật vào API AI bên thứ ba.
- API key là bí mật. **Script build hiện copy `.env.local` vào gói portable**, nên artifact có thể chứa khóa cá nhân. Không phát hành công khai ZIP như hiện tại. Với release chia sẻ, yêu cầu người nhận tự cấu hình khóa hoặc dùng backend/proxy quản lý secret.
- Chưa có màn hình consent/privacy policy trong app. Cần bổ sung trước khi phân phối cho người khác hoặc thu thập dữ liệu người chưa thành niên.

## 8. Xử lý lỗi hiện tại

### API tạo bài

- Transcript rỗng hoặc dưới 200 ký tự: HTTP 400.
- Transcript trên 14.000 ký tự: tự cắt, không từ chối request.
- Thiếu `GEMINI_API_KEY`: HTTP 500.
- Gemini trả lỗi, JSON sai hoặc sai schema: HTTP 422.
- Client hiển thị thông báo lỗi trả về và luôn reset trạng thái loading trong `finally`.

### API phản hồi luyện tập

- Thiếu câu mẫu/câu trả lời hoặc câu trả lời dưới 8 ký tự: HTTP 400.
- Thiếu key: HTTP 500; lỗi sinh/parse nội dung: HTTP 422.
- Điểm AI được làm tròn và ép vào khoảng 1–10; mảng góp ý được giới hạn số phần tử.

### TTS và giọng nói

- Request Kokoro timeout sau 30 giây.
- Nếu Kokoro không chạy hoặc phát audio lỗi, app log lỗi ở console và fallback sang `speechSynthesis`.
- TTS server giới hạn 650 ký tự, cắt phần vượt quá.
- Speech recognition lỗi hoặc không được hỗ trợ: người dùng có thể gõ câu trả lời.

### Lỗ hổng cần bổ sung

- Chưa có retry/backoff cho Gemini, phân loại timeout/rate-limit, request ID hoặc structured logging.
- Chưa có error boundary toàn app, monitoring hay crash reporting.
- Parser JSON mới kiểm tra một phần schema; nên dùng Zod/JSON Schema và trả lỗi theo field.
- `localStorage` lỗi bị bỏ qua và trả mảng rỗng; người dùng có thể tưởng dữ liệu đã mất. Cần cảnh báo và chức năng export/import.
- Endpoint local không có auth. Next server mặc định phục vụ local; không bind ra mạng LAN khi chưa thêm kiểm soát.

## 9. Quy trình phát triển và kiểm tra

```powershell
cd fluent
npm.cmd install
Copy-Item .env.example .env.local
# điền GEMINI_API_KEY nếu cần test AI
npm.cmd run dev
```

Mở `http://localhost:3000`. TTS có thể chạy riêng bằng `npm.cmd run tts:kokoro` khi môi trường `L:\tts_tool` tồn tại.

Trước khi chấp nhận thay đổi:

```powershell
npm.cmd run lint
npm.cmd run build
```

Checklist smoke test thủ công:

1. Mở trang, đổi theme và reload.
2. Dán transcript hợp lệ; kiểm tra cả luồng Gemini và luồng dán JSON thủ công.
3. Kiểm tra đủ các section, quiz, lưu/mở/xóa bài và reload vẫn còn tiến độ.
4. Nghe bằng Kokoro; tắt TTS server và xác nhận fallback trình duyệt.
5. Test luyện viết; test luyện nói có/không có quyền microphone.
6. Test transcript rỗng, quá ngắn, quá dài, JSON hỏng, Gemini key sai và model sai.

Hiện chưa có unit/integration/E2E test. Với thay đổi lớn, ưu tiên thêm test cho validator/schema, API status và migration `localStorage`.

## 10. Quy trình version và release

### Quy ước phiên bản

Dùng Semantic Versioning:

- PATCH (`0.1.1`): sửa lỗi tương thích, không đổi schema/hành vi chính.
- MINOR (`0.2.0`): thêm tính năng tương thích ngược.
- MAJOR (`1.0.0` trở lên): thay đổi phá vỡ schema, dữ liệu hoặc quy trình sử dụng.

`package.json` là nguồn phiên bản chính. Mỗi release nên có `CHANGELOG.md`, tag Git `vX.Y.Z` và checksum SHA-256 của ZIP. Repository hiện chưa có commit/tag và chưa có changelog, do đó `0.1.0` là phiên bản khai báo chứ chưa phải release có thể truy vết đầy đủ.

### Build release portable hiện tại

1. Đảm bảo working tree chỉ chứa thay đổi dự định phát hành.
2. Cập nhật `package.json` và changelog.
3. Chạy lint, build và smoke test ở chế độ development.
4. Xử lý secret: không để khóa cá nhân trong `.env.local` của artifact chia sẻ.
5. Chạy:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\build_portable.ps1
```

Script sẽ:

- chạy `npm.cmd run build`;
- lấy `.next/standalone`, `.next/static` và `public`;
- bundle `node.exe`, Python, Kokoro dependencies và model;
- tạo launcher `.bat`/`.vbs`;
- tạo `Personal-English-Lab-Portable/` và ZIP ở thư mục cha.

6. Giải nén ZIP vào một thư mục sạch trên máy test không có Node/Python.
7. Chạy `Start Personal English Lab.bat` để xem lỗi; sau đó test `Start Personal English Lab.vbs`.
8. Xác nhận app ở `http://localhost:3000`, health TTS ở `http://127.0.0.1:5050/health` và các smoke test phía trên.
9. Quét ZIP để chắc chắn không có `.env.local`, API key, log, cache hoặc dữ liệu người dùng.
10. Tạo SHA-256, tag Git và lưu artifact bất biến.

PowerShell tạo checksum:

```powershell
Get-FileHash ..\Personal-English-Lab-Portable.zip -Algorithm SHA256
```

### Tiêu chí rollback

- Giữ lại ZIP và tag của ít nhất một phiên bản ổn định trước đó.
- Rollback bằng cách phân phối lại artifact cũ; app hiện không có auto-update.
- Nếu release đổi schema `localStorage`, phải có migration tiến và kế hoạch đọc dữ liệu cũ. Không xóa dữ liệu người dùng âm thầm.

## 11. Quy tắc cho AI tiếp quản

1. Đọc `AGENTS.md` trước khi sửa. Next.js trong repo có quy tắc phiên bản riêng; đọc guide liên quan trong `node_modules/next/dist/docs/` trước khi dùng API/convention Next.js.
2. Coi `fluent/` là source of truth; không sửa artifact portable trực tiếp.
3. Giữ UI và nội dung hướng tới người Việt học tiếng Anh, trừ khi yêu cầu sản phẩm thay đổi rõ ràng.
4. Không làm lộ API key trong source, log, client bundle, ảnh chụp hay artifact.
5. Khi đổi schema bài học, sửa toàn bộ producer, validator, type, consumer và migration như mục 4.
6. Không làm mất bài/tiến độ đã lưu; luôn xem xét tương thích `localStorage`.
7. Giữ Kokoro là local-first và giữ fallback Web Speech hoạt động.
8. Chạy ít nhất `npm.cmd run lint` và `npm.cmd run build`; ghi rõ phần nào chưa thể test.
9. Không khẳng định app “offline hoàn toàn”: Gemini và speech recognition có thể cần Internet.
10. Sau thay đổi liên quan release, build từ source và test artifact sạch, không chỉ test dev server.

## 12. Backlog ưu tiên

1. Loại `.env.local` khỏi gói chia sẻ và thiết kế màn hình cấu hình key an toàn hoặc backend proxy.
2. Tham số hóa đường dẫn build/TTS, loại phụ thuộc vào máy tác giả.
3. Thêm `schemaVersion`, migration và export/import/backup bài học.
4. Thêm JSON Schema/Zod và test tự động.
5. Thêm privacy notice/consent trước khi gửi transcript hoặc câu trả lời ra ngoài.
6. Thêm retry có giới hạn, timeout Gemini và thông báo riêng cho 401/403/429/5xx.
7. Thiết lập Git history, changelog, tag, CI build và checksum release.
8. Benchmark phần cứng tối thiểu thực tế và kiểm tra Windows Defender/SmartScreen cho gói portable.

