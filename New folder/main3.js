firebase.initializeApp(firebaseConfig);

const db = firebase.firestore();

let ZOOM_FACTOR = 1.6;
// =====================================================================
// CẤU HÌNH HỆ THỐNG
// =====================================================================

const MODEL_PATH = "best.onnx";


const CLASS_NAMES = [ "Vô cơ", "Hữu cơ", "Rác khác"];
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

let pointsDevice;
let stationHasPending = true;
let stationSynced = false;
let stationListenerFailed = false;
let stationUnsubscribe;
let stationWatchVersion = 0;
let connectingBluetooth = false;
let bluetoothRetryAt = 0;
let bluetoothRetryDelay = 2000;
let needsClearScene = false;
let clearFrames = 0;
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

        if (!pointsDevice?.ready || !stationSynced || navigator.onLine === false || pointsDevice.sending || pointsDevice.recovering || pointsDevice.pending || stationHasPending || Date.now() < pointsDevice.cooldownUntil) {
            requestAnimationFrame(loop);
            return;
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
        await initializePointsController();
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
    if (connectingBluetooth || !pointsDevice) return;
    if (!navigator.bluetooth) { statusDiv.textContent = "Trình duyệt chưa hỗ trợ Web Bluetooth."; return; }
    if (automatic && Date.now() < bluetoothRetryAt) return;
    if (bluetoothDevice?.gatt.connected && txCharacteristic) return;
    connectingBluetooth = true;
    let candidate;
    let cancelled = false;
    try {
        statusDiv.textContent = "Đang kết nối HM-10…";
        const expected = pointsDevice.pending?.bluetoothDeviceId;
        candidate = bluetoothDevice;
        if (!candidate && expected && navigator.bluetooth.getDevices) {
            candidate = (await navigator.bluetooth.getDevices()).find(device => device.id === expected);
        }
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
        if (!pointsDevice.acceptsBluetoothDevice(candidate.id)) throw new Error("Còn lượt chờ của HM-10 khác. Chọn lại đúng thiết bị đã gửi lệnh.");
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
    void pointsDevice?.receive(value);
}

async function sendBluetooth(classId, score) {
    if (!txCharacteristic || !bluetoothDevice?.gatt.connected || !pointsDevice || needsClearScene) return;
    const command = ["A", "B", "C"][classId];
    if (!command) return;
    // Khóa nhận diện ngay, trước cả transaction chuẩn bị và ghi BLE.
    needsClearScene = true;
    clearFrames = 0;
    const sent = await pointsDevice.send(command, score, txCharacteristic, bluetoothDevice.id);
    if (!sent && !pointsDevice.pending) needsClearScene = false;
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
            if (needsClearScene && ++clearFrames >= 3) {
                needsClearScene = false;
                clearFrames = 0;
            }
            resDiv.innerHTML = "Chưa phát hiện rác";
            resDiv.style.color = "#666";
            return;
        }

        clearFrames = 0;
        if (needsClearScene) {
            resDiv.textContent = "Lấy vật đã phân loại ra khỏi vùng camera trước lượt tiếp theo.";
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
        stableCount = 0;
        lastClass = -1;
        console.error("YOLO Error:", err);
    }
}
function watchDeviceStation() {
    if (stationUnsubscribe) stationUnsubscribe();
    const version = ++stationWatchVersion;
    stationSynced = false;
    stationListenerFailed = false;
    stationUnsubscribe = db.collection("bin_stations").doc(STATION_ID).onSnapshot({ includeMetadataChanges: true }, snapshot => {
        if (version !== stationWatchVersion) return;
        stationSynced = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites && navigator.onLine !== false;
        if (stationSynced) stationHasPending = !!snapshot.data()?.pending_event_id;
    }, error => {
        if (version !== stationWatchVersion) return;
        stationSynced = false;
        stationListenerFailed = true;
        document.getElementById("pointsStatus").textContent = "Chưa đọc được khóa trạm. " + error.message;
    });
}

async function retryPointsSync() {
    if (!pointsDevice) return;
    if (stationListenerFailed || !stationSynced) watchDeviceStation();
    await pointsDevice.tick(true);
}

async function initializePointsController() {
    const pointsStatus = document.getElementById("pointsStatus");
    const release = await SmartBinDevice.acquireBrowserLock(navigator.locks, "smartbin-controller-" + firebaseConfig.projectId + "-" + STATION_ID);
    if (!release) throw new Error("Một tab khác đang điều khiển trạm. Đóng tab đó rồi tải lại trang này.");
    window.addEventListener("pagehide", () => { if (pointsDevice) pointsDevice.ready = false; release(); }, { once: true });
    window.addEventListener("pageshow", event => { if (event.persisted) window.location.reload(); });
    const store = new SmartBinStore(db, STATION_ID, firebase.firestore);
    pointsDevice = new SmartBinDevice(store, window.localStorage,
        message => { pointsStatus.textContent = message; },
        result => {
            const index = ["A", "B", "C"].indexOf(result.waste_code);
            if (audio[index]) {
                audio[index].currentTime = 0;
                void audio[index].play().catch(error => console.warn("Không phát được âm thanh:", error));
            }
        });
    watchDeviceStation();
    document.getElementById("retryPointsSync").disabled = false;
    // Đăng ký retry trước lần recover đầu: khởi động offline không cần tải lại trang.
    setInterval(() => {
        if (stationListenerFailed && navigator.onLine !== false) watchDeviceStation();
        void pointsDevice.tick();
        if (pointsDevice.pending && !txCharacteristic && (bluetoothDevice || pointsDevice.pending.bluetoothDeviceId)) void connect(true);
    }, 5000);
    window.addEventListener("online", () => { void retryPointsSync(); });
    window.addEventListener("offline", () => {
        stationSynced = false;
        pointsDevice.ready = false;
        pointsStatus.textContent = "Mất mạng. Không gửi lệnh mới; DONE đang chờ sẽ được giữ để đồng bộ lại.";
    });
    await pointsDevice.recover();
    if (pointsDevice.pending) needsClearScene = true;
    else if (pointsDevice.ready) pointsStatus.textContent = "Sẵn sàng. Điểm được ghi nhận sau DONE; học sinh cần Bắt đầu phiên ở trang hiển thị.";
}

window.onload = init;
