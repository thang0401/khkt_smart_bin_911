"use strict";

// Nhật ký được lưu TRƯỚC khi chuẩn bị Firestore và TRƯỚC khi ghi Bluetooth.
// Không phát lại A/B/C khi không biết chắc kết quả vật lý của lần ghi trước.
globalThis.SmartBinDevice = class SmartBinDevice {
    static async acquireBrowserLock(manager, name) {
        if (!manager?.request) throw new Error("Trình duyệt cần hỗ trợ Web Locks để chỉ một tab điều khiển HM-10.");
        let release;
        let respond;
        const hold = new Promise(resolve => { release = resolve; });
        const acquired = new Promise(resolve => { respond = resolve; });
        void manager.request(name, { ifAvailable: true }, async lock => {
            respond(lock ? release : null);
            if (lock) await hold;
        }).catch(() => respond(null));
        return acquired;
    }

    constructor(store, storage, onState, onConfirmed, options = {}) {
        this.store = store;
        this.storage = storage;
        this.onState = onState;
        this.onConfirmed = onConfirmed;
        this.key = `smartbin.pending.${store.stationId}`;
        const controllerKey = `smartbin.controller.${store.stationId}`;
        this.id = storage.getItem(controllerKey) || globalThis.crypto.randomUUID();
        storage.setItem(controllerKey, this.id);
        // Khôi phục nhật ký ngay cả khi mạng đang mất để không bỏ lỡ DONE từ BLE.
        this.pending = this.saved();
        if (this.pending) this.pending.phase ||= "awaiting_done";
        this.sending = false;
        this.settling = false;
        this.recovering = false;
        this.buffer = "";
        this.ready = false;
        this.cooldownUntil = 0;
        this.writeTimeoutMs = options.writeTimeoutMs ?? 7000;
        this.syncTimeoutMs = options.syncTimeoutMs ?? 12000;
        this.retryAt = 0;
        this.retryDelay = 1000;
        this.online = options.online || (() => globalThis.navigator?.onLine !== false);
    }

    emit(message) {
        // Lỗi render/audio không được biến giao dịch đã commit thành lỗi đồng bộ.
        try { this.onState(message); } catch (error) { console.error(error); }
    }
    notify(result) {
        try { this.onConfirmed(result); } catch (error) { console.error(error); }
    }
    save() { this.storage.setItem(this.key, JSON.stringify(this.pending)); }
    saved() {
        const raw = this.storage.getItem(this.key);
        if (!raw) return null;
        const value = JSON.parse(raw);
        if (!value || typeof value.eventId !== "string") throw new Error("Nhật ký lượt rác không hợp lệ; cần kiểm tra trước khi gửi tiếp.");
        return value;
    }
    clearPending() {
        this.pending = null;
        this.buffer = "";
        try { this.storage.removeItem(this.key); } catch { /* Lần phục hồi sau sẽ kiểm tra server. */ }
    }
    retryLater(error) {
        this.retryAt = Date.now() + this.retryDelay;
        this.retryDelay = Math.min(30000, this.retryDelay * 2);
        this.emit(`Chưa đồng bộ được; giữ lượt hiện tại và tự thử lại. ${error.message}`);
    }
    resetRetry() { this.retryAt = 0; this.retryDelay = 1000; }
    acceptsBluetoothDevice(id) { return !this.pending?.bluetoothDeviceId || this.pending.bluetoothDeviceId === id; }

    async recover() {
        if (this.sending || this.settling || this.recovering) return;
        this.recovering = true;
        this.ready = false;
        try {
            const saved = this.saved();
            const local = this.pending && saved && this.pending.eventId === saved.eventId
                ? { ...saved, ...this.pending, ack: !!saved?.ack || !!this.pending?.ack }
                : this.pending || saved;
            const inspected = await this.waitFor(this.store.inspectDisposal(local?.eventId), this.syncTimeoutMs, "Quá thời gian đọc khóa trạm.");
            const { station, id, event } = inspected;
            if (local && station.pending_event_id && station.pending_event_id !== local.eventId) {
                throw new Error("Khóa trạm khác nhật ký cục bộ. Chưa thể tự bỏ lượt cũ.");
            }
            if (!id) { this.clearPending(); this.ready = true; this.resetRetry(); return; }
            if (inspected.exists && event.controller_id !== this.id) throw new Error("Trạm còn lượt của thiết bị khác. Mở lại đúng thiết bị gửi lệnh.");
            if (!inspected.exists && local && ["dispatching", "awaiting_done"].includes(local.phase)) {
                throw new Error("Không còn bản ghi server của lệnh có thể đã gửi; cần quản lý kiểm tra trước khi mở khóa.");
            }
            if (!inspected.exists || event.status === "confirmed" || event.status === "rejected") {
                if (station.pending_event_id) throw new Error("Khóa trạm chưa khớp trạng thái lượt rác; cần kiểm tra dữ liệu.");
                this.clearPending(); this.ready = true; this.resetRetry();
                this.cooldownUntil = Date.now() + 1500;
                this.emit(event.status === "confirmed" ? "Đã xác minh lượt trước được ghi nhận; không cộng lại." : "Lượt trước chưa gửi hoặc đã hủy; đã đồng bộ lại trạm.");
                return;
            }
            if (station.pending_event_id !== id) throw new Error("Event còn pending nhưng không có khóa tương ứng; cần kiểm tra trạm.");
            const memory = this.pending?.eventId === id ? this.pending : null;
            const journal = local?.eventId === id ? local : { eventId: id, phase: "awaiting_done", ack: false, startedAt: Date.now() };
            this.pending = { ...journal, ...memory, ack: !!journal.ack || !!memory?.ack };
            if (event.bluetooth_device_id) this.pending.bluetoothDeviceId = event.bluetooth_device_id;
            // Các nhật ký cũ chưa có phase được coi là có thể đã gửi, tuyệt đối không hủy tự động.
            this.pending.phase ||= "awaiting_done";
            if (["preparing", "prepared", "cancel_unsent"].includes(this.pending.phase)) {
                await this.store.cancelUnsentDisposal(id, this.id);
                this.clearPending();
                this.emit("Đã hủy lượt chắc chắn chưa gửi ra Bluetooth. Có thể nhận diện lại.");
            } else {
                // ACK trong bộ nhớ được giữ ngay cả khi localStorage từng ghi thất bại.
                try { this.save(); } catch { this.emit("Không lưu được nhật ký; giữ trang mở cho đến khi xử lý xong."); }
                this.emit(this.pending.ack ? "Đã có DONE, đang thử đồng bộ điểm…" : "Khôi phục lượt đang chờ DONE. Không gửi lại lệnh.");
            }
            this.ready = true;
            this.resetRetry();
        } catch (error) {
            this.retryLater(error);
        } finally { this.recovering = false; }
        if (this.pending?.ack && this.ready) await this.settle();
    }

    async waitFor(operation, timeoutMs, message) {
        let timer;
        try {
            return await Promise.race([
                operation,
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
            ]);
        } finally { clearTimeout(timer); }
    }

    writeWithTimeout(characteristic, command) {
        return this.waitFor(Promise.resolve().then(() => characteristic.writeValue(new TextEncoder().encode(command))),
            this.writeTimeoutMs, "Bluetooth chưa trả kết quả ghi trong thời gian chờ.");
    }

    async send(wasteCode, score, characteristic, bluetoothDeviceId = null) {
        if (!this.online() || !this.ready || this.pending || this.sending || this.recovering || Date.now() < this.cooldownUntil) return false;
        this.sending = true;
        let writeStarted = false;
        this.pending = { eventId: this.store.newEventId(), phase: "preparing", ack: false, startedAt: Date.now(), bluetoothDeviceId };
        try {
            this.save();
            await this.store.prepareDisposal(wasteCode, score, this.id, this.pending.eventId, bluetoothDeviceId);
            this.pending.phase = "prepared";
            this.save();
            if (!this.online()) throw new Error("Mất mạng trước khi gửi Bluetooth.");
            // phase dispatching được ghi bền vững trước lời gọi có tác động vật lý.
            this.pending.phase = "dispatching";
            this.save();
            this.buffer = "";
            writeStarted = true;
            await this.writeWithTimeout(characteristic, wasteCode);
            this.pending.phase = "awaiting_done";
            try { this.save(); } catch { /* phase dispatching trên đĩa vẫn phục hồi an toàn. */ }
            this.emit("Đã gửi lệnh. Đang chờ DONE từ thùng rác…");
            return true;
        } catch (error) {
            this.ready = false;
            // Nếu lưu dispatching thất bại, lời gọi writeValue chưa chạy: có thể hủy.
            if (!writeStarted) this.pending.phase = "cancel_unsent";
            this.retryLater(error);
            return false;
        } finally {
            this.sending = false;
            if (this.pending?.ack) await this.settle();
            else if (!this.ready) await this.recover();
        }
    }

    async receive(text) {
        if (!this.pending || !["dispatching", "awaiting_done"].includes(this.pending.phase)) { this.buffer = ""; return; }
        this.buffer = (this.buffer + text.toUpperCase()).slice(-128);
        if (!/(?:^|\s)DONE(?=\s|$)/.test(this.buffer)) return;
        this.buffer = "";
        this.pending.ack = true;
        try { this.save(); } catch { this.emit("Không lưu được DONE cục bộ; giữ trang mở để đồng bộ xong."); }
        if (!this.sending) await this.settle();
    }

    async settle() {
        if (!this.online() || !this.pending?.ack || this.sending || this.settling || this.recovering) return;
        this.settling = true;
        const id = this.pending.eventId;
        try {
            // Có thể thử lại cùng ID dù lần trước đã commit nhưng không trả lời.
            const result = await this.waitFor(this.store.confirmDisposal(id, this.id), this.syncTimeoutMs, "Quá thời gian xác minh ghi điểm; sẽ đối chiếu lại cùng ID.");
            this.clearPending();
            this.ready = true;
            this.resetRetry();
            this.cooldownUntil = Date.now() + 1500;
            this.emit(result.student_code ? `Đã ghi nhận +${result.unit_points} điểm cho học sinh ${result.student_code}.` : "Đã phân loại xong, không có phiên học sinh để cộng điểm.");
            if (!result.duplicate) this.notify(result);
        } catch (error) {
            this.retryLater(error);
        } finally { this.settling = false; }
    }

    async tick(force = false) {
        if (!this.online() || this.sending || this.settling || this.recovering || (!force && Date.now() < this.retryAt)) return;
        if (this.pending?.ack) return this.settle();
        if (!this.ready || this.pending || force) await this.recover();
        if (this.pending && !this.pending.ack && Date.now() - this.pending.startedAt >= 7000) {
            this.emit("Chưa có DONE. Chưa cộng điểm; giữ khóa lượt rác. Kết nối lại đúng HM-10 để nhận phản hồi.");
        }
    }
};
