# SmartBin

## Cấu trúc giao diện

```text
out.html                         Trang hiển thị thùng rác và học sinh
src/
  index.html                     Trang camera và kết nối HM-10
  main3.js                       Nhận diện AI và điều khiển Bluetooth
  best.onnx                      Mô hình nhận diện
  asset/
    css/out.css                  Kiểu hiển thị của out.html
    js/
      config.js                  Cấu hình Firebase, nguồn dữ liệu, hằng số
      students.demo.js           10 học sinh và lịch sử mẫu
      smartbin-store.js          Transaction phiên, khóa trạm và giao dịch điểm
      device-controller.js       Luồng khóa cũ, không nạp trên trang camera hiện tại
      out.js                     Xử lý giao diện trang out.html
    img/                         Hình ảnh
database/                        Seed Firestore và hướng dẫn database
```

## Chỉnh sửa

- Đổi bố cục/nội dung: `out.html`. Các khối thùng rác, học sinh, hai tab và bàn phím có chú thích riêng.
- Đổi màu sắc/kích thước: `src/asset/css/out.css`.
- Đổi chế độ học sinh: `STUDENT_DATA_SOURCE` trong `src/asset/js/config.js` (`demo` hoặc `firebase`).
- Sửa học sinh và lịch sử minh họa: `src/asset/js/students.demo.js`.
- Sửa xử lý trang: `src/asset/js/out.js`, chia thành trạng thái/định dạng, giao diện học sinh,
  lịch sử, tra cứu, thống kê thùng, thao tác nhập và khởi tạo.

Mở `out.html` trực tiếp hoặc qua server tĩnh trong IDE. Các script cổ điển được nạp theo thứ tự
Firebase SDK → config → dữ liệu mẫu → out.js, không cần build hoặc cài thư viện.
Tra cứu `001` (14 điểm, 7 giao dịch) hoặc `010` (0 điểm, lịch sử trống) ở chế độ demo.
Phần tra cứu mẫu vẫn hoạt động khi Firebase không tải được; phần dữ liệu thùng rác cần kết nối Firebase.

Trang nhận diện `src/index.html` dùng `main3.js` và cùng `config.js` với trang hiển thị.
Khi đổi project Firebase cho toàn hệ thống, cập nhật `config.js`.
Phiên và điểm được dùng chung theo `STATION_ID` (mặc định `NLS_TN01`).
Điểm chỉ cộng sau DONE; không có phiên vẫn phân loại nhưng không cộng cho học sinh.
Hướng dẫn vận hành, phục hồi và kiểm thử: `database/SESSION-FLOW.md`.
Các bộ kiểm thử hồi quy nằm trong `tests/`: luồng phiên/giao dịch, khóa giao diện và kết nối HM-10.
Xem `database/README.md` để tạo dữ liệu Firestore.

## Nhận diện và phần cứng

Mở `src/index.html`, kết nối HM-10. Tra cứu và Bắt đầu tích điểm trên `out.html`.
AI cùng một loại ổn định 5 lượt sẽ gửi trực tiếp một byte `A` (vô cơ), `B` (hữu cơ) hoặc `C` (khác).
Lệnh Bluetooth không chờ Firestore, controller ID, Web Locks, localStorage hay `pending_event_id` cũ.
Ảnh đầu vào RGB 320 × 320, zoom 1.6 và ngưỡng 0.4 giữ nguyên source hoạt động trước đây.

Firmware chạy servo khoảng 6 giây rồi trả `DONE\r\n`. Trang chờ DONE hoặc tối đa 7 giây như source cũ;
không cần 3 khung hình camera trống. Lấy món đã phân loại ra khỏi camera trước món tiếp theo.
Chỉ khi nhận DONE mới lưu thống kê và điểm. Không có DONE thì không cộng điểm.
Phiên học sinh được chụp lúc gửi lệnh để DONE đến sau Hoàn tất vẫn cộng cho đúng học sinh.

Lượt đã DONE được xếp vào hàng đợi đồng bộ riêng; lỗi mạng không chặn servo của lượt tiếp theo.
Hàng đợi được lưu cục bộ nếu trình duyệt cho phép và tự thử lại mỗi 5 giây hoặc khi bấm Thử đồng bộ lại.
Reload chỉ đồng bộ các lượt đã DONE, không phát lại lệnh vật lý. Nếu reload giữa chu kỳ trước DONE thì lượt đó không được phục hồi.
Không mở đồng thời nhiều trang camera điều khiển cùng một HM-10 trong luồng đơn giản này.

Console ghi `[BLE] sending`, `[BLE] write accepted` và `[BLE] received`.
Kiểm thử trực tiếp đường ghi Bluetooth và ghi điểm: `node tests/recognition.test.cjs`.
