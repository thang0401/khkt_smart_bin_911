# Phiên học sinh và tích điểm sau DONE

## Chạy trên thiết bị

1. Dùng cùng project trong `src/asset/js/config.js`, nguồn dữ liệu `firebase`.
   Cả hai trang dùng cùng `STATION_ID`, mặc định `NLS_TN01`. Hiện thống kê thùng vẫn dùng
   document `du_lieu_tram/thong_tin_hien_tai`, chỉ triển khai một trạm.
2. Áp dụng `database/firestore.rules` trên project. Đây là rules cho dữ liệu mẫu, chưa có đăng nhập.
   Có thể dùng `powershell -NoProfile -ExecutionPolicy Bypass -File .\database\publish-rules.ps1`.
   Script kiểm tra source với Firebase, sao lưu rules cũ rồi publish và xác minh release.
3. Mở `out.html` trên màn hình hiển thị; mở `src/index.html` trên thiết bị có camera/HM-10.
   Bluetooth/camera cần trình duyệt hỗ trợ và ngữ cảnh an toàn (HTTPS hoặc localhost).
4. Tra cứu `001`, bấm **Bắt đầu tích điểm**. Ô nhập mã bị khóa trong suốt phiên.
5. Kết nối HM-10 trên trang nhận diện. Đặt từng món vào camera.
6. Khi cùng một loại ổn định 5 lượt, web tạo `disposal_events` và khóa trạm, rồi gửi A/B/C.
7. Chỉ khi nhận chuỗi `DONE`, web mới cập nhật số dư, tổng điểm kiếm được, điểm phiên,
   lịch sử và số lượng rác trong một transaction. Lặp DONE cho cùng ID không cộng lại.
8. Lấy vật ra khỏi camera. Sau DONE, đồng bộ và thời gian nghỉ, trạm nhận lượt kế tiếp; không bắt buộc 3 khung hình trống.
9. Bấm **Hoàn tất** để kết thúc phiên và xóa học sinh khỏi màn hình.

## Thời gian và trạng thái

- Thời gian không hoạt động đọc từ `reward_settings/default.session_idle_seconds`, mặc định 120 giây.
- Cảnh báo đọc từ `session_warning_seconds`, mặc định 15 giây. Nút **Tiếp tục phiên** gia hạn phiên.
- Bắt đầu xử lý rác hoặc xác nhận DONE đều cập nhật hoạt động của phiên.
- Có thể bấm Hoàn tất khi rác đang xử lý rồi bắt đầu phiên tiếp theo. DONE đến sau ghi điểm đúng phiên/học sinh đã gắn với lượt rác; chỉ phiên còn active mới được gia hạn.
- Hết hạn khi không có lượt chờ: chuyển `expired`, bỏ khóa phiên. Nếu màn hình đóng,
   lần bắt đầu/chuẩn bị rác tiếp theo kiểm tra hạn và loại bỏ phiên cũ trước khi gắn học sinh.
- Không có phiên hoặc phiên đã hết hạn: vẫn phân loại và thống kê rác, không cộng cho ai.
- Đổi quy định thưởng không thay mức điểm của lượt đã chuẩn bị hoặc lịch sử cũ.

## Khi có lỗi

- Không có mạng hoặc khóa trạm chỉ có cache: không gửi lệnh mới ra máy. Camera vẫn nhận diện; nút Bắt đầu/Hoàn tất vẫn bấm được nhưng ghi dữ liệu cần kết nối Firestore.
  Khi kết nối Firebase trở lại, tự đọc lại khóa/phiên từ server, không cần đổi học sinh hoặc tải lại trang.
- Quá 7 giây chưa DONE: chưa cộng điểm, giữ nguyên khóa, không tự coi là thành công.
- Ghi Bluetooth lỗi: kết quả vật lý có thể chưa rõ; giữ lượt chờ, không tự gửi lại lệnh.
- Mất kết nối HM-10 khi còn lượt chờ: tự thử nối lại thiết bị đã cấp quyền, với thời gian giãn
  giữa các lần thử tối đa 30 giây. Không tự mở hộp chọn thiết bị. Có thể bấm Kết nối để thử ngay.
  Thiết bị mới phải khớp `bluetooth_device_id` đã lưu cùng lượt rác; không lấy DONE từ một HM-10 khác.
- Đã nhận DONE nhưng ghi Firebase lỗi: lưu ACK/ID trong localStorage và thử lại theo thời gian giãn,
  tối đa 30 giây (bộ hẹn giờ kiểm tra mỗi 5 giây). Có nút **Thử đồng bộ lại** trên trang nhận diện;
   không gửi lại lệnh vật lý. Giữ trang mở nếu trình duyệt báo không ghi được localStorage.
- Tải lại trang nhận diện: phục hồi ID còn chờ từ Firestore/localStorage, kể cả khi Firebase đang
  mất kết nối, để giữ được DONE đến qua Bluetooth. Không phát lại A/B/C.
- Nhật ký lưu trước khi chuẩn bị Firestore và trước khi gọi writeValue. Nếu xác minh lượt chắc
  chắn chưa gửi (phase preparing/prepared), có thể hủy tự động và nhả khóa. Nếu có thể đã gửi
  (dispatching/awaiting_done), giữ khóa chờ DONE, không tự giả định thất bại.
- Ghi Bluetooth bị treo: hết 7 giây nhả cờ chờ JavaScript, giữ lượt chưa rõ kết quả; DONE đến sau
  vẫn được xử lý. Đọc trạng thái và xác minh ghi điểm có thời gian chờ 12 giây; xác nhận điểm
  được thử lại với cùng event ID để xử lý trường hợp đã commit nhưng mất phản hồi.
- Chỉ cho một tab nhận diện điều khiển một trạm trên cùng origin bằng Web Locks. Đóng tab cũ
  rồi tải lại nếu có thông báo một tab khác đang điều khiển. Trình duyệt cần hỗ trợ Web Locks.
- Thiết bị khác còn lượt chờ: mở lại thiết bị gốc. Không xóa localStorage khi máy chưa xử lý xong.
- Nếu thiết bị không bao giờ trả DONE: người quản lý cần xác minh máy đã dừng/không còn lệnh
   chờ trước khi chuyển event sang `rejected` và xóa `pending_event_id` của trạm bằng Console.
   Không chuyển event sang confirmed thủ công nếu chưa có bằng chứng xử lý thành công.

## Dữ liệu mới (tự tạo khi sử dụng)

- `bin_stations/NLS_TN01`: `active_session_id`, `pending_event_id`, `last_event_id`.
- `bin_sessions/{id}`: học sinh, trạng thái, thời gian bắt đầu/hết hạn, số vật và điểm phiên.
- `disposal_events/{id}`: snapshot học sinh, phiên, loại rác, mức thưởng, controller gửi, `bluetooth_device_id` và trạng thái.
- `students/{code}/point_history/{eventId}`: một lịch sử confirmed cho một event ID.

Không cần seed lại học sinh. Điểm/lịch sử hiện có không bị reset.

## Giới hạn của bản thử nghiệm

Rules hiện cho web không đăng nhập ghi vào các collection tính năng. Các giới hạn field và
transaction bảo vệ lỗi vận hành thông thường, chưa ngăn người cố ý giả mạo điểm hoặc DONE.
Trước khi dùng điểm thật cần xác thực thiết bị và xác nhận giao dịch qua backend đáng tin cậy.

Firmware hiện chỉ trả `DONE` không kèm ID. Code chống xử lý lại cùng event và có thời gian nghỉ sau khi đồng bộ,
nhưng không thể phân biệt một DONE rất trễ của chu kỳ trước với chu kỳ mới nếu firmware gửi
sai thứ tự. Nên nâng firmware lên giao thức `command/eventId → DONE/eventId` trước vận hành thật.
Đồng hồ các thiết bị cần chính xác; thời hạn được tạo từ đồng hồ client, thời gian audit dùng serverTimestamp.

## Kiểm thử

Nếu có Node.js:

```powershell
node .\tests\smartbin-flow.test.cjs
node .\tests\dashboard-lock.test.cjs
node .\tests\bluetooth-connect.test.cjs
node .\tests\recognition.test.cjs
```

Bộ test dùng Firestore giả lập trong bộ nhớ, thực thi transaction nguyên tử/tuần tự và chặn
đọc sau ghi. Bao phủ phiên đồng thời, hết hạn/gia hạn, khóa lúc pending, chốt mức thưởng,
DONE lặp/chia gói/đến trong writeValue, lỗi mạng, reload và timeout. Không thay thế kiểm thử
Firestore SDK, quyền thực tế, camera và HM-10 trên thiết bị. Bộ hồi quy hiện có 50 trường hợp,
gồm snapshot/tra cứu đến trễ, cache cũ, mất phản hồi sau commit, callback lỗi và kết nối Bluetooth bị treo.

Kiểm tra thật sau khi publish:

1. Bắt đầu với `001`, bỏ hữu cơ: trước DONE số dư không đổi; sau DONE tăng đúng 3.
2. Vô cơ tăng 2, khác tăng 1; tab lịch sử có đúng một dòng cho mỗi món thành công.
3. Gửi DONE lặp cho cùng lượt: số dư và số vật không tăng thêm.
4. Bỏ rác khi chưa bắt đầu: không tăng điểm học sinh.
5. Bấm Hoàn tất; bắt đầu `002`: rác mới chỉ tăng cho `002`.
6. Không thao tác 120 giây: có cảnh báo, hết hạn và quay lại bàn phím; Tiếp tục phiên gia hạn.
7. Ngắt mạng sau khi đã gửi, nhận DONE, kết nối lại: cộng một lần khi đồng bộ được.
8. Không gửi DONE quá 7 giây: không có điểm; có thể Hoàn tất phiên; lượt đang chờ giữ nguyên học sinh đã gắn.
9. Mất mạng lúc có lượt chờ: ô mã vẫn khóa; nhận DONE rồi bật mạng lại, điểm chỉ cộng một lần.
10. Tải lại trang nhận diện khi mất mạng (SDK/model đã sẵn có): kết nối đúng HM-10, nhận DONE,
    bật mạng lại và kiểm tra một giao dịch confirmed. Nếu CDN SDK/model chưa tải được cần tải lại trang khi có mạng.
11. Tắt rồi bật HM-10: kiểm tra tự nối lại không mở hộp chọn và không gửi lại A/B/C.
