# Development checklist

## Trước khi sửa

- Kiểm tra branch, HEAD và working tree.
- Đọc tài liệu liên quan và chạy baseline verification.
- Bảo toàn mọi thay đổi hiện có; không reset, stash hoặc xóa tự động.

## Trong khi sửa

- Giữ scope nhỏ; không sửa file ngoài phạm vi.
- Thêm test trước hoặc cùng bug fix và review diff.
- Không đổi schema, persisted data hoặc compatibility nếu sprint không yêu cầu.
- Không đưa dữ liệu cá nhân vào test.

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
npm run smoke:kokoro-http
npm run smoke:security
npm run audit:ci
```

Khi sửa lesson progress, phải test tối thiểu: stable item ID, reload, cô lập giữa lessons, command
tuần tự không lost update, legacy progress defaults, backup Merge/Replace và history cap. Tab visited
không được gắn nhãn hoàn thành. Feedback request lỗi không được tạo practice history.

Khi sửa listening, phải kiểm tra: transcript ẩn mặc định; First/Second self-rating lưu riêng;
resume đúng step; reveal từng câu/reveal all; loop 3/5 dừng và không request audio trùng; stable source
item; completed session không bị mutate; Practice Again giữ aggregate; lesson isolation; dashboard
Continue/Re-listen; Speaking Ladder giữ progress riêng; backup cũ, Merge, Replace và conflict remap.

Để kiểm tra audio development, cấu hình Kokoro một lần trong `.env.local`, chạy
`npm run dev:full`, rồi xác nhận `/health`, port 5050, Kokoro playback, browser fallback và khả
năng quay lại Kokoro sau khi server khởi động lại. Không commit `.env.local` hoặc `.logs`.

Khi sửa network/API/provider, phải kiểm Host localhost/127/IPv6 loopback, same-origin và no-Origin
policy, bounded body 413/415, admission 429/recovery, Kokoro health dưới burst, safe errors và backup
dry-run. Không dùng `npm audit fix --force`; audit waiver phải exact-ID, có lý do và ngày hết hạn.

Trước commit chạy `git diff --check`, `git diff --stat`, `git status --short`. Sau commit chạy
`git show --stat --oneline HEAD` và `git status --short`.

Không build portable trong các sprint phát triển hiện tại. Portable chỉ được build trong final
release sprint khi ứng dụng đã hoàn thiện.

Portable packaging remains deferred until the final release sprint.
