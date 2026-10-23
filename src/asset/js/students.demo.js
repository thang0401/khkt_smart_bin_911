"use strict";

// Chỉ dùng để xem thử giao diện. Không đọc/ghi điểm học sinh lên Firebase.
// Nguồn dữ liệu được chọn bằng STUDENT_DATA_SOURCE trong config.js.

function demoStudent(fullName, className, wasteCodes) {
    const rewards = { A: 2, B: 3, C: 1 };
    return {
        full_name: fullName,
        class_name: className,
        active: true,
        points_balance: wasteCodes.reduce((total, code) => total + rewards[code], 0),
        // Thứ tự mới nhất trước. Thời gian mẫu cố định, không cần SDK Firebase.
        history: wasteCodes.map((code, index) => ({
            type: "earn",
            waste_code: code,
            points_delta: rewards[code],
            status: "confirmed",
            created_at: new Date(Date.parse("2026-10-21T09:30:00+07:00") - index * 60 * 60 * 1000)
        }))
    };
}

const DEMO_STUDENTS = {
    "001": demoStudent("Nguyễn Minh Anh", "10A1", ["A", "B", "C", "A", "B", "A", "C"]),
    "002": demoStudent("Trần Đức Anh", "10A1", ["A", "B", "C"]),
    "003": demoStudent("Lê Ngọc Hà", "10A2", ["B", "B", "A", "C"]),
    "004": demoStudent("Phạm Gia Huy", "10A2", ["A", "A", "B", "A", "C", "B"]),
    "005": demoStudent("Hoàng Khánh Linh", "11A1", ["B", "C"]),
    "006": demoStudent("Vũ Bảo Nam", "11A1", ["A", "B", "A"]),
    "007": demoStudent("Đặng Phương Thảo", "11A2", ["B", "B", "C", "A"]),
    "008": demoStudent("Bùi Quang Minh", "11A2", ["A", "C", "A", "B", "A", "C", "B", "A"]),
    "009": demoStudent("Đỗ Thu Trang", "12A1", ["C", "B", "A"]),
    "010": demoStudent("Ngô Hải Đăng", "12A1", [])
};
