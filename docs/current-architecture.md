# Personal English Lab - Current Architecture Baseline

> Baseline khảo sát ngày 2026-07-15 cho source trong `fluent/`. Sprint 1 đã bổ sung nền tảng SQLite song song; UI vẫn dùng localStorage và chưa migrate dữ liệu cũ.

## 1. Phạm vi và trạng thái repository

- Stack: Next.js 16.2.7 App Router, React 19.2.4, TypeScript 5, Tailwind CSS 4, output `standalone`.
- `fluent/` là source of truth. Bản portable và ZIP ở thư mục cha là artifact, không thuộc phạm vi chỉnh sửa.
- Repository Git tồn tại, branch hiện tại là `main`, có lịch sử commit và remote `origin`; chưa có tag.
- Working tree đã có nhiều file modified/deleted/untracked trước Sprint 0. File baseline này không nhận quyền sở hữu các thay đổi đó.
- Không tìm thấy unit test, integration test hoặc E2E test; `package.json` cũng không có script `test`.
- Không tìm thấy cấu hình CI trong `.github/workflows`, GitLab CI, Azure Pipelines hoặc Jenkins.
- Không có `CHANGELOG.md`.
- Baseline trước khi thêm tài liệu: `npm.cmd run lint` pass; `npm.cmd run build` pass.
- Sprint 1 thêm SQLite schema version 1, migration engine, repository/API/client service và test nền tảng. Đây chưa phải đường lưu mặc định của UI.

## 2. Bản đồ luồng dữ liệu

```text
Transcript người dùng nhập tại LessonGenerator
  |
  +-- Luồng thủ công
  |     buildChatGptPrompt(transcript.trim())
  |       -> clipboard -> ChatGPT/Gemini do người dùng chọn
  |       -> JSON dán lại vào textarea
  |       -> stripJsonFences -> JSON.parse -> parsePastedLesson
  |       -> showLesson -> persistLesson -> localStorage
  |
  +-- Luồng tự động
        POST /api/generate-lesson { transcript }
          -> trim + kiểm tra rỗng/tối thiểu 200 ký tự
          -> truncateTranscript ở 14.000 ký tự
          -> generateLesson
          -> Gemini generateContent (server-side GEMINI_API_KEY)
          -> stripJsonFences -> JSON.parse -> parseLesson
          -> response { lesson }
          -> showLesson -> persistLesson -> localStorage

SavedLesson/GenerateLessonResponse
  -> LessonDisplay
     +-- VocabularyCards: lật thẻ, trạng thái reviewedWords chỉ trong memory
     +-- IdiomsSection: render thành ngữ
     +-- GrammarSection: render 5 example sentences
     +-- DeepPracticeSection
     |    +-- shadowing, sentence mining, review plan, Anki cards (chỉ render)
     |    +-- ActivePracticeSection
     |         +-- writing: textarea
     |         +-- speaking: Web Speech Recognition -> transcript vào textarea
     |         +-- POST /api/practice-feedback -> Gemini -> parsePracticeFeedback
     +-- QuizSection: state câu hiện tại/đáp án/điểm trong memory
          -> callback onAnswer(questionIndex)
          -> LessonDisplay lưu answeredQuestions vào localStorage

Text cần đọc -> SpeakButton
  -> POST http://127.0.0.1:5050/tts
  -> Kokoro ONNX -> WAV trong memory -> object URL -> HTML Audio
  -> timeout 30 giây hoặc lỗi: hiện chỉ báo "Kokoro chưa chạy" và console.error

ThemeSwitcher/layout bootstrap
  -> đọc/ghi personal-english-lab-theme

Nền tảng song song từ Sprint 1 (chưa nối vào UI)
  storage-client -> /api/storage/* -> async repository -> node:sqlite
  -> PERSONAL_ENGLISH_LAB_DATA_DIR/personal-english-lab.sqlite3
```

### Sai lệch quan trọng giữa tài liệu cũ và code

`AI_HANDOFF.md` và `README.md` nói rằng TTS fallback sang Web Speech API. Code hiện tại trong `SpeakButton.tsx` không gọi `window.speechSynthesis`; vì vậy fallback phát âm này **không tồn tại trong runtime hiện tại**. Web Speech đang được dùng cho nhận dạng giọng nói (`SpeechRecognition`) trong luyện nói, không phải cho TTS. Sprint 0 chỉ ghi nhận, không sửa hành vi.

## 3. Schema TypeScript hiện tại

Nguồn chuẩn hiện tại là `src/types/lesson.ts`.

```ts
interface VocabularyItem {
  word: string;
  phonetic?: string;
  definition: string;
  vietnamese: string;
  context?: string;
}

interface IdiomItem {
  phrase: string;
  meaning: string;
  vietnamese: string;
  note?: string;
}

interface ExampleSentence {
  sentence: string;
  keyPhrase: string;
  vietnamese: string;
}

interface QuizQuestion {
  question: string;
  options: [string, string, string, string];
  correctAnswer: 0 | 1 | 2 | 3;
  explanation: string;
}

interface ShadowingLine {
  line: string;
  focus: string;
  vietnamese: string;
}

interface SentenceMiningItem {
  sentence: string;
  pattern: string;
  whyUseful: string;
  remixPrompt: string;
}

interface ReviewPlanItem {
  day: string;
  task: string;
}

interface AnkiCard {
  front: string;
  back: string;
  hint?: string;
}

interface DeepPractice {
  shadowingPractice: {
    steps: string[];
    lines: ShadowingLine[];
  };
  sentenceMining: SentenceMiningItem[];
  reviewPlan: ReviewPlanItem[];
  ankiCards: AnkiCard[];
}

interface Lesson {
  title: string;
  summary: string;
  vocabulary: VocabularyItem[];
  idiomsAndSlang: IdiomItem[];
  exampleSentences: ExampleSentence[];
  quiz: QuizQuestion[];
  deepPractice?: DeepPractice;
}

interface GenerateLessonResponse {
  lesson: Lesson;
  videoId?: string;
}

interface PracticeFeedback {
  score: number;
  overall: string;
  strengths: string[];
  corrections: string[];
  improvedVersion: string;
  nextStep: string;
}

interface PracticeFeedbackResponse {
  feedback: PracticeFeedback;
}
```

Không có `schemaVersion`. `deepPractice` là optional ở type để render được bài cũ, nhưng cả hai parser tạo bài mới đều yêu cầu phần này và đúng số lượng quy định.

## 4. Dữ liệu localStorage

| Key | Writer/reader | Cấu trúc đang lưu |
| --- | --- | --- |
| `personal-english-lab-saved-lessons` | `LessonGenerator.tsx` | JSON array `SavedLesson[]` |
| `personal-english-lab-progress:<lessonId>` | `LessonDisplay.tsx` | `{ "answeredQuestions": number[] }` |
| `personal-english-lab-progress:<title>:<summary>` | `LessonDisplay.tsx` fallback khi không có `lessonId` | Cùng cấu trúc progress ở trên |
| `personal-english-lab-theme` | `ThemeSwitcher.tsx`, bootstrap inline trong `layout.tsx` | Chuỗi `"a"`, `"b"` hoặc `"c"`; giá trị khác fallback về `"a"` |

`SavedLesson` hiện có dạng:

```ts
interface SavedLesson {
  id: string;
  lesson: Lesson;
  videoId?: string;
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}
```

Đặc điểm tương thích và lưu trữ:

- Bài mới từ cả hai luồng đều tự động được lưu trước khi render.
- Trùng bài được xác định bằng `lesson.title === title` và `lesson.summary === summary`; bài trùng giữ `id` và `createdAt`, cập nhật payload/`updatedAt`, rồi được đưa lên đầu danh sách.
- Lỗi đọc/parse saved lessons bị nuốt và trả `[]`; dữ liệu hỏng vẫn còn trong storage nhưng UI trông như thư viện rỗng.
- Ghi storage không có `try/catch`; quota/security error có thể làm gián đoạn thao tác.
- Chỉ `answeredQuestions` được persist. `reviewedWords`, `visitedTabs`, câu/điểm quiz, câu luyện tập và feedback chỉ nằm trong React state và mất khi remount/reload.
- Khi xóa lesson, code không xóa progress key tương ứng; có thể để lại dữ liệu mồ côi nhưng không làm mất progress của bài khác.
- Không có migration, backup, export hoặc import dữ liệu localStorage.
- SQLite có migration database riêng, nhưng chưa có migration từ localStorage sang SQLite.

## 5. ID và giới hạn

### Lesson ID

`createSavedLessonId()` trong `LessonGenerator.tsx` tạo:

```text
lesson-<Date.now()>-<6 ký tự base36 từ Math.random()>
```

Đây không phải UUID và không có kiểm tra collision. Khi bài có cùng title + summary, ID cũ được tái sử dụng.

### Vocabulary/progress ID

- Vocabulary item không có field ID. UI dùng `word` làm React key và dùng chính chuỗi `word` trong `Set<string>` để đánh dấu đã xem trong phiên hiện tại. Từ trùng nhau sẽ chia sẻ key/trạng thái.
- Quiz question không có field ID. Progress dùng index câu hỏi (`number`) trong `answeredQuestions`.
- Progress không có ID record riêng. Identity nằm trong localStorage key được ghép từ saved lesson ID, hoặc legacy fallback `title:summary`.
- Nếu thứ tự quiz thay đổi trong cùng lesson ID, các index cũ có thể trỏ sang câu khác.

### Giới hạn 30 lesson

- `MAX_SAVED_LESSONS = 30` trong `LessonGenerator.tsx`.
- `persistLesson()` prepends bài mới/cập nhật, lọc ID trùng, rồi `.slice(0, 30)`.
- `writeSavedLessons()` lại `.slice(0, 30)` trước khi stringify; đây là kiểm soát trùng lặp.
- Việc thêm bài thứ 31 âm thầm loại entry cuối (cũ nhất theo thứ tự mảng). Progress key của entry bị loại không được xóa.
- UI chỉ render `savedLessons.slice(0, 5)`, dù bộ đếm và storage có thể chứa 30 bài; hiện không có cách mở bài thứ 6-30 từ UI.

### Giới hạn transcript 14.000 ký tự

- Chỉ luồng tự động áp dụng tại `src/app/api/generate-lesson/route.ts`.
- Request được `trim()`, từ chối nếu rỗng hoặc dưới 200 ký tự.
- Nếu dài hơn 14.000, code lấy chính xác `text.slice(0, 14_000)` rồi nối `\n\n[Transcript truncated due to length.]` trước khi gửi Gemini. Vì có suffix, user prompt thực gửi dài hơn 14.000 ký tự.
- Client vẫn gửi toàn bộ transcript tới Next API; việc cắt xảy ra server-side.
- Luồng copy prompt thủ công không cắt và không kiểm tra tối thiểu 200 ký tự.

## 6. Parser và validator hiện có

### Dùng chung về hình thức

Cả `openai.ts` và `LessonGenerator.tsx` có bản sao riêng của `stripJsonFences()`: trim; nếu chuỗi bắt đầu bằng code fence thì bỏ fence đầu `json` optional và fence cuối; sau đó `JSON.parse`.

### Luồng Gemini tự động: `parseLesson`

Kiểm tra:

- truthy `title`;
- đúng 20 vocabulary;
- mọi vocabulary có `phonetic?.trim()`;
- đúng 5 example sentences;
- đúng 5 quiz questions;
- deep practice có 3 steps, 3 lines, 3 sentence-mining items, 4 review items, 5 Anki cards.

Không kiểm tra đầy đủ `summary`, `idiomsAndSlang`, kiểu/chuỗi bắt buộc của từng item, bốn option quiz, miền `correctAnswer`, day labels Day 1/2/4/7, ngôn ngữ nội dung hoặc dạng IPA `/.../`.

### Luồng JSON thủ công: `parsePastedLesson`

Kiểm tra:

- truthy `title` và `summary`;
- vocabulary là array đúng 20 và có phonetic;
- `idiomsAndSlang` là array;
- example sentences là array đúng 5;
- quiz là array đúng 5;
- `deepPractice` tồn tại;
- các array deep practice có số lượng 3/3/3/4/5.

Nó cũng không validate shape/nội dung từng phần tử, bốn options, `correctAnswer`, day labels hay ngôn ngữ.

### Practice feedback: `parsePracticeFeedback`

Kiểm tra score là number; `overall`, `improvedVersion`, `nextStep` truthy; strengths/corrections là array. Sau đó làm tròn và clamp score 1-10, lấy tối đa 3 strengths và 4 corrections. Không kiểm tra kiểu string của từng phần tử.

### API input validation

- `/api/generate-lesson`: body JSON, transcript rỗng/<200, cắt 14.000; lỗi thiếu key -> 500, lỗi khác trong catch -> 422.
- `/api/practice-feedback`: mode ngoài `speaking` trở thành `writing`; bắt buộc target/answer; answer tối thiểu 8 ký tự; lesson title fallback `English lesson`; thiếu key -> 500, lỗi khác -> 422.

## 7. Logic trùng giữa luồng thủ công và tự động

- Toàn bộ schema mô tả bằng text và phần lớn yêu cầu prompt bị copy giữa `buildChatGptPrompt()` và `SYSTEM_PROMPT`.
- `stripJsonFences()` bị copy nguyên hàm.
- Validation số lượng Lesson bị copy nhưng không hoàn toàn đồng nhất: parser thủ công kiểm tra `summary` và `idiomsAndSlang`; parser tự động không kiểm tra hai điểm này.
- Chuỗi lỗi khác nhau cho cùng một hợp đồng dữ liệu.
- TypeScript type là dùng chung, nhưng type assertion sau `JSON.parse` không tạo runtime validation.
- Cả hai luồng hội tụ tại `showLesson()` -> `persistLesson()` -> `LessonDisplay`, nên lưu/render là dùng chung.

## 8. Render, quiz, luyện viết/nói, TTS và Anki

- `LessonDisplay` có 5 tab: vocabulary, idioms, grammar, practice, quiz.
- Progress badge vocabulary dựa trên thẻ đã lật trong phiên. Idioms/grammar/practice được coi hoàn tất ngay khi tab đã được ghé, không persist.
- Quiz giữ current index, selected option, score và finished state trong component. Callback chỉ persist index câu đã trả lời, bất kể đúng/sai. “Làm lại” reset score UI nhưng không xóa answered indices đã persist.
- Luyện viết dùng textarea. Luyện nói dùng browser `SpeechRecognition`/`webkitSpeechRecognition` với `en-US`, một lượt, không interim; transcript nhận được được gửi như text tới Gemini khi người dùng xin feedback.
- `GEMINI_API_KEY` chỉ được đọc trong server module `src/lib/openai.ts`. Client chỉ gọi API route nội bộ. Baseline không đọc hoặc ghi giá trị `.env.local`.
- Kokoro client gọi loopback `127.0.0.1:5050`, voice `af_sarah`, lang `en-us`, timeout 30 giây. Python server cắt text đã normalize ở 650 ký tự, sinh WAV trong memory và bind mặc định loopback.
- Hiện không có Web Speech TTS fallback trong `SpeakButton` dù tài liệu nói có.
- Anki hiện chỉ là `AnkiCard[]` trong Lesson và danh sách render ở `DeepPracticeSection`; không có nút/file exporter (CSV/TSV/APKG), importer hay download.
- `videoId` có trong response/storage/render, nhưng hai producer hiện tại chỉ trả `{ lesson }`; không có logic trích video ID từ transcript, nên thumbnail/link thường không xuất hiện cho bài mới.

## 9. Điểm phải giữ tương thích

1. Không đổi/xóa key `personal-english-lab-saved-lessons` hoặc progress keys mà không có đọc legacy và migration tiến.
2. Không ghi đè storage bằng dữ liệu rỗng khi parse/migration thất bại; cần giữ raw payload và có đường phục hồi.
3. Giữ đọc được `SavedLesson` hiện tại không có `schemaVersion` và `Lesson.deepPractice` có thể thiếu ở bài cũ.
4. Giữ ID lesson hiện tại ổn định để progress key tiếp tục khớp.
5. Nếu thêm ID vocabulary/quiz, phải ánh xạ từ word/index cũ thay vì bỏ progress.
6. Producer thủ công, producer Gemini, runtime validator, types, renderer, migration và test phải đổi cùng nhau khi schema đổi.
7. Giữ nội dung/prompt hướng tới người Việt học tiếng Anh.
8. Giữ `GEMINI_API_KEY` server-side; không đưa vào biến `NEXT_PUBLIC_*`, client log hoặc artifact chia sẻ.
9. Giữ Kokoro local-first và khi khôi phục fallback Web Speech phải không làm Kokoro mất ưu tiên.
10. Không coi `videoId`, `deepPractice`, timestamps hoặc optional fields là luôn có khi đọc dữ liệu legacy.

## 10. Rủi ro trước Lesson schemaVersion, SRS và export/import

### Trước khi thêm `schemaVersion`

- Không thể phân biệt chắc chắn các thế hệ Lesson/SavedLesson; migration chỉ có thể suy đoán theo field.
- Hai validator lệch nhau có thể chấp nhận/từ chối cùng một payload khác nhau.
- Validator nông cho phép payload “đúng số lượng nhưng sai shape” đi tới renderer và gây runtime error.
- `deepPractice` optional trong type nhưng required ở producer mới tạo ra hợp đồng hai tầng cần được bảo toàn cho dữ liệu cũ.
- ID dựa trên thời gian/random và quiz progress dựa trên index không bền khi merge/reorder.

### Trước khi thêm SRS

- Vocabulary không có stable ID; word trùng/case/punctuation có thể collision.
- Chỉ lưu answered question indices, không có trạng thái học từ, lịch sử review, quality/grade, due date, interval, ease hay timezone policy.
- Giới hạn 30 bài có thể loại lesson trong khi SRS item còn tham chiếu tới nó.
- Progress hiện có thể nằm dưới key lesson ID hoặc key `title:summary`; cần migration hợp nhất không mất dữ liệu.
- “Đã xem tab/thẻ” hiện là heuristic UI, không phải bằng chứng recall; không nên chuyển thẳng thành SRS success.

### Trước khi thêm export/import

- Không có envelope/version/checksum; raw array hiện tại không đủ để xác minh file import.
- Cần định nghĩa merge/deduplicate/collision policy cho lesson IDs, title+summary duplicates và timestamps.
- Import không được cắt 30 bài trước khi người dùng biết dữ liệu nào bị loại.
- Cần bao gồm progress keys và theme theo lựa chọn rõ ràng; export chỉ lessons sẽ không phải backup đầy đủ.
- Cần validate toàn bộ payload, giới hạn kích thước, chống prototype-pollution/shape lạ, và không mutate storage nếu bất kỳ bước migration quan trọng nào thất bại.
- Anki export cần đặc tả encoding, escaping newline/tab/HTML, duplicate handling và mapping stable note ID; `AnkiCard` hiện không có ID/tags/deck/source metadata.
- `.env.local`/API key tuyệt đối không thuộc dữ liệu export hay artifact chia sẻ.

## 11. Thứ tự thay đổi được đề xuất (chưa thực hiện)

1. Bổ sung test characterization cho parser, API validation và localStorage hiện tại; đưa lint/build/test vào CI.
2. Tách một runtime Lesson validator dùng chung và một prompt/schema source dùng chung, nhưng giữ output schema hiện tại.
3. Thiết kế versioned storage envelope, `schemaVersion`, migration bất biến và backup/rollback khi migration lỗi.
4. Thêm stable IDs cho lesson items với migration từ word/index cũ; sau đó mới thiết kế SRS state.
5. Thêm export/import backup có version, validation, preview và merge policy; không áp giới hạn 30 âm thầm.
6. Thêm Anki export dựa trên stable IDs và format đã đặc tả.
7. Khôi phục/test Web Speech TTS fallback trong khi giữ Kokoro là đường ưu tiên.

## 12. Nền tảng SQLite sau Sprint 1

- Driver server-side: built-in `node:sqlite`; runtime tối thiểu Node 24.
- Database schema version: 1 (`app_metadata`, `lessons`, `lesson_progress`).
- Stable lesson ID cho API/repository mới: UUID tạo bằng `crypto.randomUUID()`; ID localStorage cũ chưa đổi.
- Development data directory: `.data` trừ khi đặt `PERSONAL_ENGLISH_LAB_DATA_DIR`.
- Portable/production Windows: Local AppData, nằm ngoài artifact.
- API health/CRUD/progress chạy Node runtime; React UI không import driver.
- Chi tiết migration, backup, portable và kế hoạch Sprint 3 nằm trong `docs/storage-architecture.md`.
