# Flow trực tiếp AI → HM-10 → DONE → điểm

1. Mở out.html, tra cứu học sinh và bấm Bắt đầu tích điểm.
2. Mở src/index.html trên thiết bị có camera và Web Bluetooth qua HTTPS/localhost. Đóng các trang camera điều khiển cũ.
3. Bấm Kết nối Bluetooth để chọn HM-10.
4. AI cùng một loại ổn định 5 lượt sẽ gọi writeValue trực tiếp: A vô cơ, B hữu cơ, C rác khác.
5. Trang chỉ chờ chu kỳ servo cục bộ. Không kiểm tra khóa pending trạm, controller ID, Web Locks hay Firestore trước khi gửi.
6. Firmware có 4 lần delay 1500 ms rồi trả DONE. DONE giải phóng chu kỳ ngay và đưa lượt vào hàng đợi ghi điểm riêng.
7. Lượt mới tiếp tục phân loại dù lượt đã DONE trước đó chưa ghi được Firebase. Không bắt buộc camera trống 3 khung hình.
8. Hoàn tất đóng phiên. Điểm của lượt đã gửi vẫn gắn với phiên chụp lúc gửi, kể cả DONE đến sau Hoàn tất.

## Thời gian và lỗi

- Chờ DONE tối đa 7 giây như bản cũ. Không có DONE thì không cộng điểm, cho phép nhận món tiếp theo.
- Không dùng timeout để khẳng định phần cứng đã thành công. Với firmware không có event ID, DONE đến quá trễ có thể không phân biệt được giữa hai chu kỳ.
- Firestore chỉ chạy sau DONE: tạo bản ghi snapshot mức thưởng, rồi transaction cập nhật điểm, thống kê, lịch sử và phiên.
- Retry cùng event ID không cộng lại. Không tự phát lại A/B/C khi thử đồng bộ điểm.
- Lỗi mạng: lưu hàng đợi đã DONE trong localStorage nếu có thể, thử lại mỗi 5 giây, khi online hoặc khi bấm Thử đồng bộ lại.
- Nếu localStorage lỗi, giữ trang mở để không mất lượt đã DONE chưa đồng bộ.
- Reload sau DONE sẽ khôi phục hàng đợi; reload trước DONE không khôi phục chu kỳ phần cứng đang chạy.
- Chỉ mở một trang camera điều khiển một HM-10. Luồng tối giản không khóa chéo nhiều tab/thiết bị.
- pending_event_id và smartbin.pending.* từ phiên bản cũ không còn chặn luồng camera hoặc các nút thao tác phiên.
- Không tự xóa các bản ghi pending cũ trên Firestore; giữ để đối chiếu lịch sử.

## Cấu hình và dữ liệu

src/asset/js/config.js chứa project Firebase, STATION_ID và chế độ học sinh.
src/asset/js/smartbin-store.js cung cấp recordCompletedDisposal cho flow hiện tại.
src/asset/js/device-controller.js và prepareDisposal/confirmDisposal mặc định giữ luồng khóa cũ để tương thích; src/index.html không nạp controller cũ.
Các Firestore Rules hiện tại hỗ trợ tạo event pending rồi xác nhận confirmed; không cần thay quyền cho flow trực tiếp này.
Phần xác thực vẫn là bản thử nghiệm; xem firestore.rules.

## Kiểm thử

Chạy node tests/recognition.test.cjs để kiểm tra bytes A/B/C, pending cũ, mạng lỗi, DONE chia gói/lặp, timeout,
đổi học sinh trước DONE, hàng đợi retry/reload và ghi điểm nguyên tử.
Các bộ tests/smartbin-flow.test.cjs, tests/bluetooth-connect.test.cjs và tests/dashboard-lock.test.cjs vẫn chạy.
smartbin-flow có cả kiểm thử tương thích cho controller khóa cũ; các kiểm thử đó không phải điều kiện gửi lệnh của trang camera hiện tại.
Bộ test dùng model output, Firestore và Bluetooth giả lập, chưa thay thế kiểm tra trên camera, HM-10 và servo thật.

Kiểm tra thực tế: hữu cơ phải có log [BLE] sending với command B, sau đó [BLE] write accepted,
servo chuyển ngăn hữu cơ và [BLE] received chứa DONE. Sau DONE, điểm tăng đúng 3 và lịch sử thêm đúng một dòng.
