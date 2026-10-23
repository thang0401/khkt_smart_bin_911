const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function element() {
    return {
        textContent: '', value: '', disabled: false, hidden: false, children: [], handlers: {},
        classList: { toggle() {} }, setAttribute() {}, select() {}, focus() {},
        maxLength: 30,
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        addEventListener(name, fn) { this.handlers[name] = fn; }
    };
}

function fixture() {
    const nodes = new Map();
    const html = fs.readFileSync(path.join(root, 'out.html'), 'utf8');
    for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const node = element(); node.hidden = /\bhidden\b/.test(match[0]); nodes.set(match[1], node);
    }
    const docs = new Map();
    const subscriptions = new Map();
    const windowEvents = {};
    const timers = [];
    const navigator = { onLine: true };
    const state = { starts: 0, finishes: 0, touches: 0, deferGet: null, deferStart: false };
    const snapshot = (value, metadata = {}) => ({ exists: value !== undefined, data: () => value, metadata: { fromCache: false, hasPendingWrites: false, ...metadata } });
    const listen = (location, args) => {
        const callbacks = args.filter(arg => typeof arg === 'function');
        const sub = { next: callbacks[0], error: callbacks[1] };
        subscriptions.set(location, sub);
        if (location.endsWith('/point_history')) sub.next({ docs: [] });
        else sub.next(snapshot(docs.get(location)));
        return () => { if (subscriptions.get(location) === sub) subscriptions.delete(location); };
    };
    const ref = location => ({
        collection: name => collection(`${location}/${name}`),
        onSnapshot: (...args) => listen(location, args),
        get: async () => {
            if (state.deferGet && location === state.deferGet.location) return state.deferGet.promise;
            return snapshot(docs.get(location));
        }
    });
    const collection = location => ({
        doc: id => ref(`${location}/${id}`),
        orderBy: () => ({ limit: () => ({ onSnapshot: (...args) => listen(location, args) }) })
    });
    const emit = (location, value, metadata) => {
        if (!metadata?.fromCache && !metadata?.hasPendingWrites) {
            if (value === undefined) docs.delete(location); else docs.set(location, value);
        }
        subscriptions.get(location)?.next(snapshot(value, metadata));
    };
    const stationPath = 'bin_stations/NLS_TN01';
    docs.set(stationPath, { active_session_id: null, pending_event_id: null });
    docs.set('students/001', { active: true, full_name: 'Student 001', class_name: '10A1', points_balance: 0 });
    docs.set('students/002', { active: true, full_name: 'Student 002', class_name: '10A2', points_balance: 0 });
    docs.set('reward_settings/default', { session_warning_seconds: 15 });
    class FakeStore {
        constructor() { this.station = ref(stationPath); }
        session(id) { return ref(`bin_sessions/${id}`); }
        millis(value) { return value.toMillis(); }
        async startSession(code) {
            state.starts++;
            docs.set('bin_sessions/s1', { student_code: code, status: 'active', points_earned: 0, items_count: 0, expires_at: { toMillis: () => Date.now() + 120000 } });
            docs.set(stationPath, { ...docs.get(stationPath), active_session_id: 's1' });
            if (!state.deferStart) emit(stationPath, docs.get(stationPath));
            return 's1';
        }
        async finishSession() { state.finishes++; emit(stationPath, { active_session_id: null, pending_event_id: null }); }
        async touchSession() { state.touches++; }
    }
    const context = vm.createContext({
        document: { getElementById: id => nodes.get(id), createElement: () => element() },
        navigator,
        window: { addEventListener: (name, fn) => { windowEvents[name] = fn; } },
        setInterval: (fn, ms) => timers.push({ fn, ms }), setTimeout, clearTimeout, console: { error() {} },
        SmartBinStore: FakeStore,
        firebase: { initializeApp() {}, firestore: () => ({ collection }) }
    });
    for (const filename of ['config.js', 'out.js']) vm.runInContext(
        fs.readFileSync(path.join(root, 'src', 'asset', 'js', filename), 'utf8'), context
    );
    const lookup = async (code = '001') => { nodes.get('studentCode').value = code; await context.lookupStudent({ preventDefault() {} }); };
    return { nodes, context, docs, emit, snapshot, lookup, subscriptions, windowEvents, navigator, timers, state, stationPath };
}

async function runTests() {
    const passed = [];
    async function test(name, fn) { await fn(); passed.push(name); }
    await test('pending disposal without a session allows keypad input, lookup and starting a session', async () => {
        const f = fixture();
        f.emit(f.stationPath, { active_session_id: null, pending_event_id: 'event1' });
        assert.equal(f.nodes.get('studentCode').disabled, false);
        assert.equal(f.nodes.get('lookupButton').disabled, false);
        for (const key of ['0', '0', '1']) {
            f.context.handleKeypadInput({ target: { closest: () => ({ dataset: { key } }) } });
        }
        assert.equal(f.nodes.get('studentCode').value, '001');
        f.context.handleKeypadInput({ target: { closest: () => ({ dataset: { key: 'delete' } }) } });
        assert.equal(f.nodes.get('studentCode').value, '00');
        f.context.handleKeypadInput({ target: { closest: () => ({ dataset: { key: '1' } }) } });
        await f.context.lookupStudent({ preventDefault() {} });
        assert.equal(f.nodes.get('studentName').textContent, 'Student 001');
        assert.equal(f.nodes.get('studentDetails').hidden, false);
        assert.equal(f.nodes.get('startSession').disabled, false);
        await f.context.startStudentSession();
        assert.equal(f.state.starts, 1);
        assert.equal(f.docs.get(f.stationPath).pending_event_id, 'event1');
        assert.equal(f.nodes.get('studentCode').disabled, true);
    });
    await test('start locks code immediately before delayed station snapshot', async () => {
        const f = fixture(); await f.lookup(); f.state.deferStart = true;
        await f.context.startStudentSession();
        assert.equal(f.nodes.get('studentCode').disabled, true);
        await f.lookup('002');
        assert.equal(f.nodes.get('studentName').textContent, 'Student 001');
        assert.equal(f.state.starts, 1);
    });
    await test('buttons stay enabled with pending work, cached state and offline; manual finish runs', async () => {
        const f = fixture(); await f.lookup(); await f.context.startStudentSession();
        f.emit(f.stationPath, { active_session_id: 's1', pending_event_id: 'event1' });
        f.emit(f.stationPath, {}, { fromCache: true });
        assert.equal(f.nodes.get('studentCode').disabled, true);
        f.navigator.onLine = false; f.windowEvents.offline();
        assert.equal(f.nodes.get('startSession').disabled, false);
        assert.equal(f.nodes.get('finishSession').disabled, false);
        await f.context.finishStudentSession();
        assert.equal(f.state.finishes, 1);
    });
    await test('start runs while station state is unverified and repeat clicks are not blocked by UI guards', async () => {
        const f = fixture(); await f.lookup();
        f.emit(f.stationPath, {}, { fromCache: true });
        await f.context.startStudentSession();
        await f.context.startStudentSession();
        assert.equal(f.state.starts, 2);
        assert.equal(f.nodes.get('startSession').disabled, false);
        assert.equal(f.nodes.get('finishSession').disabled, false);
    });
    await test('session listener recovers without disabling session buttons', async () => {
        const f = fixture(); await f.lookup(); await f.context.startStudentSession();
        f.subscriptions.get('bin_sessions/s1').error({ code: 'permission-denied' });
        assert.equal(f.nodes.get('finishSession').disabled, false);
        await f.context.reconnectDashboard();
        assert.equal(f.nodes.get('finishSession').disabled, false);
        assert.equal(f.nodes.get('studentCode').disabled, true);
    });
    await test('old lookup result cannot select another student after station session changes', async () => {
        const f = fixture(); let resolveLookup;
        f.state.deferGet = { location: 'students/001', promise: new Promise(resolve => { resolveLookup = resolve; }) };
        const pending = f.lookup('001');
        f.docs.set('bin_sessions/other', { student_code: '002', status: 'active', points_earned: 0, items_count: 0, expires_at: { toMillis: () => Date.now() + 120000 } });
        f.emit(f.stationPath, { active_session_id: 'other', pending_event_id: 'e2' });
        await new Promise(resolve => setImmediate(resolve));
        resolveLookup(f.snapshot(f.docs.get('students/001'))); await pending;
        assert.equal(f.nodes.get('studentName').textContent, 'Student 002');
        assert.equal(f.nodes.get('studentCode').disabled, true);
    });
    await test('cached inactive session cannot close active identity and unlock inputs', async () => {
        const f = fixture(); await f.lookup(); await f.context.startStudentSession();
        f.emit('bin_sessions/s1', { status: 'completed' }, { fromCache: true });
        assert.equal(f.nodes.get('studentDetails').hidden, false);
        assert.equal(f.nodes.get('studentCode').disabled, true);
        assert.equal(f.nodes.get('finishSession').disabled, false);
        f.emit('bin_sessions/s1', f.docs.get('bin_sessions/s1'));
        assert.equal(f.nodes.get('finishSession').disabled, false);
    });
    await test('late reconnect read cannot overwrite newer station update', async () => {
        const f = fixture(); let resolveRead;
        f.state.deferGet = { location: f.stationPath, promise: new Promise(resolve => { resolveRead = resolve; }) };
        const oldSnapshot = f.snapshot({ active_session_id: null, pending_event_id: null });
        const reconnect = f.context.reconnectDashboard();
        f.docs.set('bin_sessions/new', { student_code: '001', status: 'active', points_earned: 0, items_count: 0, expires_at: { toMillis: () => Date.now() + 120000 } });
        f.emit(f.stationPath, { active_session_id: 'new', pending_event_id: 'new-event' });
        resolveRead(oldSnapshot); await reconnect;
        assert.equal(f.nodes.get('studentCode').disabled, true);
        assert.equal(f.nodes.get('finishSession').disabled, false);
    });
    await test('read deadline prevents lookup/reconnect promises from hanging indefinitely', async () => {
        const f = fixture();
        await assert.rejects(f.context.serverRead({ get: () => new Promise(() => {}) }, 5), /Quá thời gian/);
    });
    return `PASS ${passed.length} dashboard tests:\n${passed.join('\n')}`;
}
module.exports = { runTests };
if (require.main === module) runTests().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
