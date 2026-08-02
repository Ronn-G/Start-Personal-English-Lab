# Versioning and release

Package `youtube-english-lesson`, display name Personal English Lab, hiện ở version `0.1.0`.
Version chưa được hiển thị trong runtime và sprint này không bump version.

Release hiện bị chặn vì provenance/license của source gốc và Kokoro model/voices chưa có bằng chứng.
Xem `docs/license-review-needed.md`. Dependency license metadata không thay thế repository license.
Không tạo public/commercial/portable release cho tới khi checklist provenance được chủ sở hữu xử lý.

Áp dụng Semantic Versioning: patch cho bug fix tương thích và không đổi dữ liệu/flow lớn; minor cho
tính năng tương thích; major cho thay đổi không tương thích hoặc migration lớn. Tag có dạng
`vMAJOR.MINOR.PATCH`.

Mỗi release phải gắn với commit SHA, app version, test results, release notes, database schema
version và backup version.

Quy trình hiện tại:

```text
sửa code → format check → lint → test → smoke tests → production build → diff review → commit
```

Final release được hoãn và có quy trình riêng:

```text
complete application features → release freeze → portable packaging
→ clean-machine verification → artifact scan → checksum → tag → release
```
