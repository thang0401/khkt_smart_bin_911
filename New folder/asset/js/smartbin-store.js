"use strict";

// Mọi lượt phân loại có ID riêng; transaction bảo vệ khóa trạm và chống cộng lại.
globalThis.SmartBinStore = class SmartBinStore {
    constructor(db, stationId, firestore, now = () => Date.now()) {
        this.db = db;
        this.stationId = stationId;
        this.fs = firestore;
        this.now = now;
        this.station = db.collection("bin_stations").doc(stationId);
        this.settings = db.collection("reward_settings").doc("default");
        this.bin = db.collection("du_lieu_tram").doc("thong_tin_hien_tai");
    }

    session(id) { return this.db.collection("bin_sessions").doc(id); }
    event(id) { return this.db.collection("disposal_events").doc(id); }
    newEventId() { return this.db.collection("disposal_events").doc().id; }
    student(code) { return this.db.collection("students").doc(code); }
    stamp() { return this.fs.FieldValue.serverTimestamp(); }
    timestamp(ms) { return this.fs.Timestamp.fromMillis(ms); }
    millis(value) { return value && typeof value.toMillis === "function" ? value.toMillis() : 0; }
    data(snapshot) { return snapshot.exists ? snapshot.data() : {}; }
    fail(message) { throw new Error(message); }
    idle(settings) {
        const seconds = Number(settings.session_idle_seconds);
        return Number.isFinite(seconds) && seconds >= 15 ? seconds : 120;
    }

    async inspectDisposal(localId) {
        // Đọc khóa và event trong cùng transaction, tránh đọc hai trạng thái khác thời điểm.
        return this.db.runTransaction(async tx => {
            const station = this.data(await tx.get(this.station));
            const id = station.pending_event_id || localId;
            const doc = id ? await tx.get(this.event(id)) : null;
            return { station, id, exists: !!doc?.exists, event: doc ? this.data(doc) : {} };
        });
    }

    async startSession(code) {
        const ref = this.db.collection("bin_sessions").doc();
        await this.db.runTransaction(async tx => {
            const station = this.data(await tx.get(this.station));
            const student = this.data(await tx.get(this.student(code)));
            const settings = this.data(await tx.get(this.settings));
            const previous = station.active_session_id
                ? this.data(await tx.get(this.session(station.active_session_id))) : null;
            if (station.pending_event_id) this.fail("Máy đang xử lý rác; chưa thể bắt đầu phiên mới.");
            if (student.active !== true) this.fail("Học sinh không còn hoạt động.");
            if (previous?.status === "active" && this.millis(previous.expires_at) > this.now()) {
                this.fail("Trạm đang có phiên sử dụng. Hãy hoàn tất phiên hiện tại.");
            }
            const idle = this.idle(settings);
            if (previous?.status === "active") tx.update(this.session(station.active_session_id), {
                status: "expired", ended_at: this.stamp(), close_reason: "idle"
            });
            tx.set(ref, {
                station_id: this.stationId, student_code: code, status: "active",
                started_at: this.stamp(), last_activity_at: this.stamp(),
                expires_at: this.timestamp(this.now() + idle * 1000), idle_seconds: idle,
                points_earned: 0, items_count: 0, latest_points: 0
            });
            tx.set(this.station, { active_session_id: ref.id, pending_event_id: null, updated_at: this.stamp() }, { merge: true });
        });
        return ref.id;
    }

    async finishSession(id, reason = "manual") {
        return this.db.runTransaction(async tx => {
            const station = this.data(await tx.get(this.station));
            const session = this.data(await tx.get(this.session(id)));
            if (station.active_session_id !== id || session.status !== "active") return false;
            if (station.pending_event_id) this.fail("Chờ máy hoàn tất lượt rác hiện tại trước khi kết thúc phiên.");
            if (reason === "idle" && this.millis(session.expires_at) > this.now()) return false;
            tx.update(this.session(id), {
                status: reason === "idle" ? "expired" : "completed",
                ended_at: this.stamp(), close_reason: reason
            });
            tx.update(this.station, { active_session_id: null, updated_at: this.stamp() });
            return true;
        });
    }

    async touchSession(id) {
        return this.db.runTransaction(async tx => {
            const station = this.data(await tx.get(this.station));
            const session = this.data(await tx.get(this.session(id)));
            if (station.active_session_id !== id || session.status !== "active" ||
                this.millis(session.expires_at) <= this.now()) this.fail("Phiên đã hết hạn.");
            if (station.pending_event_id) this.fail("Máy đang xử lý; phiên sẽ được gia hạn khi nhận DONE.");
            tx.update(this.session(id), {
                last_activity_at: this.stamp(), expires_at: this.timestamp(this.now() + session.idle_seconds * 1000)
            });
        });
    }

    async prepareDisposal(wasteCode, confidence, controllerId, eventId, bluetoothDeviceId = null) {
        if (!["A", "B", "C"].includes(wasteCode)) this.fail("Loại rác không hợp lệ.");
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) this.fail("Điểm nhận diện không hợp lệ.");
        const ref = eventId ? this.event(eventId) : this.db.collection("disposal_events").doc();
        return this.db.runTransaction(async tx => {
            const station = this.data(await tx.get(this.station));
            const existing = await tx.get(ref);
            const settingsDoc = await tx.get(this.settings);
            const settings = this.data(settingsDoc);
            const session = station.active_session_id
                ? this.data(await tx.get(this.session(station.active_session_id))) : null;
            const student = session?.student_code
                ? this.data(await tx.get(this.student(session.student_code))) : null;
            if (existing.exists) this.fail("ID lượt phân loại đã tồn tại.");
            if (station.pending_event_id) this.fail("Trạm đang chờ xử lý một lượt rác khác.");
            const eligible = session?.status === "active" && this.millis(session.expires_at) > this.now() && student?.active === true;
            const points = settings.points_by_waste_code?.[wasteCode];
            if (!settingsDoc.exists || !Number.isInteger(points) || points < 0) this.fail("Chưa có cấu hình thưởng hợp lệ.");
            const data = {
                event_id: ref.id, station_id: this.stationId, controller_id: controllerId,
                bluetooth_device_id: bluetoothDeviceId,
                session_id: eligible ? station.active_session_id : null,
                student_code: eligible ? session.student_code : null,
                waste_code: wasteCode, confidence: Number(confidence.toFixed(1)),
                unit_points: eligible ? points : 0, quantity: 1, reward_version: settings.version,
                status: "pending", created_at: this.stamp()
            };
            if (session?.status === "active" && !eligible) tx.update(this.session(station.active_session_id), {
                status: "expired", ended_at: this.stamp(), close_reason: "idle_or_inactive"
            });
            if (eligible) tx.update(this.session(station.active_session_id), {
                last_activity_at: this.stamp(), expires_at: this.timestamp(this.now() + session.idle_seconds * 1000)
            });
            tx.set(ref, data);
            tx.set(this.station, {
                pending_event_id: ref.id, active_session_id: eligible ? station.active_session_id : null,
                updated_at: this.stamp()
            }, { merge: true });
            return { ...data, created_at: null };
        });
    }

    async confirmDisposal(id, controllerId) {
        return this.db.runTransaction(async tx => {
            const event = this.data(await tx.get(this.event(id)));
            if (event.station_id !== this.stationId || event.controller_id !== controllerId) this.fail("Lượt rác không thuộc thiết bị này.");
            if (event.status === "confirmed") return { ...event, duplicate: true };
            if (event.status !== "pending") this.fail("Lượt rác không còn chờ xác nhận.");
            if (!["A", "B", "C"].includes(event.waste_code) || !Number.isInteger(event.unit_points) || event.unit_points < 0) {
                this.fail("Dữ liệu lượt rác không hợp lệ; cần kiểm tra trước khi ghi điểm.");
            }
            const station = this.data(await tx.get(this.station));
            const bin = this.data(await tx.get(this.bin));
            const session = event.session_id ? this.data(await tx.get(this.session(event.session_id))) : null;
            const student = event.student_code ? this.data(await tx.get(this.student(event.student_code))) : null;
            const historyRef = event.student_code ? this.student(event.student_code).collection("point_history").doc(id) : null;
            const history = historyRef ? await tx.get(historyRef) : null;
            if (station.pending_event_id !== id) this.fail("Khóa lượt rác đã thay đổi; cần kiểm tra trạm.");
            if (event.student_code && (!student?.active || session?.student_code !== event.student_code ||
                session.status !== "active" || session.station_id !== this.stationId || station.active_session_id !== event.session_id)) {
                this.fail("Học sinh hoặc phiên không còn hợp lệ; cần người quản lý kiểm tra lượt rác.");
            }
            if (history?.exists) this.fail("Lịch sử đã tồn tại nhưng lượt rác chưa xác nhận; cần kiểm tra dữ liệu.");
            const countField = { A: "rac_vo_co", B: "rac_huu_co", C: "rac_khac" }[event.waste_code];
            tx.set(this.bin, {
                ai_result: event.waste_code, ti_le: event.confidence, time: this.stamp(),
                [countField]: Number(bin[countField] || 0) + 1
            }, { merge: true });
            if (event.student_code) {
                tx.update(this.student(event.student_code), {
                    points_balance: Number(student.points_balance || 0) + event.unit_points,
                    points_earned: Number(student.points_earned || 0) + event.unit_points,
                    updated_at: this.stamp()
                });
                tx.set(historyRef, {
                    event_id: id, station_id: this.stationId, session_id: event.session_id,
                    type: "earn", waste_code: event.waste_code, points_delta: event.unit_points,
                    unit_points: event.unit_points, quantity: 1, reward_version: event.reward_version,
                    status: "confirmed", created_at: event.created_at, confirmed_at: this.stamp()
                });
                tx.update(this.session(event.session_id), {
                    points_earned: Number(session.points_earned || 0) + event.unit_points,
                    items_count: Number(session.items_count || 0) + 1, latest_points: event.unit_points,
                    last_activity_at: this.stamp(), expires_at: this.timestamp(this.now() + session.idle_seconds * 1000)
                });
            }
            tx.update(this.event(id), { status: "confirmed", confirmed_at: this.stamp() });
            tx.update(this.station, { pending_event_id: null, last_event_id: id, updated_at: this.stamp() });
            return event;
        });
    }

    // Chỉ gọi khi chắc chắn CHƯA gửi lệnh ra Bluetooth (ví dụ không lưu được ID cục bộ).
    async cancelUnsentDisposal(id, controllerId) {
        return this.db.runTransaction(async tx => {
            const event = this.data(await tx.get(this.event(id)));
            const station = this.data(await tx.get(this.station));
            if (event.status !== "pending" || event.station_id !== this.stationId || event.controller_id !== controllerId || station.pending_event_id !== id) return;
            tx.update(this.event(id), { status: "rejected", reason: "not_sent", ended_at: this.stamp() });
            tx.update(this.station, { pending_event_id: null, updated_at: this.stamp() });
        });
    }

    async resetBin() {
        return this.db.runTransaction(async tx => {
            const station = this.data(await tx.get(this.station));
            if (station.pending_event_id) this.fail("Máy đang xử lý rác; chưa thể lấy rác.");
            tx.set(this.bin, {
                ai_result: "", rac_vo_co: 0, rac_huu_co: 0, rac_khac: 0,
                ti_le: this.fs.FieldValue.delete(), time: this.fs.FieldValue.delete()
            }, { merge: true });
        });
    }
};
