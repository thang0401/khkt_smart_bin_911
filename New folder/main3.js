// =========================== fire base =======================


const firebaseConfig = {
  apiKey: "AIzaSyCL8Rh8rzffeWnvubisPX-OXjpItEN-9WI",
  authDomain: "thung-rac-ch4.firebaseapp.com",
  databaseURL: "https://thung-rac-ch4-default-rtdb.firebaseio.com",
  projectId: "thung-rac-ch4",
  storageBucket: "thung-rac-ch4.firebasestorage.app",
  messagingSenderId: "375353797135",
  appId: "1:375353797135:web:0ec2891d5366b2bf1e517a",
  measurementId: "G-9WHNCZ0XKD"
};

firebase.initializeApp(firebaseConfig);

const db = firebase.firestore();

let ZOOM_FACTOR = 1.6;
// =====================================================================
// CẤU HÌNH HỆ THỐNG
// =====================================================================

const MODEL_PATH = "best.onnx";
const TIME_WAIT = 7000;

const CLASS_NAMES = [ "Vô cơ", "Hữu cơ", "Rác khác"];
const audio       = [ 
    new Audio("0001.mp3"),
    new Audio("0002.mp3"),
    new Audio("0003.mp3")
];

const DISPLAY_SIZE = 320;


const AI_SIZE = 320;
const DETECT_INTERVAL = 300;
const SCALE_RATIO = DISPLAY_SIZE / AI_SIZE;

// =====================================================================
// BIẾN TOÀN CỤC
// =====================================================================

let session, video, canvas, ctx;
let resDiv, statusDiv, statusHMDiv;
let bluetoothDevice, txCharacteristic;

let busy          = false;
let isWaiting     = false;
let startWaitTime = 0;
let lastDetect    = 0;
let lastClass     = -1;
let stableCount   = 0;

// =====================================================================
// OFFSCREEN CANVAS CHO YOLO
// =====================================================================

const tempCanvas  = document.createElement("canvas");
tempCanvas.width  = AI_SIZE;
tempCanvas.height = AI_SIZE;
const tempCtx     = tempCanvas.getContext( "2d", {willReadFrequently: true });






// =====================================================================
// CAMERA LOOP
// =====================================================================
function updatezoom(){
    ZOOM_FACTOR = document.getElementById("zoom").value;
}
function sendfirebase(classId, score) {
    // 1. Chỉ định đường dẫn tới document cần đọc/ghi
    const docRef = db.collection("du_lieu_tram").doc("thong_tin_hien_tai");

    // 2. Dùng .get() để lấy dữ liệu cũ về ĐÚNG 1 LẦN (Không dùng onSnapshot ở đây)
    docRef.get().then((doc) => {
        let sl_hc = 0;
        let sl_vc = 0;
        let sl_rk = 0;

        // Nếu document đã tồn tại trên database, lấy giá trị cũ của nó ra
        if (doc.exists) {
            const data = doc.data();
            sl_hc = data.rac_huu_co || 0;
            sl_vc = data.rac_vo_co || 0;
            sl_rk = data.rac_khac || 0;
        }

        console.log("Dữ liệu CŨ đọc từ Database về:", sl_vc, " ", sl_hc, " ", sl_rk);

        // 3. Tiến hành tăng giá trị lên 1 dựa theo classId chữ ("A", "B", "C") bạn truyền vào
        if (classId == "A" || classId == "Vô cơ (A)") {
            sl_vc++;
        } else if (classId == "B" || classId == "Hữu cơ (B)") {
            sl_hc++;
        } else if (classId == "C" || classId == "Rác khác (C)") {
            sl_rk++;
        }

        console.log("Dữ liệu MỚI sau khi đã cộng 1:", sl_vc, " ", sl_hc, " ", sl_rk);

        // 4. Đóng gói toàn bộ thông tin cũ và mới vào object newData
        let newData = {
            ai_result : classId,
            ti_le     : Number(score.toFixed(1)), // Làm tròn 1 chữ số thập phân cho đẹp
            time      : new Date(),
            rac_vo_co : sl_vc,
            rac_huu_co: sl_hc,
            rac_khac  : sl_rk
        };

        return docRef.set(newData);
    })
    .then(() => {
        console.log("👉 Đã cập nhật trạng thái rác hiện tại và cộng dồn số lượng thành công.");
    })
    .catch((err) => {
        console.error("❌ Lỗi khi xử lý đọc/ghi dữ liệu Firebase: ", err);
    });
}
function loop() {

    if (video && ctx && video.readyState === video.HAVE_ENOUGH_DATA) {
        
        // 1. Lấy kích thước thật của luồng video từ camera điện thoại
        const videoWidth = video.videoWidth;
        const videoHeight = video.videoHeight;
        
        // Tìm kích thước cạnh nhỏ nhất để cắt thành hình vuông chuẩn (Square Crop)
        const boxSize = Math.min(videoWidth, videoHeight);
        
        // 2. Tính toán kích thước vùng cắt ở tâm dựa theo hệ số ZOOM_FACTOR
        const cropSize = boxSize / ZOOM_FACTOR;
        
        // 3. Tính toán tọa độ bắt đầu cắt (x, y) để đảm bảo lấy trúng tâm camera
        const cropX = (videoWidth - cropSize) / 2;
        const cropY = (videoHeight - cropSize) / 2;

        // 4. Xóa canvas hiển thị cũ
        ctx.clearRect(0, 0, DISPLAY_SIZE, DISPLAY_SIZE);

        // 5. Cắt từ luồng video gốc và phóng to ra canvas hiển thị trên màn hình
        ctx.drawImage(
            video, 
            cropX, cropY, cropSize, cropSize, // Cắt vùng tâm của camera gốc
            0, 0, DISPLAY_SIZE, DISPLAY_SIZE  // Phóng to vừa khít khung 320x320 trên Web
        );

        // --- Logic chờ Servo của bạn giữ nguyên ---
        if (isWaiting) {
            let passed = Date.now() - startWaitTime;

            if (passed < TIME_WAIT) {
                let left = ((TIME_WAIT - passed) / 1000 ).toFixed(1);
                resDiv.innerHTML = `⏳ Chờ Servo ${left}s`;
                requestAnimationFrame(loop);
                return;
            }
            isWaiting = false;
        }

        const now = performance.now();

        if ( !busy && now - lastDetect > DETECT_INTERVAL ) {
            lastDetect = now;
            busy = true;
            predictYOLO().finally(() => { busy = false; });
        }
    }

    requestAnimationFrame(loop);
}

// =====================================================================
// TẢI MODEL + CAMERA
// =====================================================================

async function init() {

    resDiv = document.getElementById("result");
    statusDiv = document.getElementById("status");
    statusHMDiv = document.getElementById("statusHM");

    try {

        statusDiv.innerHTML     = "⏳ Đang tải YOLO...";
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd       = false;

        session =
            await ort.InferenceSession.create(
                MODEL_PATH, { executionProviders: [ "wasm" ] } );

        // console.log("YOLO Loaded");

        video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;

        const stream =
            await navigator.mediaDevices.getUserMedia({
                video: {
                    width: DISPLAY_SIZE,
                    height: DISPLAY_SIZE,
                    facingMode: "environment"
                }
            });

        video.srcObject = stream;

        await video.play();

        canvas        =  document.createElement("canvas");
        canvas.width  = DISPLAY_SIZE;
        canvas.height = DISPLAY_SIZE;
        ctx           = canvas.getContext("2d");

        document.getElementById("webcam-container").appendChild(canvas);
        statusDiv.innerHTML   = "✅ AI sẵn sàng";
        statusDiv.style.color = "#007bff";
        resDiv.innerHTML      = "Chưa phát hiện rác";

        requestAnimationFrame(loop);    
    }
    catch (err) {
        console.error("MODEL ERROR:", err);
        statusDiv.innerHTML = err.name  + "❌ " + err.message;
    }
}


// =====================================================================
// KẾT NỐI HM-10 BLE
// =====================================================================

async function connect() {

    try {
        statusDiv.innerHTML = "🔍 Đang tìm HM-10...";

        bluetoothDevice =
            await navigator.bluetooth.requestDevice({
                filters:          [ {namePrefix: "HM"} ],
                optionalServices: [ "0000ffe0-0000-1000-8000-00805f9b34fb"]
            });

        const server  = await bluetoothDevice.gatt.connect();
        const service = await server.getPrimaryService(
                "0000ffe0-0000-1000-8000-00805f9b34fb"
            );

        txCharacteristic =
            await service.getCharacteristic(
                "0000ffe1-0000-1000-8000-00805f9b34fb"
            );

        await txCharacteristic.startNotifications();

        txCharacteristic.addEventListener(
            "characteristicvaluechanged",
            handleHM10Data
        );

        

        statusDiv.innerHTML   = "🟢 Đã kết nối HM-10";
        statusDiv.style.color = "green";

    }
    catch (err) {
        console.error(err);
        statusDiv.innerHTML   = "❌ Kết nối HM-10 thất bại";
        statusDiv.style.color = "red";
    }
}
// =====================================================================
// GỬI DỮ LIỆU HM-10
// =====================================================================
function handleHM10Data(event) {

    const value = new TextDecoder().decode(event.target.value);
    statusHMDiv.innerHTML = "📥 " + value;
    if (value.includes("DONE")) isWaiting = false;

}
async function sendBluetooth(classId, score) {

    if (!txCharacteristic) return;

    let command = "";
    if (classId == 0) command = "A";else 
    if (classId == 1) command = "B";else
    if (classId == 2) command = "C";
    else return;


    try {
        await txCharacteristic.writeValue( new TextEncoder().encode( command ));
        
        audio[classId].currentTime = 0;
        audio[classId].play();
        
        if (command) {
            sendfirebase(command, score);
        }


        statusDiv.innerHTML   =`📡 Đã gửi lệnh ${command}`;
        statusDiv.style.color = "blue"
        isWaiting             = true;
        startWaitTime         = Date.now();

    }
    catch (err) {
        console.error( "Bluetooth Error:", err );
    }
}
// =====================================================================
// IMAGE -> TENSOR
// =====================================================================

function imageToTensor(imgData) {

    const { data, width, height } = imgData;
    const tensor = new Float32Array( 3 * width * height );
    const area   = width * height;

    for (let i = 0; i < area; i++ ){
        tensor[i]        = data[i * 4] / 255;
        tensor[i+area]   = data[i * 4 + 1] / 255;
        tensor[i+area*2] = data[i * 4 + 2] / 255;
    }

    return new ort.Tensor( "float32", tensor, [1, 3, height, width] );
}
// =====================================================================
// XỬ LÝ OUTPUT YOLO
// =====================================================================

function processYOLOResult(outputs) {

    const outputName = Object.keys(outputs)[0];
    const tensor     = outputs[outputName];
    const data       = tensor.data;
    const dims       = tensor.dims;

    if (dims.length !== 3) return [];

    const numElements = dims[2];
    const numClasses  = CLASS_NAMES.length;
    const boxes = [];

    for ( let i = 0; i < numElements; i++ ) {

        let bestScore = 0;
        let bestClass = -1;
        for ( let c = 0; c < numClasses; c++ ){

            const score = data[ numElements * (4 + c) + i ];
            if ( score > bestScore ) {
                bestScore = score;
                bestClass = c;
            }
        }

        if ( bestScore < 0.4 ) continue;

        const cx = data[i];
        const cy = data[ numElements + i ];
        const w  = data[ numElements * 2 + i ];
        const h  = data[ numElements * 3 + i ];
        const x  = cx - w / 2;
        const y  = cy - h / 2;

        if ( w > 20 && h > 20 && x >= 0 && y >= 0) {

            boxes.push({
                x, y,
                width    : w,
                height   : h,
                score    : bestScore,
                classId  : bestClass,
                className: CLASS_NAMES[ bestClass ]
            });
        }
    }

    boxes.sort( (a, b) => b.score - a.score );

    return boxes.length ? [boxes[0]] : [];
}
// =====================================================================
// NHẬN DIỆN YOLO
// =====================================================================
async function predictYOLO() {

    if (!session) return;

    const t0 = performance.now();

    try {
        // Vì canvas chính ở hàm loop() bây giờ đã là hình ảnh zoom cận cảnh cái đĩa,
        // chúng ta chỉ cần chuyển ảnh từ canvas hiển thị sang tempCanvas của YOLO là xong.
        tempCtx.clearRect(0, 0, AI_SIZE, AI_SIZE);
        tempCtx.drawImage(canvas, 0, 0, DISPLAY_SIZE, DISPLAY_SIZE, 0, 0, AI_SIZE, AI_SIZE);

        const imgData     = tempCtx.getImageData( 0, 0, AI_SIZE, AI_SIZE );
        const tensor      = imageToTensor(imgData);
        const outputs     = await session.run({ [session.inputNames[0]]: tensor });
        const predictions = processYOLOResult(outputs);

        if (predictions.length === 0) {
            resDiv.innerHTML = "Chưa phát hiện rác";
            resDiv.style.color = "#666";
            return;
        }

        const best    = predictions[0];
        const classId = best.classId;
        const score   = best.score * 100;

        resDiv.innerHTML   = `Phát hiện: ${best.className} (${score.toFixed(1)}%)`;
        resDiv.style.color = "#17b978";

        // Cơ chế chống gửi liên tục
        if (classId === lastClass) stableCount++;
        else {
            stableCount = 1;
            lastClass = classId;
        }

        if (stableCount >= 5) {
            stableCount = 0;
            
            await sendBluetooth(classId,score);

        }
    }
    catch (err) {
        console.error("YOLO Error:", err);
    }
}
window.onload = init;