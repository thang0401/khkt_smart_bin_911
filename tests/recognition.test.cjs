const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { fixture: databaseFixture } = require('./smartbin-flow.test.cjs');

function fixture(options = {}) {
    const elements = new Map(), saved = options.saved || new Map();
    const sent = [], recorded = [], errors = [];
    const state = { runs: 0, cameraStarts: 0, modelLoads: 0, frames: 0, output: null, now: 1000, clock: Date.now() };
    const element = id => {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {}, value: '1.6' });
        return elements.get(id);
    };
    const drawing = { clearRect() {}, drawImage() {}, getImageData: () => ({ width: 1, height: 1, data: [255, 128, 0, 255] }) };
    const canvas = { getContext: () => drawing };
    const video = { readyState: 4, HAVE_ENOUGH_DATA: 4, videoWidth: 640, videoHeight: 480, play: async () => {} };
    const session = { inputNames: ['images'], run: async () => { state.runs++; return state.output; } };
    const characteristic = {
        writeValue: async bytes => { sent.push(new TextDecoder().decode(bytes)); }
    };
    const store = options.store || { recordCompletedDisposal: async item => {
        recorded.push(item);
        return { student_code: '001', unit_points: { A: 2, B: 3, C: 1 }[item.wasteCode] };
    } };
    const storage = {
        getItem: key => saved.get(key) || null,
        setItem: (key, value) => saved.set(key, value)
    };
    const navigator = { onLine: true, mediaDevices: { getUserMedia: async () => { state.cameraStarts++; return {}; } } };
    class ClockDate extends Date { static now() { return state.clock; } }
    const context = vm.createContext({
        document: {
            getElementById: id => id === 'webcam-container' ? { appendChild() {} } : element(id),
            createElement: tag => tag === 'video' ? video : canvas
        },
        window: { localStorage: storage }, navigator, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        crypto: { randomUUID }, Date: ClockDate,
        requestAnimationFrame: () => { state.frames++; }, performance: { now: () => (state.now += 400) },
        Audio: class { play() { return Promise.resolve(); } },
        firebase: {
            initializeApp() { if (options.firebaseFailure) throw new Error('Firebase unavailable'); },
            firestore: () => ({})
        },
        ort: {
            env: { wasm: {} },
            Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } },
            InferenceSession: { create: async () => { state.modelLoads++; return session; } }
        },
        console: { info() {}, warn() {}, error: (...args) => errors.push(args) },
        __store: store, __session: session, __canvas: canvas, __ctx: drawing, __video: video, __characteristic: characteristic
    });
    const root = path.join(__dirname, '..');
    for (const file of ['src/asset/js/config.js', 'src/main3.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
    }
    vm.runInContext('pointsStore = __store; pointsInitialized = true; stationSessionId = "s1"; session = __session; canvas = __canvas; ctx = __ctx; video = __video; bluetoothDevice = { id: "hm-original", gatt: { connected: true } }; txCharacteristic = __characteristic; resDiv = document.getElementById("result"); statusDiv = document.getElementById("status"); statusHMDiv = document.getElementById("statusHM");', context);
    const output = classId => ({ output0: { dims: [1, 7, 1], data: new Float32Array([160, 160, 60, 60, ...[0, 1, 2].map(id => id === classId ? 0.905 : 0.01)]) } });
    state.output = output(0);
    const flush = () => new Promise(resolve => setImmediate(resolve));
    const detect = async (classId, count = 1) => {
        state.output = output(classId);
        for (let i = 0; i < count; i++) await context.predictYOLO();
        await flush();
    };
    const receive = async text => {
        characteristic.value = new DataView(new TextEncoder().encode(text).buffer);
        context.handleHM10Data({ target: characteristic });
        await flush();
    };
    return { context, state, sent, recorded, errors, navigator, element, output, detect, receive, flush, saved, characteristic, storage };
}

async function runTests() {
    const passed = [];
    const test = async (name, fn) => { await fn(); passed.push(name); };
    await test('five stable classifications send the actual firmware bytes A/B/C directly', async () => {
        const f = fixture();
        for (const id of [0, 1, 2]) { await f.detect(id, 5); await f.receive('DONE\r\n'); }
        assert.deepEqual(f.sent, ['A', 'B', 'C']);
        assert.deepEqual(f.recorded.map(item => item.wasteCode), ['A', 'B', 'C']);
        assert.ok(f.recorded.every(item => Math.abs(item.confidence - 90.5) < 0.01));
    });
    await test('organic recognition still writes B with stale pending/controller journals and offline Firebase', async () => {
        const f = fixture();
        f.saved.set('smartbin.pending.NLS_TN01', JSON.stringify({ eventId: 'old-pending', phase: 'awaiting_done' }));
        f.navigator.onLine = false;
        vm.runInContext('stationHasPending = true; stationSynced = false; pointsDevice = { ready: false, pending: { eventId: "old-pending" } };', f.context);
        await f.detect(1, 5);
        assert.deepEqual(f.sent, ['B']);
        assert.equal(f.recorded.length, 0);
        await f.receive('DONE\r\n');
        assert.equal(f.recorded.length, 0);
        assert.match(f.saved.get('smartbin.completed.NLS_TN01'), /"wasteCode":"B"/);
        await f.detect(0, 5);
        assert.deepEqual(f.sent, ['B', 'A']);
        await f.receive('DONE\r\n');
        f.navigator.onLine = true;
        await f.context.retryPointsSync();
        assert.equal(f.recorded.length, 2);
    });
    await test('hardware sends without a points store and does not require localStorage writes', async () => {
        const f = fixture();
        vm.runInContext('pointsStore = undefined;', f.context);
        f.storage.setItem = () => { throw new Error('storage blocked'); };
        await f.detect(1, 5);
        assert.deepEqual(f.sent, ['B']);
    });
    await test('fragmented and repeated DONE enqueue one completed cycle and never replay Bluetooth', async () => {
        const f = fixture();
        await f.detect(1, 5);
        await f.receive('D');
        assert.equal(f.recorded.length, 0);
        await f.receive('ONE\r\n');
        await f.receive('DONE\r\n');
        assert.equal(f.recorded.length, 1);
        assert.deepEqual(f.sent, ['B']);
    });
    await test('early DONE during write is retained and Firebase is called only after the physical write begins', async () => {
        const f = fixture();
        f.characteristic.writeValue = async bytes => {
            assert.equal(f.recorded.length, 0);
            f.sent.push(new TextDecoder().decode(bytes));
            await f.receive('DONE\r\n');
        };
        await f.detect(1, 5);
        assert.deepEqual(f.sent, ['B']);
        assert.equal(f.recorded.length, 1);
    });
    await test('slow point synchronization does not block the next physical cycle', async () => {
        let resume;
        const gate = new Promise(resolve => { resume = resolve; });
        const f = fixture({ store: { recordCompletedDisposal: async () => { await gate; return {}; } } });
        await f.detect(1, 5); await f.receive('DONE\r\n');
        await f.detect(0, 5); await f.receive('DONE\r\n');
        assert.deepEqual(f.sent, ['B', 'A']);
        resume(); await f.flush();
    });
    await test('seven-second servo timeout resumes detection without awarding unconfirmed points', async () => {
        const f = fixture();
        await f.detect(1, 5);
        await f.detect(0, 5);
        assert.deepEqual(f.sent, ['B']);
        f.state.clock += 7001;
        await f.detect(0, 5);
        assert.deepEqual(f.sent, ['B', 'A']);
        assert.equal(f.recorded.length, 0);
    });
    await test('real store records DONE idempotently for the original student despite stale station pending', async () => {
        const db = databaseFixture();
        const first = await db.store.startSession('001');
        db.data.get('bin_stations/NLS_TN01').pending_event_id = 'abandoned-old-event';
        const f = fixture({ store: db.store });
        f.state.clock = db.store.now();
        f.context.__sessionId = first;
        vm.runInContext('stationSessionId = __sessionId;', f.context);
        await f.detect(1, 5);
        assert.deepEqual(f.sent, ['B']);
        assert.equal(db.data.get('students/001').points_balance, 0);
        const job = vm.runInContext('({...hardwareCycle})', f.context);
        await db.store.finishSession(first);
        const second = await db.store.startSession('002');
        f.context.__sessionId = second;
        vm.runInContext('stationSessionId = __sessionId;', f.context);
        await f.receive('DONE\r\n');
        await db.store.recordCompletedDisposal(job);
        assert.equal(db.data.get('students/001').points_balance, 3);
        assert.equal(db.data.get('students/002').points_balance, 0);
        assert.equal(db.data.get('du_lieu_tram/thong_tin_hien_tai').rac_huu_co, 1);
        assert.equal(db.data.get('bin_stations/NLS_TN01').active_session_id, second);
        assert.equal(db.data.get('bin_stations/NLS_TN01').pending_event_id, 'abandoned-old-event');
    });
    await test('older browsers without randomUUID can still send a servo command', async () => {
        const f = fixture(); f.context.crypto = undefined;
        await f.detect(1, 5);
        assert.deepEqual(f.sent, ['B']);
    });
    await test('failed recording retries the completed job without sending Bluetooth twice', async () => {
        const db = databaseFixture();
        const id = await db.store.startSession('001');
        const f = fixture({ store: db.store });
        f.state.clock = db.store.now(); f.context.__sessionId = id;
        vm.runInContext('stationSessionId = __sessionId;', f.context);
        await f.detect(1, 5);
        db.db.loseResponseOnce = true;
        await f.receive('DONE\r\n');
        assert.equal(db.data.get('students/001').points_balance, 0);
        await f.context.retryPointsSync();
        assert.equal(db.data.get('students/001').points_balance, 3);
        assert.deepEqual(f.sent, ['B']);
    });
    await test('reload restores only completed jobs and records them without replaying servo commands', async () => {
        const first = fixture(); first.navigator.onLine = false;
        await first.detect(1, 5); await first.receive('DONE\r\n');
        const reloaded = fixture({ saved: first.saved });
        reloaded.context.SmartBinStore = class { constructor() { return { recordCompletedDisposal: async job => { reloaded.recorded.push(job); return {}; } }; } };
        reloaded.context.window.addEventListener = () => {};
        reloaded.context.setInterval = () => {};
        vm.runInContext('pointsInitialized = false; pointsStore = undefined; db = { collection: () => ({ doc: () => ({ onSnapshot: callback => { callback({ data: () => ({ active_session_id: "s1" }) }); return () => {}; } }) }) };', reloaded.context);
        await reloaded.context.initializePointsController(); await reloaded.flush();
        assert.equal(reloaded.recorded.length, 1);
        assert.deepEqual(reloaded.sent, []);
    });
    await test('RGB tensor layout and model normalization match the working original', async () => {
        const f = fixture();
        const tensor = f.context.imageToTensor({ width: 1, height: 1, data: [255, 128, 0, 255] });
        assert.deepEqual(Array.from(tensor.dims), [1, 3, 1, 1]);
        assert.equal(tensor.data[0], 1); assert.equal(tensor.data[2], 0);
        assert.ok(Math.abs(tensor.data[1] - 128 / 255) < 0.00001);
    });
    await test('AI continues changing classes while the local servo cycle waits for DONE', async () => {
        const f = fixture();
        await f.detect(0, 5);
        await f.detect(1); assert.match(f.element('result').innerHTML, /Hữu cơ/);
        await f.detect(2); assert.match(f.element('result').innerHTML, /Rác khác/);
        assert.deepEqual(f.sent, ['A']);
    });
    await test('slow Bluetooth write does not hold the inference busy flag', async () => {
        const f = fixture(); let resume;
        f.characteristic.writeValue = () => new Promise(resolve => { resume = resolve; });
        await f.detect(0, 5);
        await f.detect(1);
        assert.match(f.element('result').innerHTML, /Hữu cơ/);
        resume(); await f.flush();
    });
    await test('camera starts even when the points initializer fails or never responds', async () => {
        for (const firebaseFailure of [false, true]) {
            const f = fixture({ firebaseFailure });
            vm.runInContext('initializePointsController = async () => { throw new Error("Firebase unavailable"); };', f.context);
            await f.context.init();
            assert.equal(f.state.modelLoads, 1); assert.equal(f.state.cameraStarts, 1);
        }
        const f = fixture();
        vm.runInContext('initializePointsController = () => new Promise(() => {});', f.context);
        await f.context.init();
        assert.equal(f.state.cameraStarts, 1);
    });
    return 'PASS ' + passed.length + ' direct hardware/recognition tests:\n' + passed.join('\n');
}
module.exports = { runTests, fixture };
if (require.main === module) runTests().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
