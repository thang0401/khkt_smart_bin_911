// Camera vẫn nhận diện được nếu phần đồng bộ Firebase chưa sẵn sàng.
let db;
try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
} catch (error) {
    console.error("Firebase initialization:", error);
}

let ZOOM_FACTOR = 1.6;
// =====================================================================
// CẤU HÌNH HỆ THỐNG
// =====================================================================

const MODEL_PATH = "best.onnx";
const TIME_WAIT = 7000; // Như source cũ: chờ DONE hoặc tối đa 7 giây.


const CLASS_NAMES = [ "Vô cơ", "Hữu cơ", "Rác khác"];
const CLASS_COMMANDS = ["A", "B", "C"]; // Khớp hm10_servo.ino: A vô cơ, B hữu cơ, C khác.
const audio       = [ 
    new Audio("asset/audio/0001.mp3"),
    new Audio("asset/audio/0002.mp3"),
    new Audio("asset/audio/0003.mp3")
];

const DISPLAY_SIZE = 320;


const AI_SIZE = 320;
const DETECT_INTERVAL = 300;
const SCALE_RATIO = DISPLAY_SIZE / AI_SIZE;

// =====================================================================
// BIẾN TOÀN CỤC
// =====================================================================

let pointsStore;
let stationSessionId = null;
let stationUnsubscribe;
let pointsInitialized = false;
let pointsSyncing = false;
let completedQueue = [];
let hardwareCycle = null;
let bluetoothWriting = false;
let doneBuffer = "";
let connectingBluetooth = false;
let bluetoothRetryAt = 0;
let bluetoothRetryDelay = 2000;
let session, video, canvas, ctx;
let resDiv, statusDiv, statusHMDiv;
let bluetoothDevice, txCharacteristic;

let busy          = false;

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
    const value = Number(document.getElementById("zoom").value);
    if (Number.isFinite(value) && value >= 1 && value <= 3) ZOOM_FACTOR = value;
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

        // Chỉ chặn gửi lệnh servo; không dừng model hay giữ kết quả nhận diện cũ.
        updateSortingStatus();

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
        void initializePointsController().catch(error => {
            console.error("Points controller:", error);
            document.getElementById("pointsStatus").textContent = error.message;
            document.getElementById("retryPointsSync").disabled = false;
        });
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

function handleGattDisconnect(event) {
    if (event.target !== bluetoothDevice || bluetoothDevice.gatt.connected) return;
    if (txCharacteristic) txCharacteristic.removeEventListener("characteristicvaluechanged", handleHM10Data);
    txCharacteristic = null;
    bluetoothRetryAt = Date.now() + 2000;
    statusDiv.textContent = "HM-10 đã ngắt. Bấm Kết nối để nối lại đúng thiết bị; không gửi lại lệnh đang chờ.";
}

async function bleTimeout(operation, ms = 10000) {
    let timer;
    try {
        return await Promise.race([operation, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Quá thời gian kết nối Bluetooth. Hãy thử lại.")), ms);
        })]);
    } finally { clearTimeout(timer); }
}

async function connect(automatic = false) {
    if (connectingBluetooth) return;
    if (!navigator.bluetooth) { statusDiv.textContent = "Trình duyệt chưa hỗ trợ Web Bluetooth."; return; }
    if (automatic && Date.now() < bluetoothRetryAt) return;
    if (bluetoothDevice?.gatt.connected && txCharacteristic) return;
    connectingBluetooth = true;
    let candidate;
    let cancelled = false;
    try {
        statusDiv.textContent = "Đang kết nối HM-10…";
        candidate = bluetoothDevice;
        // Tự nối lại chỉ dùng thiết bị đã được cấp quyền; không tự mở hộp chọn.
        if (!candidate && automatic) {
            bluetoothRetryAt = Date.now() + 30000;
            statusDiv.textContent = "Chưa tìm thấy HM-10 đã cấp quyền. Bấm Kết nối để chọn lại đúng thiết bị.";
            return;
        }
        if (!candidate) candidate = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: "HM" }],
            optionalServices: ["0000ffe0-0000-1000-8000-00805f9b34fb"]
        });
        if (txCharacteristic) txCharacteristic.removeEventListener("characteristicvaluechanged", handleHM10Data);
        txCharacteristic = null;
        if (bluetoothDevice) bluetoothDevice.removeEventListener("gattserverdisconnected", handleGattDisconnect);
        bluetoothDevice = candidate;
        candidate.addEventListener("gattserverdisconnected", handleGattDisconnect);
        const server = await bleTimeout(candidate.gatt.connect().then(server => {
            if (cancelled) { server.disconnect(); throw new Error("Đã hủy lần kết nối cũ."); }
            return server;
        }));
        const service = await bleTimeout(server.getPrimaryService("0000ffe0-0000-1000-8000-00805f9b34fb"));
        txCharacteristic = await bleTimeout(service.getCharacteristic("0000ffe1-0000-1000-8000-00805f9b34fb"));
        // Gắn listener trước khi bật notification, tránh bỏ sót DONE gửi ngay khi nối lại.
        txCharacteristic.addEventListener("characteristicvaluechanged", handleHM10Data);
        await bleTimeout(txCharacteristic.startNotifications());
        statusDiv.textContent = "Đã kết nối HM-10";
        statusDiv.style.color = "green";
        bluetoothRetryDelay = 2000;
        bluetoothRetryAt = 0;
        void retryPointsSync();
    } catch (error) {
        cancelled = true;
        if (txCharacteristic) txCharacteristic.removeEventListener("characteristicvaluechanged", handleHM10Data);
        txCharacteristic = null;
        if (candidate?.gatt.connected) candidate.gatt.disconnect();
        statusDiv.textContent = error.name === "NotFoundError" ? "Đã hủy chọn Bluetooth. Có thể bấm kết nối lại." : error.message;
        statusDiv.style.color = "red";
        bluetoothRetryAt = Date.now() + bluetoothRetryDelay;
        bluetoothRetryDelay = Math.min(30000, bluetoothRetryDelay * 2);
    } finally { connectingBluetooth = false; }
}
// =====================================================================
// GỬI DỮ LIỆU HM-10
// =====================================================================
function handleHM10Data(event) {
    if (event.target !== txCharacteristic) return;
    const value = new TextDecoder().decode(event.target.value);
    statusHMDiv.textContent = "📥 " + value;
    console.info?.("[BLE] received", { value });
    if (!hardwareCycle) return;
    doneBuffer = (doneBuffer + value.toUpperCase()).slice(-128);
    if (!/(?:^|\s)DONE(?=\s|$)/.test(doneBuffer)) return;
    // DONE giải phóng servo ngay; đồng bộ điểm chạy riêng và không chặn lượt mới.
    completedQueue.push(hardwareCycle);
    hardwareCycle = null;
    doneBuffer = "";
    stableCount = 0;
    lastClass = -1;
    persistCompletedQueue();
    void retryPointsSync();
    updateSortingStatus();
}

function getSendBlockReason() {
    if (hardwareCycle && Date.now() - hardwareCycle.sentAt >= TIME_WAIT) {
        hardwareCycle = null;
        doneBuffer = "";
        stableCount = 0;
        lastClass = -1;
        document.getElementById("pointsStatus").textContent = "Quá 7 giây chưa có DONE. Chưa cộng điểm lượt này; tiếp tục nhận diện như source cũ.";
    }
    if (!txCharacteristic || !bluetoothDevice?.gatt.connected) return "Kết nối HM-10 để điều khiển thùng rác.";
    if (bluetoothWriting) return "Đang gửi lệnh Bluetooth.";
    if (hardwareCycle) return "Servo đang xử lý, chờ DONE (tối đa 7 giây).";
    return "";
}

function updateSortingStatus(reason = getSendBlockReason()) {
    const element = document.getElementById("sortStatus");
    const message = reason || "Sẵn sàng: AI ổn định 5 lượt → gửi A/B/C trực tiếp xuống HM-10.";
    if (element && element.textContent !== message) element.textContent = message;
}

async function sendBluetooth(classId, score) {
    const command = CLASS_COMMANDS[classId];
    if (!command || getSendBlockReason()) return false;
    const eventId = globalThis.crypto?.randomUUID?.() || "cycle-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    // Chụp phiên ngay lúc gửi, tránh cộng cho học sinh khác nếu đổi phiên trước DONE.
    hardwareCycle = {
        eventId, controllerId: "browser-" + eventId,
        sessionId: stationSessionId, wasteCode: command, confidence: score,
        sentAt: Date.now(), bluetoothDeviceId: bluetoothDevice.id
    };
    doneBuffer = "";
    bluetoothWriting = true;
    try {
        console.info?.("[BLE] sending", { command, eventId, sessionId: stationSessionId });
        // Không await Firebase, không kiểm tra pendingEventId/controller/localStorage trước lệnh vật lý.
        await bleTimeout(txCharacteristic.writeValue(new TextEncoder().encode(command)), TIME_WAIT);
        statusDiv.textContent = "Đã gửi lệnh " + command + " (" + CLASS_NAMES[classId] + ")";
        statusDiv.style.color = "blue";
        console.info?.("[BLE] write accepted", { command, eventId });
        audio[classId].currentTime = 0;
        void audio[classId].play().catch(error => console.warn?.("Audio:", error));
        return true;
    } catch (error) {
        console.error("Bluetooth Error:", error);
        statusDiv.textContent = "Lỗi gửi Bluetooth: " + error.message;
        statusDiv.style.color = "red";
        return false;
    } finally {
        bluetoothWriting = false;
        updateSortingStatus();
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
            stableCount = 0;
            lastClass = -1;
            resDiv.innerHTML = "Chưa phát hiện rác";
            resDiv.style.color = "#666";
            return;
        }

        const best    = predictions[0];
        const classId = best.classId;
        const score   = best.score * 100;

        resDiv.innerHTML   = `Phát hiện: ${best.className} (${score.toFixed(1)}%)`;
        resDiv.style.color = "#17b978";

        const blockReason = getSendBlockReason();
        updateSortingStatus(blockReason);
        if (blockReason) {
            stableCount = 0;
            lastClass = -1;
            return;
        }

        // Cơ chế chống gửi liên tục
        if (classId === lastClass) stableCount++;
        else {
            stableCount = 1;
            lastClass = classId;
        }

        if (stableCount >= 5) {
            stableCount = 0;
            
            void sendBluetooth(classId, score).catch(error => console.error("Bluetooth Error:", error));

        }
    }
    catch (err) {
        stableCount = 0;
        lastClass = -1;
        console.error("YOLO Error:", err);
    }
}
// Trạm chỉ cung cấp phiên học sinh để ghi điểm; không khóa đường gửi Bluetooth.
function watchDeviceStation() {
    if (stationUnsubscribe) stationUnsubscribe();
    stationUnsubscribe = db.collection("bin_stations").doc(STATION_ID).onSnapshot(snapshot => {
        stationSessionId = snapshot.data()?.active_session_id || null;
    }, error => {
        console.error("Session sync:", error);
        document.getElementById("pointsStatus").textContent = "Chưa đọc được phiên học sinh. Bluetooth vẫn phân loại; kiểm tra mạng để đồng bộ điểm.";
    });
}

function persistCompletedQueue() {
    try { window.localStorage.setItem("smartbin.completed." + STATION_ID, JSON.stringify(completedQueue)); }
    catch (error) {
        console.warn?.("Completed queue:", error);
        document.getElementById("pointsStatus").textContent = "Chưa lưu được lượt đã DONE. Giữ trang mở để đồng bộ điểm.";
    }
}

async function retryPointsSync() {
    if (!pointsStore) {
        try { await initializePointsController(); }
        catch (error) { document.getElementById("pointsStatus").textContent = error.message; }
        return;
    }
    if (pointsSyncing || navigator.onLine === false || !completedQueue.length) return;
    pointsSyncing = true;
    try {
        while (completedQueue.length) {
            const result = await pointsStore.recordCompletedDisposal(completedQueue[0]);
            completedQueue.shift();
            persistCompletedQueue();
            document.getElementById("pointsStatus").textContent = result.student_code
                ? "Đã ghi nhận +" + result.unit_points + " điểm cho học sinh " + result.student_code + "."
                : "Đã ghi nhận lượt phân loại; không có phiên học sinh tại lúc gửi lệnh.";
        }
    } catch (error) {
        console.error("Points sync:", error);
        document.getElementById("pointsStatus").textContent = "Đã nhận DONE; đang chờ đồng bộ điểm. Bluetooth vẫn hoạt động. " + error.message;
    } finally { pointsSyncing = false; }
}

async function initializePointsController() {
    if (pointsInitialized) return;
    if (!db) throw new Error("Chưa kết nối Firebase. Bluetooth vẫn phân loại; tải lại trang để thử đồng bộ điểm.");
    pointsStore = new SmartBinStore(db, STATION_ID, firebase.firestore);
    try {
        const saved = JSON.parse(window.localStorage.getItem("smartbin.completed." + STATION_ID) || "[]");
        if (Array.isArray(saved)) completedQueue = saved.filter(item => item && typeof item.eventId === "string");
    } catch (error) { console.warn?.("Completed queue:", error); }
    watchDeviceStation();
    pointsInitialized = true;
    document.getElementById("retryPointsSync").disabled = false;
    document.getElementById("pointsStatus").textContent = "Bluetooth gửi trực tiếp. Điểm được ghi nhận sau DONE cho phiên đã bắt đầu.";
    setInterval(() => { void retryPointsSync(); }, 5000);
    window.addEventListener("online", () => { void retryPointsSync(); });
    void retryPointsSync();
}

window.onload = init;
