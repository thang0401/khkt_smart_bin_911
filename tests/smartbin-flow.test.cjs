const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

class Timestamp {
    constructor(value) { this.value = value; }
    toMillis() { return this.value; }
    static fromMillis(value) { return new Timestamp(value); }
}
const copy = value => {
    if (value instanceof Timestamp) return new Timestamp(value.value);
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
    return value;
};

function fixture() {
    let clock = Date.now();
    let counter = 0;
    let tail = Promise.resolve();
    const data = new Map();
    const transform = value => {
        if (value?.serverTime) return new Timestamp(clock);
        if (value instanceof Timestamp) return copy(value);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, transform(v)]));
        return value;
    };
    const snapshot = ref => ({ exists: data.has(ref.path), data: () => copy(data.get(ref.path)) });
    const ref = location => ({
        path: location, id: location.split('/').at(-1),
        collection: name => collection(`${location}/${name}`),
        get: async () => snapshot(ref(location))
    });
    const collection = location => ({ doc: id => ref(`${location}/${id || `auto-${++counter}`}`) });
    const db = {
        collection,
        failNext: false,
        runTransaction(fn) {
            const work = tail.then(async () => {
                if (db.failNext) { db.failNext = false; throw new Error('offline'); }
                const writes = [];
                const tx = {
                    get: async r => { assert.equal(writes.length, 0, 'all reads must precede writes'); if (db.failReads) throw new Error('offline'); return snapshot(r); },
                    set: (r, v, options) => writes.push({ r, v, merge: options?.merge }),
                    update: (r, v) => { assert.ok(data.has(r.path), `update missing ${r.path}`); writes.push({ r, v, merge: true }); }
                };
                const result = await fn(tx);
                for (const w of writes) {
                    const next = w.merge ? { ...data.get(w.r.path) } : {};
                    for (const [key, value] of Object.entries(w.v)) {
                        if (value?.deleteField) delete next[key];
                        else next[key] = transform(value);
                    }
                    data.set(w.r.path, next);
                }
                if (db.loseResponseOnce && writes.length) { db.loseResponseOnce = false; throw new Error('response lost after commit'); }
                return result;
            });
            tail = work.catch(() => {});
            return work;
        }
    };
    const api = { Timestamp, FieldValue: { serverTimestamp: () => ({ serverTime: true }), delete: () => ({ deleteField: true }) } };
    const context = vm.createContext({ TextEncoder, Date, setTimeout, clearTimeout, console: { error() {} }, crypto: { randomUUID } });
    for (const name of ['smartbin-store.js', 'device-controller.js']) vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', 'New folder', 'asset', 'js', name), 'utf8'), context
    );
    const store = new context.SmartBinStore(db, 'NLS_TN01', api, () => clock);
    data.set('reward_settings/default', { version: 2, points_by_waste_code: { A: 2, B: 3, C: 1 }, session_idle_seconds: 120 });
    for (const code of ['001', '002']) data.set(`students/${code}`, { active: true, points_balance: 0, points_earned: 0, points_spent: 0 });
    const local = new Map();
    const storage = { getItem: k => local.get(k) || null, setItem: (k, v) => local.set(k, v), removeItem: k => local.delete(k) };
    const messages = [];
    const makeDevice = (options, confirmed = () => {}) => new context.SmartBinDevice(store, storage, message => messages.push(message), confirmed, options);
    return { data, db, store, makeDevice, local, storage, context, messages, advance: ms => { clock += ms; } };
}

async function runTests() {
    const passed = [];
    async function test(name, fn) { await fn(); passed.push(name); }

    await test('session start/finish and concurrent start lock', async () => {
        const f = fixture();
        const results = await Promise.allSettled([f.store.startSession('001'), f.store.startSession('002')]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        const id = results.find(r => r.status === 'fulfilled').value;
        await f.store.finishSession(id);
        assert.equal(f.data.get(`bin_sessions/${id}`).status, 'completed');
        assert.equal(f.data.get('bin_stations/NLS_TN01').active_session_id, null);
    });
    await test('idle expiry and renewal, including expiry while dashboard closed', async () => {
        const f = fixture();
        const id = await f.store.startSession('001');
        f.advance(110000);
        await f.store.touchSession(id);
        f.advance(20000);
        assert.equal(await f.store.finishSession(id, 'idle'), false);
        f.advance(121000);
        assert.equal(await f.store.finishSession(id, 'idle'), true);
        const next = await f.store.startSession('002');
        f.advance(121000);
        await f.store.startSession('001');
        assert.equal(f.data.get(`bin_sessions/${next}`).status, 'expired');
    });
    await test('pending does not credit; DONE transaction credits exactly once', async () => {
        const f = fixture();
        const id = await f.store.startSession('001');
        const e = await f.store.prepareDisposal('B', 92, 'device');
        assert.equal(f.data.get('students/001').points_balance, 0);
        await assert.rejects(f.store.finishSession(id), /Chờ máy/);
        await assert.rejects(f.store.startSession('002'), /đang xử lý/);
        await assert.rejects(f.store.prepareDisposal('A', 80, 'device'), /lượt rác khác/);
        await assert.rejects(f.store.resetBin(), /đang xử lý/);
        f.advance(150000);
        await Promise.all([f.store.confirmDisposal(e.event_id, 'device'), f.store.confirmDisposal(e.event_id, 'device')]);
        assert.equal(f.data.get('students/001').points_balance, 3);
        assert.equal(f.data.get('students/001').points_earned, 3);
        assert.equal(f.data.get('students/002').points_balance, 0);
        assert.equal(f.data.get(`bin_sessions/${id}`).items_count, 1);
        assert.equal(f.data.get('du_lieu_tram/thong_tin_hien_tai').rac_huu_co, 1);
        assert.equal([...f.data.keys()].filter(k => k.includes('/point_history/')).length, 1);
        assert.equal(f.data.get(`students/001/point_history/${e.event_id}`).points_delta, 3);
    });
    await test('reward snapshot stays fixed after config change', async () => {
        const f = fixture(); await f.store.startSession('001');
        const e = await f.store.prepareDisposal('A', 90, 'device');
        f.data.get('reward_settings/default').points_by_waste_code.A = 50;
        await f.store.confirmDisposal(e.event_id, 'device');
        assert.equal(f.data.get('students/001').points_balance, 2);
    });
    await test('no session or expired session counts waste but awards nobody', async () => {
        const f = fixture();
        let e = await f.store.prepareDisposal('C', 90, 'device');
        await f.store.confirmDisposal(e.event_id, 'device');
        const id = await f.store.startSession('001'); f.advance(121000);
        e = await f.store.prepareDisposal('A', 90, 'device');
        assert.equal(e.student_code, null);
        await f.store.confirmDisposal(e.event_id, 'device');
        assert.equal(f.data.get('students/001').points_balance, 0);
        assert.equal(f.data.get(`bin_sessions/${id}`).status, 'expired');
        assert.equal(f.data.get('du_lieu_tram/thong_tin_hien_tai').rac_vo_co, 1);
    });
    await test('reject invalid student/class, wrong controller and invalid reward config', async () => {
        const f = fixture();
        await assert.rejects(f.store.startSession('999'));
        await assert.rejects(f.store.prepareDisposal('X', 80, 'device'));
        await assert.rejects(f.store.prepareDisposal('A', NaN, 'device'));
        const e = await f.store.prepareDisposal('A', 80, 'device');
        await assert.rejects(f.store.confirmDisposal(e.event_id, 'other'));
        await f.store.cancelUnsentDisposal(e.event_id, 'device');
        f.data.get('reward_settings/default').points_by_waste_code.A = -1;
        await assert.rejects(f.store.prepareDisposal('A', 90, 'device'));
    });
    await test('reset bin preserves points/history and only unsent cancellation unlocks', async () => {
        const f = fixture(); await f.store.startSession('001');
        const e = await f.store.prepareDisposal('C', 90, 'device');
        await f.store.confirmDisposal(e.event_id, 'device');
        await f.store.resetBin();
        assert.equal(f.data.get('students/001').points_balance, 1);
        assert.equal(f.data.get(`students/001/point_history/${e.event_id}`).points_delta, 1);
        assert.equal(f.data.get('du_lieu_tram/thong_tin_hien_tai').rac_khac, 0);
    });
    await test('fragmented/repeated DONE, failed sync retry, no repeated BLE write', async () => {
        const f = fixture(); await f.store.startSession('001');
        const device = f.makeDevice(); await device.recover(); let sent = 0;
        await device.send('B', 90, { writeValue: async () => { sent++; } });
        const id = device.pending.eventId;
        await device.receive('D'); assert.equal(f.data.get('students/001').points_balance, 0);
        f.db.failNext = true;
        await device.receive('ONE'); assert.equal(device.pending.ack, true);
        await device.tick(true); await device.receive('DONE');
        assert.equal(f.data.get('students/001').points_balance, 3);
        assert.equal(f.data.get(`disposal_events/${id}`).status, 'confirmed');
        assert.equal(sent, 1);
    });
    await test('reload restores ACK and pending lock without resending physical command', async () => {
        const f = fixture(); await f.store.startSession('001');
        const d = f.makeDevice(); await d.recover();
        await d.send('A', 90, { writeValue: async () => {} });
        f.db.failNext = true; await d.receive('DONE');
        const recovered = f.makeDevice(); await recovered.recover();
        assert.equal(recovered.pending, null);
        assert.equal(f.data.get('students/001').points_balance, 2);
    });
    await test('timeout never credits and early ACK during write credits once', async () => {
        const f = fixture(); await f.store.startSession('001');
        const d = f.makeDevice(); await d.recover();
        await d.send('C', 90, { writeValue: async () => { await d.receive('DONE'); } });
        assert.equal(f.data.get('students/001').points_balance, 1);
        const g = fixture(); const pending = g.makeDevice(); await pending.recover();
        await pending.send('B', 90, { writeValue: async () => { throw new Error('disconnect'); } });
        pending.pending.startedAt = Date.now() - 8000; await pending.tick();
        assert.ok(pending.pending);
        assert.equal(g.data.get('students/001').points_balance, 0);
        assert.equal(g.data.get('bin_stations/NLS_TN01').pending_event_id, pending.pending.eventId);
    });
    await test('offline startup automatically recovers and does not send while offline', async () => {
        const f = fixture(); let online = false;
        const d = f.makeDevice({ online: () => online });
        f.db.failReads = true; await d.recover();
        assert.equal(d.ready, false);
        let sends = 0;
        assert.equal(await d.send('A', 90, { writeValue: async () => { sends++; } }), false);
        f.db.failReads = false; online = true;
        await d.tick(true);
        assert.equal(d.ready, true); assert.equal(sends, 0);
    });
    await test('lost prepare response cancels proven-unsent event and releases the lock', async () => {
        const f = fixture(); const d = f.makeDevice(); await d.recover();
        f.db.loseResponseOnce = true; let sends = 0;
        await d.send('B', 90, { writeValue: async () => { sends++; } });
        assert.equal(sends, 0); assert.equal(d.pending, null); assert.equal(d.ready, true);
        assert.equal(f.data.get('bin_stations/NLS_TN01').pending_event_id, null);
        const events = [...f.data.entries()].filter(([p]) => p.startsWith('disposal_events/'));
        assert.equal(events.length, 1); assert.equal(events[0][1].status, 'rejected');
    });
    await test('DONE received while preparing cannot award points', async () => {
        const f = fixture(); await f.store.startSession('001');
        const d = f.makeDevice(); await d.recover();
        const prepare = f.store.prepareDisposal.bind(f.store);
        let resume; const gate = new Promise(resolve => { resume = resolve; });
        f.store.prepareDisposal = async (...args) => { await gate; return prepare(...args); };
        const sending = d.send('B', 90, { writeValue: async () => {} });
        await d.receive('DONE'); resume(); await sending;
        assert.equal(f.data.get('students/001').points_balance, 0);
        assert.equal(d.pending.ack, false);
        await d.receive('DONE'); assert.equal(f.data.get('students/001').points_balance, 3);
    });
    await test('hung BLE write times out, releases the JS send guard and still accepts DONE', async () => {
        const f = fixture(); await f.store.startSession('001');
        const d = f.makeDevice({ writeTimeoutMs: 5 }); await d.recover();
        await d.send('A', 90, { writeValue: () => new Promise(() => {}) }, 'ble-original');
        assert.equal(d.sending, false); assert.ok(d.pending);
        assert.equal(f.data.get('students/001').points_balance, 0);
        assert.equal(d.acceptsBluetoothDevice('ble-other'), false);
        assert.equal(d.acceptsBluetoothDevice('ble-original'), true);
        await d.receive('DONE'); assert.equal(f.data.get('students/001').points_balance, 2);
    });
    await test('ACK held in memory survives failed localStorage writes and reconnect', async () => {
        const f = fixture(); await f.store.startSession('001'); let online = true;
        const d = f.makeDevice({ online: () => online }); await d.recover();
        await d.send('B', 90, { writeValue: async () => {} });
        const save = f.storage.setItem;
        f.storage.setItem = () => { throw new Error('quota'); };
        online = false; await d.receive('DONE');
        assert.equal(d.pending.ack, true); assert.equal(f.data.get('students/001').points_balance, 0);
        online = true; await d.recover();
        assert.equal(f.data.get('students/001').points_balance, 3); assert.equal(d.pending, null);
        f.storage.setItem = save;
    });
    await test('render/audio exceptions after confirmed commit never imply sync failure', async () => {
        const f = fixture(); await f.store.startSession('001');
        const d = f.makeDevice({}, () => { throw new Error('audio callback'); });
        d.onState = () => { throw new Error('render callback'); };
        await d.recover(); await d.send('C', 90, { writeValue: async () => {} }); await d.receive('DONE');
        assert.equal(d.pending, null); assert.equal(d.ready, true);
        assert.equal(f.data.get('students/001').points_balance, 1);
    });
    await test('lost confirmation response reconciles idempotently after reconnect', async () => {
        const f = fixture(); await f.store.startSession('001');
        const d = f.makeDevice(); await d.recover();
        await d.send('B', 90, { writeValue: async () => {} });
        f.db.loseResponseOnce = true; await d.receive('DONE');
        assert.ok(d.pending?.ack); assert.equal(f.data.get('students/001').points_balance, 3);
        await d.tick(true); assert.equal(d.pending, null);
        assert.equal(f.data.get('students/001').points_balance, 3);
        assert.equal([...f.data.keys()].filter(p => p.includes('/point_history/')).length, 1);
    });
    await test('storage failure before dispatch never sends, and prepared journal is safe to cancel after reload', async () => {
        const f = fixture(); const d = f.makeDevice(); await d.recover(); let sends = 0;
        const originalSave = f.storage.setItem;
        f.storage.setItem = (key, value) => {
            if (value.includes('dispatching')) throw new Error('disk full');
            return originalSave(key, value);
        };
        await d.send('A', 90, { writeValue: async () => { sends++; } });
        assert.equal(sends, 0); assert.equal(d.pending, null);
        assert.equal(f.data.get('bin_stations/NLS_TN01').pending_event_id, null);
        f.storage.setItem = originalSave;
        const e = await f.store.prepareDisposal('A', 90, d.id);
        f.storage.setItem(d.key, JSON.stringify({ eventId: e.event_id, phase: 'prepared', ack: false }));
        const reload = f.makeDevice(); await reload.recover();
        assert.equal(f.data.get(`disposal_events/${e.event_id}`).status, 'rejected');
        assert.equal(reload.pending, null);
    });
    await test('controller lock permits only one tab and can be reacquired after release', async () => {
        const f = fixture(); let held = false;
        const manager = { async request(name, options, callback) {
            if (held) return callback(null);
            held = true;
            try { await callback({ name }); } finally { held = false; }
        } };
        const release = await f.context.SmartBinDevice.acquireBrowserLock(manager, 'test');
        assert.equal(typeof release, 'function');
        assert.equal(await f.context.SmartBinDevice.acquireBrowserLock(manager, 'test'), null);
        release(); await new Promise(resolve => setImmediate(resolve));
        const next = await f.context.SmartBinDevice.acquireBrowserLock(manager, 'test');
        assert.equal(typeof next, 'function'); next();
    });
    await test('reload while offline retains BLE DONE and syncs when network returns', async () => {
        const f = fixture(); await f.store.startSession('001');
        const original = f.makeDevice(); await original.recover();
        await original.send('B', 90, { writeValue: async () => {} }, 'hm10');
        let online = false;
        const reload = f.makeDevice({ online: () => online });
        f.db.failReads = true; await reload.recover();
        await reload.receive('DONE');
        assert.equal(reload.pending.ack, true); assert.equal(f.data.get('students/001').points_balance, 0);
        f.db.failReads = false; online = true; await reload.tick(true);
        assert.equal(reload.pending, null); assert.equal(f.data.get('students/001').points_balance, 3);
    });
    await test('DONE arriving during recovery is merged instead of overwritten by stale journal', async () => {
        const f = fixture(); await f.store.startSession('001');
        const original = f.makeDevice(); await original.recover();
        await original.send('A', 90, { writeValue: async () => {} });
        let resume; const gate = new Promise(resolve => { resume = resolve; });
        const inspect = f.store.inspectDisposal.bind(f.store);
        f.store.inspectDisposal = async id => { const result = await inspect(id); await gate; return result; };
        const reload = f.makeDevice(); const recovering = reload.recover();
        await reload.receive('DONE'); resume(); await recovering;
        assert.equal(reload.pending, null); assert.equal(f.data.get('students/001').points_balance, 2);
    });
    await test('Bluetooth identity is recovered from server even if local event journal was lost', async () => {
        const f = fixture(); const original = f.makeDevice(); await original.recover();
        await original.send('C', 90, { writeValue: async () => {} }, 'hm-original');
        f.local.delete(original.key);
        const reload = f.makeDevice(); await reload.recover();
        assert.equal(reload.acceptsBluetoothDevice('hm-other'), false);
        assert.equal(reload.acceptsBluetoothDevice('hm-original'), true);
    });
    await test('hung recovery read has a deadline and can retry without reloading', async () => {
        const f = fixture(); const inspect = f.store.inspectDisposal.bind(f.store);
        f.store.inspectDisposal = () => new Promise(() => {});
        const d = f.makeDevice({ syncTimeoutMs: 5 }); await d.recover();
        assert.equal(d.ready, false); assert.equal(d.recovering, false);
        f.store.inspectDisposal = inspect; await d.tick(true); assert.equal(d.ready, true);
    });
    await test('hung confirmation after server commit retries same ID without awarding twice', async () => {
        const f = fixture(); await f.store.startSession('001');
        const d = f.makeDevice({ syncTimeoutMs: 5 }); await d.recover();
        await d.send('B', 90, { writeValue: async () => {} });
        const confirm = f.store.confirmDisposal.bind(f.store);
        f.store.confirmDisposal = async (...args) => { await confirm(...args); await new Promise(() => {}); };
        await d.receive('DONE');
        assert.equal(d.settling, false); assert.equal(f.data.get('students/001').points_balance, 3);
        f.store.confirmDisposal = confirm; await d.tick(true);
        assert.equal(d.pending, null); assert.equal(f.data.get('students/001').points_balance, 3);
    });
    return `PASS ${passed.length} tests:\n${passed.join('\n')}`;
}

module.exports = { runTests, fixture };
if (require.main === module) runTests().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
