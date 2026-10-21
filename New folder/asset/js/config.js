"use strict";

// Cấu hình chung của trang hiển thị và trang nhận diện.
// Chọn "demo" để tra cứu dữ liệu mẫu, "firebase" để đọc Firestore.
const STUDENT_DATA_SOURCE = "firebase";

const firebaseConfig = {
    apiKey: "AIzaSyCL8Rh8rzffeWnvubisPX-OXjpItEN-9WI",
    authDomain: "thung-rac-ch4.firebaseapp.com",
    projectId: "thung-rac-ch4",
    appId: "1:375353797135:web:0ec2891d5366b2bf1e517a"
};

const CLASS_LABELS = { A: "Rác vô cơ", B: "Rác hữu cơ", C: "Rác khác" };
const HISTORY_PAGE_SIZE = 5;
const STATION_ID = "NLS_TN01";
