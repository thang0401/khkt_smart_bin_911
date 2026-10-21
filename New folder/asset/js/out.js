/* Giao diện học sinh, phiên tích điểm và dữ liệu thùng rác thời gian thực. */
"use strict";

// 1. Trạng thái trang và các hàm định dạng.
// Các hằng cấu hình nằm trong config.js, học sinh mẫu trong students.demo.js.
const ui = id => document.getElementById(id);
const formatNumber = value => Number(value || 0).toLocaleString("vi-VN");
const formatTime = value => {
    const date = value && typeof value.toDate === "function" ? value.toDate() : value;
    return date instanceof Date && !Number.isNaN(date.getTime())
        ? date.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "Chưa có thời gian";
};
let db;
let lookupVersion = 0;
let studentUnsubscribe;
let historyUnsubscribe;
let historyLimit = HISTORY_PAGE_SIZE;
let selectedStudentCode;
let sessionStore;
let stationState = {};
let stationReady = false;
let sessionReady = false;
let stationUnsubscribe;
let stationListenerFailed = false;
let sessionListenerFailed = false;
let connectionRetrying = false;
let lookupBusy = false;
let activeSession;
let sessionUnsubscribe;
let watchedSessionId = null;
let stationWatchVersion = 0;
let stationRevision = 0;
let sessionActionBusy = false;
let lastExpiryAttempt = 0;
let warningSeconds = 15;

function setMessage(id, text, error = false) {
    ui(id).textContent = text;
    ui(id).classList.toggle("error", error);
}

function databaseError(error) {
    console.error(error);
    if (error.code === "permission-denied") return "Thiếu quyền Firestore. Cần publish bộ Rules cho phiên và giao dịch tích điểm.";
    if (error instanceof Error && !error.code) return error.message;
    return "Không tải được dữ liệu. Kiểm tra kết nối mạng rồi thử lại.";
}

async function serverRead(ref, timeoutMs = 12000) {
    let timer;
    try {
        return await Promise.race([
            ref.get({ source: "server" }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Quá thời gian đọc dữ liệu. Kiểm tra mạng rồi thử lại.")), timeoutMs); })
        ]);
    } finally { clearTimeout(timer); }
}

// 2. Giao diện học sinh và hai tab.
function stopStudentListeners() {
    if (studentUnsubscribe) studentUnsubscribe();
    if (historyUnsubscribe) historyUnsubscribe();
    studentUnsubscribe = historyUnsubscribe = undefined;
}

function showStudentEmpty() {
    selectStudentTab("points");
    ui("studentDetails").hidden = true;
    ui("studentEmpty").hidden = false;
    ui("historyList").replaceChildren();
    ui("loadMoreHistory").hidden = true;
    ui("historyState").hidden = false;
    ui("historyCount").textContent = "Gần đây";
}

function selectStudentTab(name, focus = false) {
    ["points", "history"].forEach(tabName => {
        const selected = tabName === name;
        const tab = ui(`${tabName}Tab`);
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        ui(`${tabName}Panel`).hidden = !selected;
        if (selected && focus) tab.focus();
    });
}

function renderStudent(code, data) {
    ui("studentDetails").hidden = false;
    ui("studentEmpty").hidden = true;
    ui("studentName").textContent = data.full_name || code;
    ui("studentMeta").textContent = `${code} · Lớp ${data.class_name || "chưa cập nhật"}`;
    ui("studentAvatar").textContent = (data.full_name || code).trim().split(/\s+/).slice(-2).map(word => word[0]).join("");
    ui("studentPoints").textContent = formatNumber(data.points_balance);
    syncSessionControls();
}

// 3. Đọc và hiển thị lịch sử tích điểm.
function watchHistory(code, version) {
    if (historyUnsubscribe) historyUnsubscribe();
    ui("loadMoreHistory").hidden = true;
    ui("historyState").hidden = false;
    ui("historyState").textContent = "Đang tải lịch sử…";
    if (STUDENT_DATA_SOURCE === "demo") {
        renderHistory(DEMO_STUDENTS[code].history.slice(0, historyLimit + 1));
        return;
    }
    historyUnsubscribe = db.collection("students").doc(code).collection("point_history")
        .orderBy("created_at", "desc").limit(historyLimit + 1)
        .onSnapshot(snapshot => {
            if (version !== lookupVersion) return;
            renderHistory(snapshot.docs.map(doc => doc.data()));
        }, error => {
            if (version !== lookupVersion) return;
            ui("historyList").replaceChildren();
            ui("historyState").hidden = false;
            ui("historyState").textContent = databaseError(error);
            ui("loadMoreHistory").hidden = true;
        });
}

function renderHistory(records) {
    const visibleRecords = records.slice(0, historyLimit);
    ui("historyList").replaceChildren();
    ui("historyState").hidden = visibleRecords.length > 0;
    ui("historyState").textContent = "Chưa có lượt tích điểm nào. Lịch sử sẽ xuất hiện khi có giao dịch.";
    ui("historyCount").textContent = visibleRecords.length ? `${visibleRecords.length} lượt gần nhất` : "Gần đây";
    visibleRecords.forEach(data => {
        const item = document.createElement("li");
        item.className = "history-item";
        const description = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = data.type === "adjustment" ? "Điều chỉnh điểm" : CLASS_LABELS[data.waste_code] || "Giao dịch điểm";
        const time = document.createElement("small");
        time.textContent = formatTime(data.created_at);
        description.append(title, time);
        if (data.reason) {
            const reason = document.createElement("small");
            reason.textContent = data.reason;
            description.append(reason);
        }
        const points = document.createElement("div");
        points.className = "history-points";
        const delta = Number(data.points_delta || 0);
        points.classList.toggle("negative", delta < 0);
        const amount = document.createElement("strong");
        amount.textContent = `${delta > 0 ? "+" : ""}${formatNumber(delta)} điểm`;
        const status = document.createElement("small");
        status.textContent = ({ confirmed: "Đã ghi nhận", pending: "Chờ xác nhận", rejected: "Không thành công" })[data.status] || "Chưa rõ trạng thái";
        points.append(amount, status);
        item.append(description, points);
        ui("historyList").append(item);
    });
    ui("loadMoreHistory").hidden = records.length <= historyLimit;
}

// 4. Tra cứu học sinh: chọn dữ liệu mẫu hoặc Firestore theo config.js.
async function lookupStudent(event, restoreCode) {
    event.preventDefault();
    if (!restoreCode && (studentChangeLocked() || lookupBusy)) {
        setMessage("studentMessage", "Hoàn tất phiên và chờ máy xử lý xong trước khi đổi học sinh.", true);
        return;
    }
    const enteredCode = restoreCode || ui("studentCode").value.trim();
    if (!/^\d{1,30}$/.test(enteredCode)) {
        setMessage("studentMessage", "Mã học sinh chỉ gồm các chữ số từ 0 đến 9.", true);
        return;
    }
    const code = enteredCode.padStart(3, "0");
    const version = ++lookupVersion;
    const restoreSessionId = restoreCode ? watchedSessionId : null;
    lookupBusy = true;
    stopStudentListeners();
    selectedStudentCode = undefined;
    showStudentEmpty();
    ui("studentCode").value = code;
    ui("lookupButton").disabled = true;
    setMessage("studentMessage", "Đang tìm học sinh…");
    try {
        if (STUDENT_DATA_SOURCE === "demo") {
            const student = Object.prototype.hasOwnProperty.call(DEMO_STUDENTS, code) ? DEMO_STUDENTS[code] : null;
            if (!student) {
                setMessage("studentMessage", "Không tìm thấy học sinh. Thử mã mẫu 001 đến 010.", true);
                return;
            }
            selectedStudentCode = code;
            renderStudent(code, student);
            setMessage("studentMessage", "Đang xem dữ liệu mẫu trong JS — điểm và lịch sử minh họa.");
            historyLimit = HISTORY_PAGE_SIZE;
            watchHistory(code, version);
            return;
        }
        const doc = await serverRead(db.collection("students").doc(code));
        if (version !== lookupVersion) return;
        if (restoreCode && restoreSessionId !== watchedSessionId) return;
        if (!restoreCode && (stationState.active_session_id || stationState.pending_event_id)) return;
        if (!doc.exists) {
            setMessage("studentMessage", "Không tìm thấy mã học sinh. Kiểm tra mã hoặc liên hệ người quản lý.", true);
            return;
        }
        if (doc.data().active !== true) {
            setMessage("studentMessage", "Mã học sinh này chưa được kích hoạt.", true);
            return;
        }
        selectedStudentCode = code;
        renderStudent(code, doc.data());
        setMessage("studentMessage", "Đã tìm thấy học sinh.");
        studentUnsubscribe = db.collection("students").doc(code).onSnapshot({ includeMetadataChanges: true }, current => {
            if (version !== lookupVersion) return;
            if (!current.exists || current.data().active !== true) {
                if (stationState.active_session_id) {
                    setMessage("studentMessage", "Học sinh không còn hoạt động. Hoàn tất phiên hoặc nhờ quản lý kiểm tra lượt rác đang chờ.", true);
                    return;
                }
                stopStudentListeners();
                selectedStudentCode = undefined;
                showStudentEmpty();
                setMessage("studentMessage", "Học sinh không còn hoạt động.", true);
                return;
            }
            renderStudent(code, current.data());
            setMessage("studentMessage", current.metadata.fromCache ? "Đang hiển thị dữ liệu lưu tạm; chờ kết nối máy chủ." : "Đã tìm thấy học sinh.");
        }, error => {
            if (version !== lookupVersion) return;
            if (stationState.active_session_id) {
                setMessage("studentMessage", databaseError(error), true);
                return;
            }
            stopStudentListeners();
            selectedStudentCode = undefined;
            showStudentEmpty();
            setMessage("studentMessage", databaseError(error), true);
        });
        historyLimit = HISTORY_PAGE_SIZE;
        watchHistory(code, version);
    } catch (error) {
        if (version === lookupVersion) setMessage("studentMessage", databaseError(error), true);
    } finally {
        if (version === lookupVersion) lookupBusy = false;
        syncSessionControls();
    }
}

// 5. Thống kê thùng rác và thao tác lấy rác.
async function lay_rac() {
    if (!stationUsable()) return;
    const password = prompt("Nhập mật khẩu lấy rác:");
    if (password === null) return;
    if (password !== "12345") {
        setMessage("binMessage", "Sai mật khẩu.", true);
        return;
    }
    ui("btnReset").disabled = true;
    try {
        await sessionStore.resetBin();
        setMessage("binMessage", "Đã đặt lại số lượng rác trong thùng. Điểm học sinh được giữ nguyên.");
    } catch (error) {
        setMessage("binMessage", databaseError(error), true);
    } finally {
        syncSessionControls();
    }
}

function batDauLangNgheFirebase() {
    db.collection("du_lieu_tram").doc("thong_tin_hien_tai").onSnapshot({ includeMetadataChanges: true }, doc => {
        const data = doc.exists ? doc.data() : {};
        ui("txtKetQuaAI").textContent = CLASS_LABELS[data.ai_result] || data.ai_result || "Chưa có rác";
        ui("slhc").textContent = formatNumber(data.rac_huu_co);
        ui("slvc").textContent = formatNumber(data.rac_vo_co);
        ui("slrk").textContent = formatNumber(data.rac_khac);
        ui("txtTiLe").textContent = data.ai_result && Number.isFinite(data.ti_le)
            ? `Độ tin cậy: ${data.ti_le.toFixed(1)}%` : "Đặt từng món rác vào vùng nhận diện";
        ui("txtThoiGian").textContent = data.time ? formatTime(data.time) : "Chưa có lượt bỏ rác";
        ui("txtStatusNet").textContent = doc.metadata.fromCache ? "Đang chờ đồng bộ" : "● Đã đồng bộ";
        ui("txtStatusNet").className = doc.metadata.fromCache ? "connection" : "connection online";
    }, error => {
        ui("txtStatusNet").textContent = "Không thể đồng bộ";
        ui("txtStatusNet").className = "connection error";
        setMessage("binMessage", databaseError(error), true);
    });
}

// 6. Xử lý thao tác bàn phím số, nhập lại mã và phân trang.
function handleKeypadInput(event) {
    const key = event.target.closest("button[data-key]");
    if (!key || studentChangeLocked() || lookupBusy) return;
    if (key.dataset.key === "enter") {
        ui("studentForm").requestSubmit();
        return;
    }
    const input = ui("studentCode");
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    let caret = start;
    if (key.dataset.key === "delete") {
        const deleteFrom = start === end ? Math.max(0, start - 1) : start;
        input.value = input.value.slice(0, deleteFrom) + input.value.slice(end);
        caret = deleteFrom;
    } else {
        const nextValue = input.value.slice(0, start) + key.dataset.key + input.value.slice(end);
        if (nextValue.length > input.maxLength) return;
        input.value = nextValue;
        caret = start + 1;
    }
    input.focus();
    input.setSelectionRange(caret, caret);
}

function editStudentCode() {
    if (studentChangeLocked() || lookupBusy) return;
    if (ui("studentDetails").hidden) return;
    ++lookupVersion;
    stopStudentListeners();
    selectedStudentCode = undefined;
    showStudentEmpty();
    ui("studentCode").select();
    setMessage("studentMessage", "Nhập mã để tìm học sinh.");
}

function loadMoreHistory() {
    if (!selectedStudentCode) return;
    historyLimit += HISTORY_PAGE_SIZE;
    watchHistory(selectedStudentCode, lookupVersion);
}

// Phiên dùng chung giữa các màn hình của cùng một STATION_ID.
function stationUsable() {
    return stationReady && sessionReady && globalThis.navigator?.onLine !== false;
}

function studentChangeLocked() {
    return !!stationState.active_session_id || !!stationState.pending_event_id || sessionActionBusy ||
        (STUDENT_DATA_SOURCE === "firebase" && !stationUsable());
}

function syncSessionControls() {
    const usable = stationUsable();
    const locked = studentChangeLocked() || lookupBusy;
    ui("studentCode").disabled = locked;
    ui("lookupButton").disabled = locked;
    ui("startSession").disabled = STUDENT_DATA_SOURCE !== "firebase" || !usable || !selectedStudentCode || locked;
    ui("finishSession").disabled = !usable || !activeSession || !!stationState.pending_event_id || sessionActionBusy;
    ui("btnReset").disabled = !usable || !!stationState.pending_event_id;
    if (ui("connectionMessage")) setMessage("connectionMessage", STUDENT_DATA_SOURCE !== "firebase" ? "" :
        !usable ? "Đang chờ xác minh dữ liệu từ máy chủ. Tạm khóa đổi học sinh và thao tác phiên." :
        stationState.pending_event_id ? "Máy đang xử lý rác. Mã học sinh được giữ nguyên đến khi xử lý và đồng bộ xong." : "", !usable);
    ui("sessionPoints").textContent = activeSession ? formatNumber(activeSession.points_earned) : "—";
    ui("latestPoints").textContent = activeSession?.items_count ? `+${formatNumber(activeSession.latest_points)}` : "—";
    if (STUDENT_DATA_SOURCE === "demo") ui("sessionStatus").textContent = "Chế độ demo chỉ để xem giao diện. Chọn firebase trong config.js để bắt đầu phiên thật.";
}

async function runSessionAction(action) {
    if (sessionActionBusy || !stationUsable()) return;
    sessionActionBusy = true;
    syncSessionControls();
    try { await action(); }
    catch (error) { setMessage("studentMessage", databaseError(error), true); }
    finally { sessionActionBusy = false; syncSessionControls(); }
}

function startStudentSession() {
    if (!selectedStudentCode || studentChangeLocked() || lookupBusy || STUDENT_DATA_SOURCE !== "firebase") return;
    const code = selectedStudentCode;
    return runSessionAction(async () => {
        const id = await sessionStore.startSession(code);
        // Giữ khóa ngay khi transaction thành công, không chờ snapshot đến sau.
        if (!stationState.active_session_id) stationState.active_session_id = id;
        setMessage("studentMessage", "Phiên đã bắt đầu. Bạn có thể bỏ từng món rác để tích điểm.");
    });
}

function finishStudentSession(reason = "manual") {
    if (!activeSession || !stationUsable() || stationState.pending_event_id) return;
    const id = watchedSessionId;
    return runSessionAction(() => sessionStore.finishSession(id, reason));
}

function refreshSessionTimer() {
    if (!activeSession || !sessionStore) {
        ui("continueSession").hidden = true;
        return;
    }
    const seconds = Math.max(0, Math.ceil((sessionStore.millis(activeSession.expires_at) - Date.now()) / 1000));
    ui("continueSession").hidden = !!stationState.pending_event_id || seconds > warningSeconds || seconds === 0;
    ui("continueSession").disabled = !stationUsable() || sessionActionBusy;
    if (stationState.pending_event_id) {
        ui("sessionStatus").textContent = "Máy đang xử lý rác. Chờ DONE để ghi nhận điểm; chưa thể đổi hoặc kết thúc phiên.";
    } else {
        ui("sessionStatus").textContent = seconds > 0
            ? `Phiên đang hoạt động · tự kết thúc sau ${seconds}s nếu không bỏ rác hoặc tiếp tục phiên.`
            : "Phiên đã hết thời gian hoạt động. Đang kết thúc…";
        if (seconds === 0 && stationUsable() && Date.now() - lastExpiryAttempt > 5000) {
            lastExpiryAttempt = Date.now();
            void finishStudentSession("idle");
        }
    }
}

function watchActiveSession(id) {
    if (sessionUnsubscribe) sessionUnsubscribe();
    sessionListenerFailed = false;
    sessionReady = false;
    sessionUnsubscribe = sessionStore.session(id).onSnapshot({ includeMetadataChanges: true }, current => {
        if (watchedSessionId !== id) return;
        sessionReady = !current.metadata.fromCache && !current.metadata.hasPendingWrites;
        if (sessionReady) {
            const data = current.data();
            activeSession = data?.status === "active" ? data : undefined;
            if (activeSession && selectedStudentCode !== data.student_code && !lookupBusy && STUDENT_DATA_SOURCE === "firebase") {
                void lookupStudent({ preventDefault() {} }, data.student_code);
            }
        }
        syncSessionControls();
        refreshSessionTimer();
    }, error => {
        if (watchedSessionId !== id) return;
        sessionReady = false;
        sessionListenerFailed = true;
        syncSessionControls();
        setMessage("studentMessage", databaseError(error), true);
    });
}

function applyStationSnapshot(snapshot) {
    stationReady = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites && globalThis.navigator?.onLine !== false;
    if (!stationReady) { syncSessionControls(); return; }
    ++stationRevision;
    const next = snapshot.exists ? snapshot.data() : {};
    const id = next.active_session_id || null;
    stationState = next;
    if (id !== watchedSessionId) {
        ++lookupVersion;
        lookupBusy = false;
        if (sessionUnsubscribe) sessionUnsubscribe();
        const previous = activeSession;
        watchedSessionId = id;
        activeSession = undefined;
        sessionReady = !id;
        if (id) watchActiveSession(id);
        else {
            sessionListenerFailed = false;
            if (previous || selectedStudentCode) {
                stopStudentListeners();
                selectedStudentCode = undefined;
                ui("studentCode").value = "";
                showStudentEmpty();
                setMessage("studentMessage", previous
                    ? `Phiên đã kết thúc. Đã tích ${formatNumber(previous.points_earned)} điểm. Mời học sinh tiếp theo.`
                    : "Nhập mã để tìm học sinh.");
                ui("sessionStatus").textContent = "Bấm Bắt đầu trước khi bỏ rác để nhận điểm.";
            }
        }
    } else if (!id) sessionReady = true;
    else if (sessionListenerFailed) watchActiveSession(id);
    syncSessionControls();
    refreshSessionTimer();
}

function subscribeStation() {
    if (stationUnsubscribe) stationUnsubscribe();
    const version = ++stationWatchVersion;
    stationReady = false;
    stationListenerFailed = false;
    stationUnsubscribe = sessionStore.station.onSnapshot({ includeMetadataChanges: true }, snapshot => {
        if (version === stationWatchVersion) applyStationSnapshot(snapshot);
    }, error => {
        if (version !== stationWatchVersion) return;
        stationReady = false;
        stationListenerFailed = true;
        syncSessionControls();
        setMessage("studentMessage", databaseError(error), true);
    });
}

async function reconnectDashboard() {
    if (!sessionStore || connectionRetrying || globalThis.navigator?.onLine === false) return;
    connectionRetrying = true;
    try {
        if (stationListenerFailed) subscribeStation();
        const revision = stationRevision;
        const snapshot = await serverRead(sessionStore.station);
        if (revision === stationRevision) applyStationSnapshot(snapshot);
        if (sessionListenerFailed && watchedSessionId) watchActiveSession(watchedSessionId);
        if (selectedStudentCode) watchHistory(selectedStudentCode, lookupVersion);
    } catch (error) {
        stationReady = false;
        syncSessionControls();
        setMessage("connectionMessage", databaseError(error), true);
    } finally { connectionRetrying = false; }
}

function watchStationSession() {
    sessionStore = new SmartBinStore(db, STATION_ID, firebase.firestore);
    db.collection("reward_settings").doc("default").onSnapshot(snapshot => {
        const value = Number(snapshot.data()?.session_warning_seconds);
        if (Number.isFinite(value) && value >= 0) warningSeconds = value;
    }, error => setMessage("studentMessage", databaseError(error), true));
    subscribeStation();
    setInterval(refreshSessionTimer, 1000);
    setInterval(() => {
        if (!stationUsable() || stationListenerFailed || sessionListenerFailed) void reconnectDashboard();
    }, 5000);
    window.addEventListener("offline", () => {
        stationReady = false;
        syncSessionControls();
        setMessage("connectionMessage", "Mất mạng. Giữ nguyên học sinh và lượt đang xử lý; chờ đồng bộ lại.", true);
    });
    window.addEventListener("online", () => { void reconnectDashboard(); });
}

// 7. Đăng ký sự kiện và khởi tạo trang.
function bindStudentTabs() {
    ["points", "history"].forEach((name, index, names) => {
        ui(`${name}Tab`).addEventListener("click", () => selectStudentTab(name));
        ui(`${name}Tab`).addEventListener("keydown", event => {
            let target;
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") target = names[1 - index];
            if (event.key === "Home") target = names[0];
            if (event.key === "End") target = names[1];
            if (target) {
                event.preventDefault();
                selectStudentTab(target, true);
            }
        });
    });
}

function bindStudentEvents() {
    bindStudentTabs();
    ui("studentForm").addEventListener("submit", lookupStudent);
    ui("studentEmpty").addEventListener("click", handleKeypadInput);
    ui("studentCode").addEventListener("focus", editStudentCode);
    ui("loadMoreHistory").addEventListener("click", loadMoreHistory);
    ui("startSession").addEventListener("click", startStudentSession);
    ui("finishSession").addEventListener("click", () => { void finishStudentSession(); });
    ui("continueSession").addEventListener("click", () => {
        if (watchedSessionId) void runSessionAction(() => sessionStore.touchSession(watchedSessionId));
    });
}

function initializeFirebase() {
    try {
        firebase.initializeApp(firebaseConfig);
        db = firebase.firestore();
        ui("btnReset").addEventListener("click", lay_rac);
        batDauLangNgheFirebase();
        watchStationSession();
    } catch (error) {
        console.error(error);
        setMessage("binMessage", "Không tải được Firebase. Phần dữ liệu thùng rác chưa thể đồng bộ.", true);
        if (STUDENT_DATA_SOURCE !== "demo") {
            setMessage("studentMessage", "Không tải được Firebase. Kiểm tra mạng và tải lại trang.", true);
            ui("lookupButton").disabled = true;
        }
        ui("txtStatusNet").textContent = "Không thể kết nối";
        ui("txtStatusNet").className = "connection error";
        ui("btnReset").disabled = true;
    }
}

function initDashboard() {
    // Tra cứu mẫu vẫn hoạt động nếu Firebase gặp lỗi.
    bindStudentEvents();
    initializeFirebase();
}

initDashboard();
