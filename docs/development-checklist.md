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
npm run build
```

Trước commit chạy `git diff --check`, `git diff --stat`, `git status --short`. Sau commit chạy
`git show --stat --oneline HEAD` và `git status --short`.

Không build portable trong các sprint phát triển hiện tại. Portable chỉ được build trong final
release sprint khi ứng dụng đã hoàn thiện.
