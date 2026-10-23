const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
    const elements = new Map();
    const sent = [];
    const errors = [];
    const state = { runs: 0, cameraStarts: 0, modelLoads: 0, frames: 0, output: null, now: 1000 };
    const element = id => {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {}, value: '1.6' });
        return elements.get(id);
    };
    const drawing = { clearRect() {}, drawImage() {}, getImageData: () => ({ width: 1, height: 1, data: [255, 128, 0, 255] }) };
    const canvas = { getContext: () => drawing };
    const video = { readyState: 4, HAVE_ENOUGH_DATA: 4, videoWidth: 640, videoHeight: 480, play: async () => {} };
    const session = { inputNames: ['images'], run: async () => { state.runs++; return state.output; } };
    const device = {
        ready: true, sending: false, recovering: false, pending: null, cooldownUntil: 0,
        send: async (command, score) => { sent.push({ command, score }); return true; }
    };
    const navigator = { onLine: true, mediaDevices: { getUserMedia: async () => { state.cameraStarts++; return {}; } } };
    const context = vm.createContext({
        document: {
            getElementById: id => id === 'webcam-container' ? { appendChild() {} } : element(id),
            createElement: tag => tag === 'video' ? video : canvas
        },
        window: {}, navigator, TextEncoder, TextDecoder, setTimeout, clearTimeout,
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
        __device: device, __session: session, __canvas: canvas, __ctx: drawing, __video: video
    });
    const root = path.join(__dirname, '..');
    for (const file of ['src/asset/js/config.js', 'src/main3.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
    }
    vm.runInContext('pointsDevice = __device; session = __session; canvas = __canvas; ctx = __ctx; video = __video; stationSynced = true; stationHasPending = false; bluetoothDevice = { id: "hm-original", gatt: { connected: true } }; txCharacteristic = {}; resDiv = document.getElementById("result"); statusDiv = document.getElementById("status"); statusHMDiv = document.getElementById("statusHM");', context);
    const output = (classId, score = 0.95) => ({ output0: {
        dims: [1, 7, 1],
        data: new Float32Array([160, 160, 60, 60, ...[0, 1, 2].map(id => id === classId ? score : 0.01)])
    } });
    state.output = output(0);
    const detect = async (classId, count = 1) => {
        state.output = output(classId);
        for (let i = 0; i < count; i++) await context.predictYOLO();
    };
    return { context, device, state, sent, errors, navigator, element, output, detect };
}

async function runTests() {
    const passed = [];
    const test = async (name, fn) => { await fn(); passed.push(name); };
    await test('all three model classes produce the firmware commands A/B/C after five stable detections', async () => {
        const f = fixture();
        for (const id of [0, 1, 2]) await f.detect(id, 5);
        assert.deepEqual(f.sent.map(item => item.command), ['A', 'B', 'C']);
        assert.ok(f.sent.every(item => Math.abs(item.score - 95) < 0.01));
    });
    await test('RGB tensor layout and normalization match the original 320x320 detector', async () => {
        const f = fixture();
        const tensor = f.context.imageToTensor({ width: 1, height: 1, data: [255, 128, 0, 255] });
        assert.deepEqual(Array.from(tensor.dims), [1, 3, 1, 1]);
        assert.equal(tensor.data[0], 1);
        assert.ok(Math.abs(tensor.data[1] - 128 / 255) < 0.00001);
        assert.equal(tensor.data[2], 0);
    });
    await test('pending servo work and offline Firestore do not freeze class changes in the camera loop', async () => {
        const f = fixture();
        f.device.pending = { ack: false };
        f.navigator.onLine = false;
        vm.runInContext('stationSynced = false; stationHasPending = true;', f.context);
        for (const id of [0, 1, 2]) {
            f.state.output = f.output(id);
            f.context.loop();
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(f.element('result').innerHTML.includes(['Vô cơ', 'Hữu cơ', 'Rác khác'][id]));
        }
        assert.equal(f.state.runs, 3);
        assert.equal(f.sent.length, 0);
        assert.match(f.element('sortStatus').textContent, /DONE/);
    });
    await test('camera detection works before a points controller exists or Bluetooth is connected', async () => {
        const f = fixture();
        vm.runInContext('pointsDevice = undefined; bluetoothDevice = undefined; txCharacteristic = null;', f.context);
        await f.detect(1, 5);
        assert.match(f.element('result').innerHTML, /Hữu cơ/);
        assert.equal(f.sent.length, 0);
    });
    await test('slow physical dispatch does not hold the inference busy flag', async () => {
        const f = fixture();
        f.device.send = () => { f.device.sending = true; return new Promise(() => {}); };
        let timer;
        try {
            await Promise.race([
                f.detect(0, 5),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Inference blocked by dispatch')), 100); })
            ]);
        } finally { clearTimeout(timer); }
        await f.detect(1);
        assert.match(f.element('result').innerHTML, /Hữu cơ/);
        assert.equal(f.state.runs, 6);
    });
    await test('after DONE and cooldown, the next item does not require three empty camera frames', async () => {
        const f = fixture();
        await f.detect(0, 5);
        f.device.pending = { ack: false };
        await f.detect(1, 5);
        assert.equal(f.sent.length, 1);
        f.device.pending = null;
        f.device.cooldownUntil = 0;
        await f.detect(1, 5);
        assert.deepEqual(f.sent.map(item => item.command), ['A', 'B']);
    });
    await test('blank frames and blocked sends reset stability before the next command', async () => {
        const f = fixture();
        await f.detect(0, 4);
        await f.detect(-1);
        await f.detect(0);
        assert.equal(f.sent.length, 0);
        f.device.pending = { ack: true };
        await f.detect(0);
        f.device.pending = null;
        await f.detect(0, 4);
        assert.equal(f.sent.length, 0);
        await f.detect(0);
        assert.equal(f.sent.length, 1);
    });
    await test('camera initialization does not wait for recovery or fail with Firebase/controller errors', async () => {
        for (const firebaseFailure of [false, true]) {
            const f = fixture({ firebaseFailure });
            vm.runInContext('initializePointsController = async () => { throw new Error("controller unavailable"); };', f.context);
            await f.context.init();
            assert.equal(f.state.modelLoads, 1);
            assert.equal(f.state.cameraStarts, 1);
            assert.equal(f.state.frames, 1);
            assert.match(f.element('pointsStatus').textContent, /controller unavailable/);
        }
        const f = fixture();
        vm.runInContext('initializePointsController = () => new Promise(() => {});', f.context);
        await f.context.init();
        assert.equal(f.state.cameraStarts, 1);
    });
    return 'PASS ' + passed.length + ' recognition tests:\n' + passed.join('\n');
}
module.exports = { runTests };
if (require.main === module) runTests().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
