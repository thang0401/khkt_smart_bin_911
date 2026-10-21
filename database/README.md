# Dữ liệu tích điểm SmartBin

Ba luồng phiên học sinh, gắn lượt rác và cộng điểm sau DONE đã triển khai.
Xem `SESSION-FLOW.md` để vận hành, kiểm thử và xử lý lượt đang chờ.
`firestore.rules` là bộ rules đầy đủ cho bản thử nghiệm hiện tại.

Giao diện ở `out.html`, CSS ở `New folder/asset/css/out.css`.
JavaScript nằm trong `New folder/asset/js/`: `config.js` chứa cấu hình,
`students.demo.js` chứa học sinh hardcode, `out.js` xử lý tra cứu/hiển thị.
Hiện dùng học sinh hardcode để thử giao diện, chưa cần seed Firebase.
Tra cứu `001` để xem 14 điểm và 7 giao dịch (có Xem thêm), `010` để xem 0 điểm và lịch sử trống.
Điểm/lịch sử này chỉ minh họa trên giao diện, không được ghi lên database.
Khi muốn chuyển sang Firestore sau khi seed/cấu hình rules, đổi `STUDENT_DATA_SOURCE` trong
`New folder/asset/js/config.js` từ `"demo"` thành `"firebase"`. Phần dữ liệu thùng rác vẫn dùng Firebase như trước.
`New folder/main3.js` dùng chung config/store và xử lý DONE qua `device-controller.js`.
Nút Bắt đầu / Hoàn tất hoạt động ở chế độ firebase khi đã đọc được khóa trạm.

## Tạo dữ liệu lên Firestore

REST đã trả 403 khi thử truy cập không đăng nhập. Script dùng tài khoản quản trị IAM để tạo dữ liệu;
Firebase web API key trong HTML không phải thông tin đăng nhập quản trị.

1. Nếu đã có Google Cloud CLI (`gcloud`), đăng nhập tài khoản có quyền ghi dữ liệu Firestore của dự án:

   ```powershell
   gcloud auth login
   ```

   Nếu chưa có CLI, có thể tự đặt OAuth access token hợp lệ vào biến môi trường
   `FIRESTORE_ACCESS_TOKEN` trong phiên PowerShell hiện tại. Không đưa token vào mã nguồn hoặc gửi qua chat.
   Tài khoản cần quyền đọc/ghi dữ liệu, ví dụ vai trò `roles/datastore.user`.

2. Từ thư mục gốc dự án, xem trước và chạy:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\database\seed-firestore.ps1 -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File .\database\seed-firestore.ps1
   ```

3. Script tạo 10 học sinh `001`–`010` và `reward_settings/default` trong database `(default)`
   của dự án `thung-rac-ch4`. Tất cả tên/lớp là dữ liệu mẫu, điểm ban đầu là **0**.
   Có thể sửa tên/lớp trong `students.seed.json` trước lần chạy đầu.
   Script bỏ qua document đã tồn tại, không reset điểm khi chạy lại, không ghi lịch sử giả,
   không chạm `du_lieu_tram/thong_tin_hien_tai`. Tạo mới bằng một commit nguyên tử có điều kiện
   document chưa tồn tại để tránh ghi đè khi có người khác cùng tạo.
   Nếu commit thành công nhưng xác minh mất mạng, chạy lại an toàn để kiểm tra các document.

4. Nếu tra cứu trên web vẫn bị từ chối, kiểm tra Firestore Rules. File
   `firestore.rules` chứa bộ rules đầy đủ cho các luồng hiện tại. `student-read.rules.snippet` chỉ là bản tra cứu cũ.
   Firestore cộng quyền từ các match trùng nhau: nếu đang có rule
   rộng `allow read, write: if true`, các dòng `if false` trong snippet không vô hiệu hóa rule đó.
   Script IAM không tự sửa rules. Với dữ liệu học sinh thật cần bổ sung xác thực/phân quyền
   trước khi sử dụng; mã học sinh hiện chỉ là mã tra cứu.

5. Chuyển `STUDENT_DATA_SOURCE` sang `"firebase"`, mở `out.html`, nhập `001` và bấm Tra cứu. Có thể mở bằng server tĩnh trong IDE.
   Cần mạng để tải Firebase SDK và đọc Firestore. Hiện chưa có giao dịch nên lịch sử trống là đúng.

## Cấu trúc dữ liệu

### Được script tạo ngay

`students/{student_code}`:

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| student_code | string | 001–010; trùng document ID |
| full_name, class_name | string | Tên, lớp mẫu |
| active | boolean | Cho phép sử dụng |
| points_balance | integer | Điểm còn lại, ban đầu 0 |
| points_earned | integer | Tổng điểm kiếm được, ban đầu 0 |
| points_spent | integer | Điểm đã dùng, ban đầu 0 |
| created_at, updated_at | timestamp | Thời gian máy chủ |

`reward_settings/default`:

- `version: 2`
- `points_by_waste_code: { A: 2, B: 3, C: 1 }`: vô cơ +2, hữu cơ +3, khác +1.
- `labels_by_waste_code`: tên tiếng Việt của ba loại.
- `session_idle_seconds: 120`, `session_warning_seconds: 15`: giá trị đề xuất cho bước logic tiếp theo.
- `require_device_done: true`: chỉ ghi nhận thành công sau phản hồi DONE; không cho phép tắt yêu cầu này trong code.
- `created_at`, `updated_at`: timestamp máy chủ.

Mức điểm trên giao diện hiện hardcode đúng 2/3/1. Store đọc config khi chuẩn bị lượt rác và
lưu bản chụp mức thưởng vào giao dịch để thay đổi quy định không làm đổi lịch sử cũ.

Để cập nhật mức thưởng của database đã seed, sửa `rewards.seed.json` rồi chạy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\database\update-rewards.ps1 -ProjectId "thung-rac-ch4"
```

Script này chỉ cập nhật mức thưởng, phiên bản và `updated_at`, giữ nguyên số dư, lịch sử,
thời gian tạo và các cài đặt phiên. Script seed ban đầu vẫn bỏ qua document đã có.

### Dữ liệu phát sinh khi vận hành

Firestore không cần tạo trước collection rỗng. Các đường dẫn sau sẽ xuất hiện khi phát sinh dữ liệu.

`students/{student_code}/point_history/{event_id}`:

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| event_id | string | ID cố định cho một chu kỳ, dùng chống cộng trùng |
| session_id, station_id | string | Liên kết phiên và trạm |
| type | string | `earn` hoặc `adjustment` |
| waste_code | string | A / B / C; có thể null cho điều chỉnh |
| points_delta | integer | Điểm thay đổi; số âm khi trừ/điều chỉnh |
| reward_version, unit_points, quantity | integer | Mức thưởng tại thời điểm giao dịch |
| status | string | `pending`, `confirmed`, `rejected` |
| reason | string | Lý do điều chỉnh hoặc lỗi |
| created_at, confirmed_at | timestamp | Thời gian máy chủ |

Giao diện hiện đọc lịch sử theo `created_at` giảm dần, 5 dòng mỗi lần Xem thêm;
query này dùng index một trường mặc định. Mỗi bản ghi phải có `created_at`.
Chỉ giao dịch confirmed được tính vào số dư, giao dịch pending phải hiển thị là chờ.

`bin_sessions/{session_id}`:

- `student_code`, `station_id`, `status` (`active`, `closing`, `completed`, `expired`).
- `started_at`, `last_activity_at`, `expires_at`, `ended_at` (timestamp máy chủ).
- `points_earned`, `items_count`, `close_reason`.
- Cần khóa phiên theo trạm, không cho đổi học sinh trong chu kỳ máy đang xử lý.

Các luồng đã có: DONE/timeout, giao dịch điểm nguyên tử, chống gửi khi máy đang bận,
đợi camera trống trước vật tiếp theo, thử lại ghi dữ liệu sau lỗi mạng, tự thoát có cảnh báo.
Quản trị điều chỉnh điểm chưa có giao diện.
Đổi quà và bảng xếp hạng chưa có giao diện trong đợt này.

## Kiểm tra sau khi chạy seed

- Tra cứu 001–010: đúng tên/lớp, 0 điểm, lịch sử trống.
- Tra cứu 999: không tìm thấy; mã có dấu `/` bị chặn.
- Chạy seed lần hai: báo giữ dữ liệu cũ, không reset số dư.
- Chỉnh `points_balance` của 001 bằng Console: giao diện đang tra cứu cập nhật theo snapshot.
- Lấy rác chỉ đặt lại thống kê thùng, không thay đổi học sinh/lịch sử.
- Màn hình rộng: tỉ lệ 8/12–4/12; dưới 760px: hai phần xếp dọc.
