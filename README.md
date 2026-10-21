# SmartBin

## Cấu trúc giao diện

```text
out.html                         Trang hiển thị thùng rác và học sinh
New folder/
  index.html                     Trang camera và kết nối HM-10
  main3.js                       Nhận diện AI và điều khiển Bluetooth
  best.onnx                      Mô hình nhận diện
  asset/
    css/out.css                  Kiểu hiển thị của out.html
    js/
      config.js                  Cấu hình Firebase, nguồn dữ liệu, hằng số
      students.demo.js           10 học sinh và lịch sử mẫu
      smartbin-store.js          Transaction phiên, khóa trạm và giao dịch điểm
      device-controller.js       Phục hồi lượt BLE đang chờ và xác nhận DONE
      out.js                     Xử lý giao diện trang out.html
    img/                         Hình ảnh
database/                        Seed Firestore và hướng dẫn database
```

## Chỉnh sửa

- Đổi bố cục/nội dung: `out.html`. Các khối thùng rác, học sinh, hai tab và bàn phím có chú thích riêng.
- Đổi màu sắc/kích thước: `New folder/asset/css/out.css`.
- Đổi chế độ học sinh: `STUDENT_DATA_SOURCE` trong `New folder/asset/js/config.js` (`demo` hoặc `firebase`).
- Sửa học sinh và lịch sử minh họa: `New folder/asset/js/students.demo.js`.
- Sửa xử lý trang: `New folder/asset/js/out.js`, chia thành trạng thái/định dạng, giao diện học sinh,
  lịch sử, tra cứu, thống kê thùng, thao tác nhập và khởi tạo.

Mở `out.html` trực tiếp hoặc qua server tĩnh trong IDE. Các script cổ điển được nạp theo thứ tự
Firebase SDK → config → dữ liệu mẫu → out.js, không cần build hoặc cài thư viện.
Tra cứu `001` (14 điểm, 7 giao dịch) hoặc `010` (0 điểm, lịch sử trống) ở chế độ demo.
Phần tra cứu mẫu vẫn hoạt động khi Firebase không tải được; phần dữ liệu thùng rác cần kết nối Firebase.

Trang nhận diện `New folder/index.html` dùng `main3.js` và cùng `config.js` với trang hiển thị.
Khi đổi project Firebase cho toàn hệ thống, cập nhật `config.js`.
Phiên và điểm được dùng chung theo `STATION_ID` (mặc định `NLS_TN01`).
Điểm chỉ cộng sau DONE; không có phiên vẫn phân loại nhưng không cộng cho học sinh.
Hướng dẫn vận hành, phục hồi và kiểm thử: `database/SESSION-FLOW.md`.
Các bộ kiểm thử hồi quy nằm trong `tests/`: luồng phiên/giao dịch, khóa giao diện và kết nối HM-10.
Xem `database/README.md` để tạo dữ liệu Firestore.
