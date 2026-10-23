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
      device-controller.js       Phục hồi lượt BLE đang chờ và xác nhận DONE
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

- Mở `src/index.html` trên thiết bị có camera. Kết quả AI vẫn thay đổi khi chưa kết nối Bluetooth hoặc Firestore đang chờ đồng bộ.
- Dòng trạng thái dưới kết quả AI cho biết vì sao chưa gửi được lệnh. Chỉ gửi sau 5 lượt nhận diện cùng loại khi trạm và HM-10 sẵn sàng.
- Ánh xạ theo model và firmware: `A = VO_CO`, `B = HUU_CO`, `C = RAC_KHAC`. Model dùng ảnh RGB 320 × 320, zoom mặc định 1.6 và ngưỡng 0.4 như bản gốc.
- Firmware thực hiện 4 lần chờ 1500 ms rồi trả `DONE\r\n`. Chỉ sau DONE mới xác nhận lượt rác và điểm; không gửi lại lệnh vật lý chỉ vì quá thời gian chờ.
- Sau DONE, đồng bộ và thời gian nghỉ, có thể nhận món tiếp theo mà không cần 3 khung hình camera trống. Đưa vật đã phân loại ra khỏi camera để tránh phân loại lại cùng vật.
- Console ghi `[SORT]` với loại rác, độ tin cậy và lệnh đã gửi.
- Kiểm thử luồng camera và ánh xạ: `node tests/recognition.test.cjs`. Bộ này dùng đầu ra model giả lập, không thay thế kiểm tra ảnh thật và servo/HM-10.
