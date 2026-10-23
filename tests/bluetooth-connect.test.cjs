const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
    const elements = new Map();
    const received = [];
    const state = { requests: 0, connects: 0, ticks: 0, expected: null };
    const element = id => {
        if (!elements.has(id)) elements.set(id, { textContent: '', style: {}, disabled: false });
        return elements.get(id);
    };
    function eventTarget() {
        const listeners = new Map();
        return {
            listeners,
            addEventListener(name, fn) {
                if (!listeners.has(name)) listeners.set(name, new Set());
                listeners.get(name).add(fn);
            },
            removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
            emit(name) { for (const fn of listeners.get(name) || []) fn({ target: this }); }
        };
    }
    const characteristic = {
        ...eventTarget(),
        async startNotifications() {
            assert.equal(this.listeners.get('characteristicvaluechanged')?.size, 1, 'listen before enabling notifications');
            this.value = new DataView(new TextEncoder().encode('DONE').buffer);
            this.emit('characteristicvaluechanged');
        }
    };
    const candidate = { ...eventTarget(), id: 'hm-original' };
    candidate.gatt = {
        connected: false,
        async connect() { state.connects++; this.connected = true; return this; },
        disconnect() { this.connected = false; candidate.emit('gattserverdisconnected'); },
        async getPrimaryService() { return { getCharacteristic: async () => characteristic }; }
    };
    const device = {
        pending: null, ready: true,
        acceptsBluetoothDevice: id => !state.expected || id === state.expected,
        receive: async text => received.push(text),
        tick: async () => { state.ticks++; }
    };
    const navigator = { onLine: true, bluetooth: { requestDevice: async () => { state.requests++; return candidate; } } };
    const db = { collection: () => ({ doc: () => ({ onSnapshot(options, next) {
        next({ metadata: { fromCache: false, hasPendingWrites: false }, data: () => ({ pending_event_id: null }) });
        return () => {};
    } }) }) };
    const context = vm.createContext({
        document: { getElementById: element, createElement: () => ({ getContext: () => ({}) }) },
        window: {}, navigator, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        Audio: class { play() { return Promise.resolve(); } },
        firebase: { initializeApp() {}, firestore: () => db },
        performance: { now: () => 0 }, console: { error() {} }, __device: device
    });
    const root = path.join(__dirname, '..');
    for (const filename of ['src/asset/js/config.js', 'src/main3.js']) vm.runInContext(
        fs.readFileSync(path.join(root, filename), 'utf8'), context
    );
    vm.runInContext('pointsDevice = __device; statusDiv = document.getElementById("status"); statusHMDiv = document.getElementById("statusHM");', context);
    return { state, context, candidate, characteristic, device, navigator, received, element };
}

async function runTests() {
    const passed = [];
    async function test(name, fn) { await fn(); passed.push(name); }
    await test('reconnect reuses granted device and keeps exactly one notification listener', async () => {
        const f = fixture(); await f.context.connect();
        assert.equal(f.received.length, 1); assert.equal(f.state.requests, 1);
        await f.context.connect(); assert.equal(f.state.connects, 1);
        f.candidate.gatt.disconnect(); await f.context.connect();
        assert.equal(f.state.requests, 1); assert.equal(f.state.connects, 2);
        assert.equal(f.received.length, 2);
        assert.equal(f.characteristic.listeners.get('characteristicvaluechanged').size, 1);
    });
    await test('pending event prevents connecting a different HM-10', async () => {
        const f = fixture(); f.state.expected = 'hm-other'; f.device.pending = { bluetoothDeviceId: 'hm-other' };
        await f.context.connect();
        assert.equal(f.state.connects, 0); assert.equal(f.received.length, 0);
        assert.match(f.element('status').textContent, /đúng thiết bị/);
    });
    await test('picker cancellation clears connection guard so the next click can retry', async () => {
        const f = fixture(); const request = f.navigator.bluetooth.requestDevice;
        f.navigator.bluetooth.requestDevice = async () => { throw { name: 'NotFoundError' }; };
        await f.context.connect(); assert.match(f.element('status').textContent, /Đã hủy/);
        f.navigator.bluetooth.requestDevice = request;
        await f.context.connect(); assert.equal(f.state.connects, 1);
    });
    await test('timed-out connect cannot become a live connection after its promise resolves late', async () => {
        const f = fixture(); let resolveConnect;
        f.candidate.gatt.connect = () => new Promise(resolve => { resolveConnect = resolve; });
        f.context.__originalTimeout = f.context.bleTimeout;
        vm.runInContext('bleTimeout = operation => __originalTimeout(operation, 5);', f.context);
        await f.context.connect();
        assert.equal(vm.runInContext('connectingBluetooth', f.context), false);
        f.candidate.gatt.connected = true; resolveConnect(f.candidate.gatt);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.candidate.gatt.connected, false);
        assert.equal(vm.runInContext('txCharacteristic', f.context), null);
    });
    await test('automatic reconnect never opens the Bluetooth picker', async () => {
        const f = fixture(); await f.context.connect(true);
        assert.equal(f.state.requests, 0); assert.equal(f.state.connects, 0);
        await f.context.connect();
        f.candidate.gatt.disconnect();
        vm.runInContext('bluetoothRetryAt = 0;', f.context);
        await f.context.connect(true);
        assert.equal(f.state.requests, 1); assert.equal(f.state.connects, 2);
    });
    return `PASS ${passed.length} Bluetooth connection tests:\n${passed.join('\n')}`;
}
module.exports = { runTests };
if (require.main === module) runTests().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
