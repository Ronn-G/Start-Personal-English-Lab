# Personal English Lab

App ca nhan de tao bai hoc tieng Anh tu transcript YouTube ban tu copy.

## Cach dung voi ChatGPT Plus

1. Dan transcript vao app.
2. Bam **Copy prompt cho ChatGPT**.
3. Dan prompt sang ChatGPT Plus.
4. Copy JSON ChatGPT tra ve.
5. Dan JSON vao app va bam **Hien thi bai hoc**.

## Chay app

Nhan dup file nay de chay ca app va Kokoro TTS:

```text
Start Personal English Lab.vbs
```

Neu muon xem log khi chay, dung file:

```text
Start Personal English Lab.bat
```

Hoac chay thu cong:

```powershell
npm.cmd install
npm.cmd run dev
```

Node.js 24 tro len la bat buoc vi tang luu tru SQLite dung `node:sqlite`.

Mo:

```text
http://localhost:3000
```

## Giong doc Kokoro local

App uu tien dung Kokoro ONNX local o:

```text
http://127.0.0.1:5050/tts
```

Chay Kokoro server:

```powershell
npm.cmd run tts:kokoro
```

Server nay dung model va voice file co san tren may:

```text
L:\tts_tool\models\kokoro-v1.0.onnx
L:\tts_tool\models\voices-v1.0.bin
```

Voice mac dinh:

```text
af_sarah
```

Neu Kokoro server chua chay, nut nghe trong app se tu dong fallback ve Web Speech API cua trinh duyet.

## Tuy chon Gemini API Free

Tao API key mien phi tren Google AI Studio, sau do tao file `.env.local`:

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.5-flash
```

Sau do co the dung nut **Tao bang Gemini** trong app.

## Kiem tra

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run smoke:storage
```

## SQLite storage (Sprint 1)

Tang SQLite server-side da co API va migration, nhung giao dien hien tai van dung
localStorage. Sprint nay khong tu dong di chuyen hoac xoa bai hoc cu.

Development mac dinh tao database trong `.data`. Co the chon thu muc ghi duoc:

```env
PERSONAL_ENGLISH_LAB_DATA_DIR=C:\path\to\writable\data
```

Khi server dang chay, kiem tra storage:

```text
GET http://localhost:3000/api/storage/health
```

Xem `docs/storage-architecture.md` de biet schema, backup va ke hoach migration Sprint 3.
