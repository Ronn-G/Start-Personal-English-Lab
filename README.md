# Personal English Lab

Ứng dụng cá nhân để tạo bài học tiếng Anh từ transcript YouTube. Dữ liệu bài học, tiến độ và metadata audio cache được lưu trong SQLite; Kokoro ONNX chạy local và Web Speech API là phương án dự phòng.

## Chạy ứng dụng

Yêu cầu Node.js 24 trở lên vì tầng SQLite dùng `node:sqlite`.

```powershell
npm.cmd install
npm.cmd run dev
```

Mở `http://localhost:3000`.

Để dùng Gemini, tạo `.env.local` (file này không được đóng gói vào portable):

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.5-flash
```

## Kokoro TTS local

Cấu hình thư mục Kokoro, trong đó có `.venv\Scripts\python.exe`, model và voices:

```powershell
$env:KOKORO_TOOL_DIR = "D:\Kokoro"
npm.cmd run tts:kokoro
```

Hoặc chỉ định riêng từng file:

```powershell
$env:KOKORO_PYTHON_PATH = "D:\PythonEnvs\kokoro\Scripts\python.exe"
$env:KOKORO_MODEL_PATH = "D:\Kokoro\models\kokoro-v1.0.onnx"
$env:KOKORO_VOICES_PATH = "D:\Kokoro\models\voices-v1.0.bin"
npm.cmd run tts:kokoro
```

Kiểm tra health tại `http://127.0.0.1:5050/health`. Nếu Kokoro không chạy, nút nghe trong ứng dụng tự động dùng Web Speech API.

## Kiểm tra

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd test
npm.cmd run smoke:storage
npm.cmd run smoke:backup
npm.cmd run smoke:audio
npm.cmd run smoke:speaking
```

Các npm smoke scripts chạy được trên Windows, Linux và macOS. Các script `.ps1` dùng để build/khởi động portable chỉ dành cho Windows PowerShell.

## Build portable trên Windows

Truyền đường dẫn trực tiếp:

```powershell
.\tools\build_portable.ps1 `
  -PythonSource "D:\PortableRuntime\Python" `
  -TtsSource "D:\Kokoro"
```

Hoặc dùng biến môi trường:

```powershell
$env:PORTABLE_PYTHON_SOURCE = "D:\PortableRuntime\Python"
$env:KOKORO_TOOL_DIR = "D:\Kokoro"
.\tools\build_portable.ps1
```

`PythonSource` phải chứa `python.exe`. `TtsSource` phải chứa `.venv\Lib\site-packages`, `models\kokoro-v1.0.onnx` và `models\voices-v1.0.bin`. Tham số dòng lệnh được ưu tiên, sau đó là biến môi trường, rồi các thư mục tương đối `runtime\python` và `tts` trong repository. Thiếu dependency sẽ làm script dừng trước khi build/copy.

Portable gồm standalone app, static/public assets, `node.exe`, Python runtime, Kokoro dependencies, server script, model, voice và launcher. Portable tuyệt đối không gồm `.env`, `.env.local`, `.data`, SQLite cá nhân, audio cache, logs hoặc backup cá nhân. Launcher lưu dữ liệu mới trong `%LOCALAPPDATA%\PersonalEnglishLab`.

## Tài liệu

- [Kiến trúc lưu trữ](docs/storage-architecture.md)
- [Backup và khôi phục](docs/backup-and-restore.md)
- [Audio cache](docs/audio-cache.md)
- [Guided Speaking Ladder](docs/guided-speaking-ladder.md)
