import test from 'node:test';
import assert from 'node:assert/strict';
import { installArenaHost, apply as officialApply, inject as nativeInject } from '../host.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(config = {}, { qualified = true, clock = Date.now, pending = false, confirmedEntry = null } = {}) {
  const globals = new Map(), listeners = new Map(), roots = [], agents = new Map(), stores = [], runtimes = [], clients = [], globalGuards = [];
  let nextMessage = 0;
  const register = map => definition => {
    assert.equal(map.has(definition.name), false, definition.name);
    map.set(definition.name, definition); return () => map.delete(definition.name);
  };
  const ctx = {
    tools: { register: register(globals), guard(fn) { globalGuards.push(fn); return () => { const index = globalGuards.indexOf(fn); if (index >= 0) globalGuards.splice(index, 1); }; } },
    agents: { get: id => agents.get(id), roots: () => [...roots] },
    on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
    effect() {},
  };
  async function emit(name, ...args) { for (const fn of [...listeners.get(name) ?? []]) await fn(...args); }
  class Store { constructor(file) { this.file = file; this.closed = false; stores.push(this); } async close() { this.closed = true; } }
  class Client {
    constructor(options) { this.options = options; this.connected = qualified; this.saved = qualified; this.pending = pending; this.resets = 0; this.nativeCalls = []; this.catalogValue = {catalog_revision:'native-test-1',appearance:{character:[{id:'default',name:'默认形象',enabled:true},{id:'qwen',name:'Qwen 娘',enabled:true}]},loadouts:[{id:'rifle',name:'步枪配置',enabled:true},{id:'smg',name:'冲锋枪配置',enabled:true}],mode_ids:['extraction','battle_royale']}; clients.push(this); }
    async publicState() { return { connected: this.connected, access_credential_saved:this.saved, native_connect_pending:this.pending, profiles:[], confirmed_entry:this.confirmedEntry??confirmedEntry }; }
    async rememberConfirmedEntry(entry) { (this.remembered??=[]).push(structuredClone(entry)); if(this.rememberGate)await this.rememberGate; if(this.rememberFailures){this.rememberFailures--;throw Object.assign(new Error('write failed'),{code:'store_write_failed'});} this.confirmedEntry=structuredClone(entry); }
    async connectNative(args={}) { this.nativeCalls.push(args); if(this.nativeError)throw this.nativeError; if(this.sessionError){if(this.sessionError.status!==401)throw this.sessionError;await this.resetConnection();this.sessionError=null;} if(args.ticket||this.pending){this.saved=true;this.pending=false;} if(!this.saved)throw Object.assign(new Error('access required'),{code:'native_access_required'});this.connected=true;return {state:'connected',session:{state:this.serverState??'preparing'}}; }
    async catalog() { return structuredClone(this.catalogValue); }
    async session() { if (this.sessionError) throw this.sessionError; return { state: this.serverState ?? 'preparing', ...(this.serverAttempt ? {attempt:this.serverAttempt} : {}), ...(this.serverResult ? {result:this.serverResult} : {}) }; }
    async withdrawEntry() { this.withdrawals = (this.withdrawals ?? 0) + 1; if (this.withdrawError) throw this.withdrawError; this.serverState = 'preparing'; return this.session(); }
    async clearAttempt(id) { (this.cleared ??= []).push(id); }
    async result() { return {result:this.serverResult}; }
    async resetConnection() { this.resets++; this.connected = false; }
  }
  class Runtime {
    constructor(options) { this.options = options; this.calls = []; this.stops = []; this.view = { phase: 'idle', entry_state: null, active: false, current_attempt: null }; runtimes.push(this); }
    state() { return structuredClone(this.view); }
    async start(options) {
      this.entry = options.entry; this.startOptions = options;
      if(this.options.client.runtimeStartError)throw this.options.client.runtimeStartError;
      if (options.autoEnter === false) { this.view = { ...this.view, active:true, entry_state:this.options.client.serverState }; return this.state(); }
      this.view = { ...this.view, phase: 'waiting', active: true, entry_state:'waiting', game_token: 'private-never-output' };
      this.options.onState(this.state()); return this.state();
    }
    enter() {
      this.view = { ...this.view, phase: 'in_world', entry_state: 'in_world', current_attempt: { attempt_id: 'attempt_fixture', mode_id: this.entry.mode_id } };
      this.options.onState(this.state()); this.options.onWake({ attempt_id: 'attempt_fixture', reason: 'entered' });
    }
    async refresh() { return this.state(); }
    async listGameTools() { return [{ name: 'observe', description: 'Authoritative game view', inputSchema: { type: 'object', properties: {} } }]; }
    async callGame(name, args, signal) { this.calls.push({ name, args, signal }); return { content: [{ type: 'text', text: '{"ok":true}' }] }; }
    async stop(reason, options) {
      if (this.startOptions?.autoEnter === false) {
        this.stops.push({reason,options}); this.view.active=false;
        const confirmed = !this.options.client.exitUnconfirmed;
        if (confirmed) this.options.client.serverState='ended';
        return {stopped:true,character_state:confirmed?'ended':'still_in_world',terminal_confirmed:confirmed,...(confirmed?{result:{outcome:'abandoned'}}:{})};
      }
      this.stops.push({ reason, options }); this.view.active = false; this.view.phase = 'stopped';
      return { stopped: true, character_state: this.view.entry_state === 'ended' || options.abandon ? 'ended' : this.view.entry_state === 'in_world' ? 'still_in_world' : 'not_in_world' };
    }
    async repairPairing() {
      this.repairs = (this.repairs ?? 0) + 1;
      this.view = { ...this.view, phase: 'pairing', active: false, entry_state: null, current_attempt: null, pairing: { user_code: 'FRESH-PAIR', expires_at_ms: Date.now() + 300000 }, loop: { state: 'stopped', reason: 'user_stop' } };
      this.options.onState(this.state()); return this.state();
    }
    async terminal(result = { outcome: 'won' }) {
      this.view = { ...this.view, entry_state: 'ended', phase: 'ended', result };
      this.options.onState(this.state()); await this.options.onTerminal({ attempt_id: 'attempt_fixture', result });
    }
  }
  const dependencies = {
    ArenaRuntime: Runtime, ArenaClient: Client, AtomicStore: Store, defineTool: x => x, clock,
    createUserMessage: value => ({ ...value, role: 'user', id: `message_${++nextMessage}` }),
    createMcpToolDefinition: (_ctx, options) => ({ name: options.name, parameters: options.inputSchema,
      output: { schema: { type: 'object' }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: options.call }),
  };
  globals.set('read_file', { name: 'read_file' });
  const host = installArenaHost(ctx, { home: '/tmp/model-action-native-host-fixture', ...config }, dependencies);
  function agent(id, { root = true, text = '开始Model行动', source = 'user', status = 'running' } = {}) {
    const scoped = new Map(), state = { restricted: false, guards: [], disposals: 0 };
    const agent = { id, status, session: { id, log: [{ type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { source: { kind: source }, content: [{ type: 'text', text }] } }] },
      controller: new AbortController(), inbox: { nextStep: [], nextTurn: [] }, injections: [], followups: [], cancels: [],
      inject(message) { this.injections.push(message); this.inbox.nextStep.push(message); },
      followup(message) { this.followups.push(message); this.inbox.nextTurn.push(message); this.status = 'running'; },
      cancel(cause) { this.cancels.push(cause); this.controller.abort(cause); },
      async whenIdle() {}, scopeState: state, scoped,
    };
    agent.ctx = { plugin(plugin) {
      const inner = { tools: { register: register(scoped), restrict(filter) { assert.deepEqual(filter, { allow: [] }); state.restricted = true; },
        guard(fn) { state.guards.push(fn); } } };
      let active = true;
      const loaded = Promise.resolve().then(() => plugin.apply(inner));
      return { then(resolve, reject) { return loaded.then(() => resolve(), reject); },
        async dispose() { await loaded; if (!active) return; active = false; scoped.clear(); state.restricted = false; state.disposals++; } };
    } };
    agents.set(id, agent); if (root) roots.push(agent); return agent;
  }
  const run = (name, args, agent, signal = agent.controller.signal) => globals.get(name).execute(args, { agent, signal, callId: 'native_call', rootCallId: 'native_call' });
  return { ctx, host, globals, stores, runtimes, clients, agent, run, emit, globalGuards };
}

test('native start rejects child agents, non-human messages and secret arguments without demanding a game-name password', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  await assert.rejects(f.run('arena_start', {}, f.agent('child', { root: false })), { code: 'arena_root_agent_required' });
  await assert.rejects(f.run('arena_start', {}, f.agent('injection', { source: 'plugin' })), { code: 'arena_human_authorization_required' });
  await assert.rejects(f.run('arena_start', { game_token: 'secret' }, f.agent('secret')), { code: 'arena_invalid_entry' });
  assert.equal(f.stores.length, 0);
  for (const text of ['今天天气如何', '开启这个插件', '再跑一轮实时', '开始比赛', '打开房间']) {
    const status=await f.run('arena_start', {}, f.agent('preparation-' + text, { text }));
    assert.equal(status.native_loop.armed,false,'opening preparation is not match entry');
  }
  assert.equal(f.runtimes.length,0);
});

test('session-scoped native tools isolate two agents and never expose private credentials', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('a/../../unsafe'), b = f.agent('b');
  const paired = await beginGame(f, a); await beginGame(f, b, { mode_id:'battle_royale',room_id:'br-1' });
  assert.equal(paired.phase, 'waiting');
  assert.ok(!JSON.stringify(paired).includes('private-never-output'));
  assert.notEqual(f.stores[0].file, f.stores[1].file);
  assert.ok(!f.stores[0].file.includes('unsafe'));
  f.runtimes[0].enter(); await flush();
  assert.ok(a.scoped.has('mcp__model_action__observe')); assert.equal(b.scoped.has('mcp__model_action__observe'), false);
  assert.ok(f.globals.has('read_file')); assert.equal(a.scopeState.restricted, true);
  assert.equal(a.scopeState.guards[0]({ name: 'read_file' }), 'Model行动 session permits only game tools');
  assert.equal(a.scopeState.guards[0]({ name: 'mcp__model_action__observe' }), undefined);
  assert.equal(a.injections.length, 1); assert.equal(a.followups.length, 0);
  assert.equal(a.injections[0].source.kind, 'dsh-model-action');
  assert.ok(!['plugin', 'user'].includes(a.injections[0].source.kind));
  const result = await a.scoped.get('mcp__model_action__observe').execute({}, { agent: a, signal: a.controller.signal });
  assert.equal(JSON.parse(result.content[0].text).ok, true);
  await assert.rejects(a.scoped.get('mcp__model_action__observe').execute({}, { agent: b, signal: b.controller.signal }), { code: 'arena_not_running' });
});

test('preparing native turn waits without model polling, then injects same-turn continuation once', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('headless'); await beginGame(f, a);
  let completed = false;
  const pending = f.emit('agent/turn-stopping', { agent: a, signal: a.controller.signal }).then(() => { completed = true; });
  await flush(); assert.equal(completed, false); assert.equal(a.injections.length, 0);
  f.runtimes[0].enter(); await pending;
  assert.equal(completed, true); assert.equal(a.injections.length, 1); assert.equal(a.followups.length, 0);
  // Once consumed by the official loop, a later text final continues natively.
  a.inbox.nextStep.length = 0;
  await f.emit('agent/turn-stopping', { agent: a, signal: a.controller.signal });
  assert.equal(a.injections.length, 2);
});

test('idle entered agent uses native followup rather than another process or Agent instance', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('desktop-idle', { status: 'idle' }); await beginGame(f, a);
  f.runtimes[0].enter(); await flush();
  assert.equal(a.followups.length, 1); assert.equal(a.injections.length, 0);
  assert.equal(f.ctx.agents.roots().length, 1);
});

test('abort while pairing stops pending native continuation and late entry cannot revive it', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('cancelled'); await beginGame(f, a);
  const pending = f.emit('agent/turn-stopping', { agent: a, signal: a.controller.signal });
  await flush(); a.controller.abort({ kind: 'user' }); await pending;
  assert.equal(f.runtimes[0].stops[0].reason, 'user_stop');
  f.runtimes[0].enter(); await flush();
  assert.equal(a.injections.length, 0); assert.equal(a.followups.length, 0);
  const status = await f.run('arena_status', {}, a, new AbortController().signal);
  assert.equal(status.native_loop.armed, false);
});

test('terminal gracefully reports authoritative result and restores tools only after native turn ends', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('terminal'); await beginGame(f, a); f.runtimes[0].enter(); await flush();
  await f.runtimes[0].terminal({ outcome: 'won', placement: 1 });
  assert.equal(a.cancels.length, 0); assert.equal(a.scopeState.restricted, true);
  assert.equal(a.controller.signal.aborted, false);
  assert.equal(a.injections.at(-1).source.kind, 'dsh-model-action');
  assert.equal(a.injections.at(-1).source.purpose, 'arena-terminal');
  assert.ok(a.injections.at(-1).content[0].text.includes('"outcome":"won"'));
  assert.ok(a.scopeState.guards[0]({ name: 'mcp__model_action__observe' }));
  assert.equal(a.scopeState.guards[0]({ name: 'arena_status' }), undefined);
  const status = await f.run('arena_status', {}, a, new AbortController().signal);
  assert.deepEqual(status.result, { outcome: 'won', placement: 1 });
  assert.equal(status.native_loop.armed, false); assert.equal(status.native_loop.stop_reason, 'server_terminal');
  await assert.rejects(f.run('arena_start', {}, a, new AbortController().signal), { code: 'arena_human_authorization_required' });
  const before = a.injections.length; f.runtimes[0].enter(); await flush(); assert.equal(a.injections.length, before);
  await f.emit('agent/turn-stopping', { agent: a, signal: a.controller.signal });
  assert.equal(a.injections.length, before, 'terminal closing does not arm another gameplay step');
  await f.emit('session/event', a.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(a.scopeState.restricted, false); assert.equal(a.scoped.size, 0);
});

test('game-tool and native continuation budgets are enforced outside model instructions', async t => {
  const f = fixture({ maxToolCalls: 1, maxContinuations: 2 }); t.after(() => f.host.dispose());
  const a = f.agent('budget'); await beginGame(f, a); f.runtimes[0].enter(); await flush();
  const definition = a.scoped.get('mcp__model_action__observe');
  await definition.execute({}, { agent: a, signal: a.controller.signal });
  await assert.rejects(definition.execute({}, { agent: a, signal: a.controller.signal }), { code: 'arena_budget_exhausted' });
  assert.equal(f.runtimes[0].calls.length, 1); assert.equal(f.runtimes[0].stops[0].reason, 'budget_limit');
  assert.equal(f.runtimes[0].stops[0].options.abandon, true);
  assert.equal(a.scopeState.restricted, false);
  const g = fixture({ maxContinuations: 1 }); t.after(() => g.host.dispose());
  const b = g.agent('continuation-budget'); await beginGame(g, b); g.runtimes[0].enter(); await flush();
  b.inbox.nextStep.length = 0;
  await g.emit('agent/turn-stopping', { agent: b, signal: b.controller.signal }); await flush();
  assert.equal(b.injections.length, 1); assert.equal(g.runtimes[0].stops[0].reason, 'budget_limit');
  assert.equal(g.runtimes[0].stops[0].options.abandon, true);
});

test('explicit stop distinguishes remaining character and disposal closes each store without revival', async () => {
  const f = fixture(), a = f.agent('stopped'); await beginGame(f, a); f.runtimes[0].enter(); await flush();
  const result = await f.run('arena_stop', { abandon: false }, a);
  assert.equal(result.character_state, 'still_in_world');
  const before = a.injections.length; f.runtimes[0].enter(); await flush(); assert.equal(a.injections.length, before);
  await f.host.dispose();
  assert.ok(f.stores.every(store => store.closed)); assert.equal(f.globals.has('arena_start'), false);
  f.runtimes[0].enter(); await flush(); assert.equal(a.injections.length, before);
});

test('explicit new human start recovers a saved control lease only after confirmed control 401', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('restart'); await beginGame(f, a);
  await f.run('arena_stop', {}, a);
  const client = f.runtimes[0].options.client;
  client.connected = true; client.sessionError = Object.assign(new Error('expired'), { code: 'client_unauthorized', status: 401 });
  nextHumanTurn(a, '请恢复连接并加入游戏');
  await f.run('arena_connect', {}, a);
  assert.equal(client.resets, 1); assert.equal(f.runtimes.length, 1);
  assert.equal((await f.run('arena_status', {}, a)).phase, 'configuring');
});

test('network failure on saved control verification never clears the stored identity', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('network'); await beginGame(f, a); await f.run('arena_stop', {}, a);
  const client = f.runtimes[0].options.client;
  client.connected = true; client.sessionError = Object.assign(new Error('offline'), { code: 'network_error', retryable: true });
  nextHumanTurn(a, '请恢复连接游戏');
  await assert.rejects(f.run('arena_connect', {}, a), { code: 'network_error' });
  assert.equal(client.resets, 0);
});

test('fatal runtime failure cannot continue merely because its last entry state was in-world', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('fatal'); await beginGame(f, a); f.runtimes[0].enter(); await flush();
  const count = a.injections.length;
  f.runtimes[0].view = { ...f.runtimes[0].view, phase: 'error', active: false };
  f.runtimes[0].options.onState(f.runtimes[0].state()); await flush();
  await f.emit('agent/turn-stopping', { agent: a, signal: a.controller.signal });
  assert.equal(a.injections.length, count);
  assert.equal(f.runtimes[0].stops.at(-1).reason, 'client_error');
});

test('official native apply resolves undefined and loads/unloads through real Cordis effects', async t => {
  let Context;
  try {
    const local = createRequire(new URL('../host.js', import.meta.url));
    const official = createRequire(local.resolve('@deepseek-ai/dsh-tools'));
    ({ Context } = await import(pathToFileURL(official.resolve('@deepseek-ai/cordis'))));
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') { t.skip('official dsh peer dependencies are not installed in this environment'); return; }
    throw e;
  }
  const ctx = new Context(), definitions = new Set();
  ctx.provide('agents', { get() {}, roots() { return []; } });
  const globalGuards = new Set();
  ctx.provide('tools', { register(definition) { definitions.add(definition.name); return () => definitions.delete(definition.name); }, guard(fn) { globalGuards.add(fn); return () => globalGuards.delete(fn); } });
  const fiber = ctx.plugin({ name: 'model-action-official-effect-contract-test', inject: nativeInject,
    async apply(inner) {
      const result = await officialApply(inner, { home: '/tmp/model-action-native-no-session-effect-test' });
      assert.equal(result, undefined);
    } });
  await fiber;
  assert.deepEqual([...definitions], ['arena_start','arena_connect','arena_submit_invite','arena_prepare','arena_confirm','arena_status','arena_repair_pairing','arena_stop']);
  await fiber.dispose();
  assert.equal(definitions.size, 0);
  assert.equal(globalGuards.size, 0);
  await ctx.fiber.dispose();
});

test('entered callback and turn-stopping share one in-flight MCP bridge installation', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('bridge-race'); await beginGame(f, a);
  const runtime = f.runtimes[0]; let release, lists = 0;
  const gate = new Promise(resolve => { release = resolve; });
  runtime.listGameTools = async () => {
    lists++; await gate;
    return [{ name: 'get_rules', inputSchema: { type: 'object', properties: {} } }];
  };
  // Match actual race: the hook passes its initial activation check, then
  // refresh delivers entered while both paths wait for tools/list.
  runtime.view = { ...runtime.view, phase: 'in_world', entry_state: 'in_world' };
  runtime.refresh = async () => { runtime.options.onWake({ attempt_id: 'attempt_fixture', reason: 'entered' }); return runtime.state(); };
  const pending = f.emit('agent/turn-stopping', { agent: a, signal: a.controller.signal });
  await flush(); assert.equal(lists, 1);
  release(); await pending; await flush();
  assert.equal(lists, 1);
  assert.equal(a.scoped.has('mcp__model_action__get_rules'), true);
  assert.equal(a.injections.length, 1);
  const status = await f.run('arena_status', {}, a);
  assert.equal(status.native_loop.armed, true); assert.equal(status.host_error, undefined);
});

test('late old-generation tools/list cannot register into or wake the next human-started game', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('stale-bridge'); await beginGame(f, a);
  const old = f.runtimes[0]; let release;
  old.listGameTools = () => new Promise(resolve => { release = () => resolve([{ name: 'old_tool', inputSchema: { type: 'object', properties: {} } }]); });
  old.enter(); await flush();
  assert.equal(a.scoped.has('mcp__model_action__old_tool'), false);
  await f.run('arena_stop', {}, a);
  nextHumanTurn(a, '再次开始游戏');
  await beginGame(f, a); const current = f.runtimes[1];
  current.enter(); await flush();
  assert.equal(a.scoped.has('mcp__model_action__observe'), true);
  const injections = a.injections.length;
  release(); await flush();
  assert.equal(a.scoped.has('mcp__model_action__old_tool'), false);
  assert.equal(a.scoped.has('mcp__model_action__observe'), true);
  assert.equal(a.injections.length, injections);
  assert.equal((await f.run('arena_status', {}, a)).native_loop.armed, true);
  await old.terminal({ outcome: 'killed' });
  assert.equal((await f.run('arena_status', {}, a)).native_loop.armed, true);
});

test('terminal queues its result before a slow runtime stop can race native turn-stopping', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('slow-terminal-stop'); await beginGame(f, a); f.runtimes[0].enter(); await flush();
  a.inbox.nextStep.length = 0;
  const runtime = f.runtimes[0], originalStop = runtime.stop.bind(runtime);
  let release; const gate = new Promise(resolve => { release = resolve; });
  runtime.stop = async (...args) => { await gate; return originalStop(...args); };
  const settling = runtime.terminal({ outcome: 'won', placement: 1 });
  // No await/flush is needed: the native inbox already owns the authoritative
  // closing context even while runtime.stop has not settled.
  assert.equal(a.inbox.nextStep.length, 1);
  assert.equal(a.inbox.nextStep[0].source.purpose, 'arena-terminal');
  assert.ok(a.inbox.nextStep[0].content[0].text.includes('"placement":1'));
  await f.emit('agent/turn-stopping', { agent: a, signal: a.controller.signal });
  assert.equal(a.inbox.nextStep.length, 1); assert.equal(a.scopeState.restricted, true);
  // Simulate the official loop consuming the message and completing its final
  // report before the slow network shutdown settles.
  a.inbox.nextStep.length = 0;
  await f.emit('session/event', a.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(a.scopeState.restricted, false);
  release(); await settling;
  assert.equal(a.injections.filter(m => m.source.purpose === 'arena-terminal').length, 1);
  assert.equal(a.cancels.length, 0);
});

test('arena_stop during terminal closing cannot restore external tools before turn/end', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('terminal-then-stop'); await beginGame(f, a); f.runtimes[0].enter(); await flush();
  await f.runtimes[0].terminal({ outcome: 'killed' });
  assert.equal(a.scopeState.restricted, true);
  const stopped = await f.run('arena_stop', {}, a);
  assert.equal(stopped.character_state, 'ended');
  assert.equal(a.scopeState.restricted, true); assert.ok(a.scoped.has('arena_status'));
  assert.ok(a.scopeState.guards[0]({ name: 'read_file' }));
  assert.ok(a.scopeState.guards[0]({ name: 'mcp__model_action__observe' }));
  await f.emit('session/event', a.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(a.scopeState.restricted, false);
});

function nextHumanTurn(agent, text, source = 'user') {
  const seq = Math.max(0,...agent.session.log.map(event=>event.seq??0)) + 10;
  agent.session.log.push({ type: 'turn/start', seq, data: { turn: seq } },
    { type: 'user/message', seq: seq + 1, data: { source: { kind: source }, content: [{ type: 'text', text }] } });
}
const entry = {name:'测试玩家',character_id:'qwen',loadout_id:'rifle',mode_id:'extraction',room_id:'public-1'};
async function beginGame(f,a,overrides={}) {
  const started=await f.run('arena_start',{},a);
  if(started.native_loop.armed)return started;
  const prepared=await f.run('arena_prepare',{...entry,...overrides},a);
  nextHumanTurn(a,'确认');
  return f.run('arena_confirm',{confirmation_id:prepared.dialogue.confirmation_id},a);
}

test('native start opens conversation without queueing and rejects explicit negative intents',async t=>{
  const f=fixture({}, {qualified:false});t.after(()=>f.host.dispose());
  for(const text of ['开启model行动插件','打开 Model行动','enable Model Action plugin']){
    const a=f.agent('dialogue-'+text,{text});const status=await f.run('arena_start',{},a);
    assert.equal(status.phase,'awaiting_ticket');assert.equal(status.native_loop.armed,false);assert.equal(status.pairing,null);
    await f.emit('agent/turn-stopping',{agent:a,signal:a.controller.signal});
  }
  assert.equal(f.runtimes.length,0);assert.ok(f.clients.every(c=>c.nativeCalls.length===0));
  for(const text of ['不要开启model行动插件','别打开Model行动','do not enable Model Action plugin'])await assert.rejects(f.run('arena_start',{},f.agent('negative-'+text,{text})),{code:'arena_human_authorization_required'});
});

test('a current human invite or full same-origin link grants access without exposing it in tool arguments or output',async t=>{
  const f=fixture({}, {qualified:false});t.after(()=>f.host.dispose());const a=f.agent('ticket');await f.run('arena_start',{},a);
  const ticket='model_beta_invite_'+'A'.repeat(43);nextHumanTurn(a,'这是我的邀请链接：https://xingying.dev/agent-arena/lobby/#invite='+ticket);
  const status=await f.run('arena_submit_invite',{},a);
  assert.equal(f.clients[0].nativeCalls[0].ticket,ticket);assert.equal(status.phase,'configuring');assert.equal(status.browser_required,false);
  assert.ok(!JSON.stringify(status).includes(ticket));assert.equal(f.runtimes.length,0);
  await assert.rejects(f.run('arena_submit_invite',{ticket},a),{code:'arena_invalid_entry'});
});

test('invite submission refuses old/plugin-provided, ambiguous, cancelled and off-origin tickets',async t=>{
  const f=fixture({}, {qualified:false});t.after(()=>f.host.dispose());const a=f.agent('ticket-invalid');const ticket='model_beta_invite_'+'B'.repeat(43);await f.run('arena_start',{},a);
  for(const [text,source,code]of [[ticket,'plugin','arena_human_authorization_required'],['不要使用这个邀请码 '+ticket,'user','arena_human_authorization_required'],[ticket+' model_beta_invite_'+'C'.repeat(43),'user','arena_invite_ambiguous'],['https://other.invalid/#invite='+ticket,'user','arena_invite_origin_mismatch']]){
    nextHumanTurn(a,text,source);await assert.rejects(f.run('arena_submit_invite',{},a),{code});
  }
  assert.equal(f.clients[0].nativeCalls.length,0);
});

test('saved eligibility is reused but no room preparation runs before a complete summary and later human confirmation',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('confirm');const opened=await f.run('arena_start',{},a);
  assert.equal(opened.phase,'configuring');assert.equal(f.clients[0].nativeCalls.length,1);assert.equal(f.runtimes.length,0);
  await assert.rejects(f.run('arena_prepare',{name:'Only name'},a),{code:'arena_configuration_incomplete'});
  const prepared=await f.run('arena_prepare',entry,a);assert.equal(prepared.phase,'awaiting_confirmation');
  for(const value of ['测试玩家','Qwen 娘','步枪配置','持久搜打撤','公开持久房'])assert.ok(prepared.dialogue.summary.includes(value));
  const id=prepared.dialogue.confirmation_id;assert.ok(id);assert.equal(f.runtimes.length,0);assert.equal(prepared.native_loop.armed,false);
  await assert.rejects(f.run('arena_confirm',{confirmation_id:id},a),{code:'arena_human_confirmation_required'});
  nextHumanTurn(a,'可以开始');const started=await f.run('arena_confirm',{confirmation_id:id},a);assert.equal(started.native_loop.armed,true);assert.equal(f.runtimes.length,1);assert.deepEqual(f.runtimes[0].entry,entry);
  await f.run('arena_confirm',{confirmation_id:id},a);assert.equal(f.runtimes.length,1);
});

test('a configuration change, intervening human message, negative confirmation or cancelled proposal cannot reuse approval',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());
  for(const text of ['不要开始','取消','确认但把名字改成别的','他说确认']){
    const a=f.agent('reject-confirm-'+text);await f.run('arena_start',{},a);const prepared=await f.run('arena_prepare',entry,a);nextHumanTurn(a,text);
    await assert.rejects(f.run('arena_confirm',{confirmation_id:prepared.dialogue.confirmation_id},a),{code:'arena_human_confirmation_required'});
  }
  const a=f.agent('changed');await f.run('arena_start',{},a);const old=await f.run('arena_prepare',entry,a);nextHumanTurn(a,'改成自动匹配大逃杀');const changed=await f.run('arena_prepare',{...entry,mode_id:'battle_royale',room_id:null},a);assert.ok(changed.dialogue.summary.includes('自动匹配大逃杀房间'));nextHumanTurn(a,'确认');
  await assert.rejects(f.run('arena_confirm',{confirmation_id:old.dialogue.confirmation_id},a),{code:'arena_confirmation_stale'});
  await f.run('arena_confirm',{confirmation_id:changed.dialogue.confirmation_id},a);assert.equal(f.runtimes.at(-1).entry.room_id,null);
  const b=f.agent('intervening');await f.run('arena_start',{},b);const pending=await f.run('arena_prepare',entry,b);nextHumanTurn(b,'先换个形象');nextHumanTurn(b,'确认');await assert.rejects(f.run('arena_confirm',{confirmation_id:pending.dialogue.confirmation_id},b),{code:'arena_human_confirmation_required'});
  const c=f.agent('cancelled');await f.run('arena_start',{},c);const cancel=await f.run('arena_prepare',entry,c);await f.run('arena_stop',{},c);nextHumanTurn(c,'确认');await assert.rejects(f.run('arena_confirm',{confirmation_id:cancel.dialogue.confirmation_id},c),{code:'arena_confirmation_stale'});
});

test('catalog revision changes, expired confirmations and plugin-produced confirmation do not start a game',async t=>{
  let now=1000;const f=fixture({}, {clock:()=>now});t.after(()=>f.host.dispose());
  const a=f.agent('expires');await f.run('arena_start',{},a);const pending=await f.run('arena_prepare',entry,a);now+=300001;nextHumanTurn(a,'确认');await assert.rejects(f.run('arena_confirm',{confirmation_id:pending.dialogue.confirmation_id},a),{code:'arena_confirmation_stale'});
  const b=f.agent('catalog');await f.run('arena_start',{},b);const proposal=await f.run('arena_prepare',entry,b);f.clients.at(-1).catalogValue.catalog_revision='new-catalog';nextHumanTurn(b,'确认');await assert.rejects(f.run('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id},b),{code:'arena_confirmation_stale'});
  const c=f.agent('plugin-confirm');await f.run('arena_start',{},c);const automatic=await f.run('arena_prepare',entry,c);nextHumanTurn(c,'确认','plugin');await assert.rejects(f.run('arena_confirm',{confirmation_id:automatic.dialogue.confirmation_id},c),{code:'arena_human_authorization_required'});
  assert.equal(f.runtimes.length,0);
});

test('natural confirmation accepts a tactical instruction after an intervening configuration question',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('natural-confirm');
  await f.run('arena_start',{},a);const pending=await f.run('arena_prepare',entry,a);
  nextHumanTurn(a,'这套装备多少钱？');
  assert.equal((await f.run('arena_start',{},a)).phase,'awaiting_confirmation');
  nextHumanTurn(a,'好的，这次多拿点钱再撤离，可以开始了');
  const result=await f.run('arena_confirm',{confirmation_id:pending.dialogue.confirmation_id},a);
  assert.equal(result.native_loop.armed,true);assert.equal(f.runtimes.length,1);
  assert.deepEqual(f.clients[0].remembered,[entry]);
});

test('asking about appearance choices does not invalidate a reviewed configuration',async t=>{
  for(const question of ['可以选择形象吗？','Qwen 娘有什么不同？','冲锋枪配置有什么优点？']){
    const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('options-question-'+question);
    await f.run('arena_start',{},a);const proposal=await f.run('arena_prepare',entry,a);
    nextHumanTurn(a,question);assert.equal((await f.run('arena_start',{},a)).phase,'awaiting_confirmation');
    nextHumanTurn(a,'就这套开始，多拿点钱再撤离');
    const result=await f.run('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id},a);
    assert.equal(result.native_loop.armed,true);assert.deepEqual(f.runtimes[0].entry,entry);
  }
});

test('a polite request to change to a specific configuration invalidates the previous summary',async t=>{
  for(const text of ['可以换成默认形象吗？','装备能改成冲锋枪吗？']){
    const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('polite-change-'+text);
    await f.run('arena_start',{},a);const proposal=await f.run('arena_prepare',entry,a);
    nextHumanTurn(a,text);nextHumanTurn(a,'好');
    await assert.rejects(f.run('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id},a),{code:'arena_human_confirmation_required'});
    assert.equal(f.runtimes.length,0);
  }
});

test('the two actual-session replay requests reuse a confirmed configuration without another proposal or confirmation',async t=>{
  for(const text of ['再跑一轮实时','要多拿点钱再去撤离，再来一轮，确认开始','别太早撤离，再来一局','不用换形象再来一局']){
    const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('repeat-'+text);
    await beginGame(f,a);await f.runtimes[0].terminal({outcome:'extracted'});
    await f.emit('session/event',a.session,{type:'turn/end',data:{reason:{kind:'completed'}}});
    assert.equal(f.runtimes.length,1,'a terminal never starts another match on its own');
    nextHumanTurn(a,text);const result=await f.run('arena_start',{},a);
    assert.equal(result.native_loop.armed,true);assert.equal(result.dialogue.reused_configuration,true);
    assert.equal(result.dialogue.confirmation_id,null);assert.equal(f.runtimes.length,2);
    assert.deepEqual(f.runtimes[1].entry,entry);
    await f.run('arena_start',{},a);assert.equal(f.runtimes.length,2,'same request while starting is idempotent');
    await f.runtimes[1].terminal();await f.emit('session/event',a.session,{type:'turn/end',data:{reason:{kind:'completed'}}});
    await assert.rejects(f.run('arena_start',{},a),{code:'arena_human_authorization_required'});
    assert.equal(f.runtimes.length,2,'a completed human play request cannot be replayed');
  }
});

test('restored acknowledged configuration enables natural replay after host reload but ordinary replies do not',async t=>{
  for(const text of ['再来一局','再跑一轮实时']){
    const f=fixture({}, {confirmedEntry:entry});t.after(()=>f.host.dispose());
    const result=await f.run('arena_start',{},f.agent('restored-'+text,{text}));
    assert.equal(result.native_loop.armed,true);assert.deepEqual(f.runtimes[0].entry,entry);
  }
  for(const text of ['好的','知道了','确认','开始了吗？','什么时候开始？','准备好了吗？','为什么必须说开始？','他说“再来一局”','确认但先换个形象']){
    const f=fixture({}, {confirmedEntry:entry});t.after(()=>f.host.dispose());
    const result=await f.run('arena_start',{},f.agent('not-replay-'+text,{text}));
    assert.equal(result.native_loop.armed,false,text);assert.equal(f.runtimes.length,0,text);
  }
});

test('persisted terminal notices consume a pre-reload request and require a genuinely later human request',async t=>{
  const f=fixture({}, {confirmedEntry:entry});t.after(()=>f.host.dispose());const a=f.agent('reloaded-consumed',{text:'再来一局'});
  a.session.log.push({type:'user/message',seq:5,data:{source:{kind:'dsh-model-action',purpose:'arena-terminal'},content:[{type:'text',text:'服务器已确认本局结束'}]}});
  await assert.rejects(f.run('arena_start',{},a),{code:'arena_human_authorization_required'});assert.equal(f.runtimes.length,0);
  nextHumanTurn(a,'再跑一轮实时');assert.equal((await f.run('arena_start',{},a)).native_loop.armed,true);
  assert.equal(f.runtimes.length,1);
});

test('changed configuration is reviewed by differences before a new natural confirmation',async t=>{
  const f=fixture({}, {confirmedEntry:entry});t.after(()=>f.host.dispose());const a=f.agent('change-after-confirmed',{text:'装备换成冲锋枪，再来一轮'});
  assert.equal((await f.run('arena_start',{},a)).phase,'configuring');assert.equal(f.runtimes.length,0);
  const changed={...entry,loadout_id:'smg'},proposal=await f.run('arena_prepare',changed,a);
  assert.ok(proposal.dialogue.summary.includes('备战调整：装备：冲锋枪配置'));
  assert.ok(!proposal.dialogue.summary.includes('昵称：'),'only changes are repeated');
  nextHumanTurn(a,'行，就按这套打，多搜一些再撤离');
  const result=await f.run('arena_start',{},a);
  assert.equal(result.native_loop.armed,true);assert.deepEqual(f.runtimes[0].entry,changed);
});

test('unconfirmed preferences or removed catalog options never qualify for repeat entry',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('never-confirmed',{text:'再来一局'});
  const opened=await f.run('arena_start',{},a);assert.equal(opened.phase,'configuring');
  await f.run('arena_prepare',entry,a);nextHumanTurn(a,'这套装备多少钱？');await f.run('arena_start',{},a);
  assert.equal(f.runtimes.length,0);
  const g=fixture({}, {confirmedEntry:{...entry,loadout_id:'removed'}});t.after(()=>g.host.dispose());
  const invalid=await g.run('arena_start',{},g.agent('removed',{text:'再来一局'}));
  assert.equal(invalid.phase,'configuring');assert.equal(g.runtimes.length,0);
});

test('negative or injected replay requests do not start and concurrent real requests share one activation',async t=>{
  const f=fixture({}, {confirmedEntry:entry});t.after(()=>f.host.dispose());
  for(const [text,source]of [['不要再来一局','user'],['再来一局','plugin']]){
    await assert.rejects(f.run('arena_start',{},f.agent('blocked-'+source,{text,source})),{code:'arena_human_authorization_required'});
  }
  const a=f.agent('repeat-race',{text:'再跑一轮实时'});
  await Promise.all([f.run('arena_start',{},a),f.run('arena_start',{},a)]);
  assert.equal(f.runtimes.length,1);assert.deepEqual(f.runtimes[0].entry,entry);
});

test('a stop while confirmed preference persistence is pending cannot be revived by the delayed write',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('pending-consent');
  await f.run('arena_start',{},a);const proposal=await f.run('arena_prepare',entry,a);
  let release;f.clients[0].rememberGate=new Promise(resolve=>{release=resolve;});
  nextHumanTurn(a,'好，按这套开始吧');const pending=f.run('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id},a);
  await flush();await f.run('arena_stop',{},a);release();
  await assert.rejects(pending,{code:'arena_start_cancelled'});assert.equal(f.runtimes.length,0);
});

test('a new human refusal while persistence is pending cancels launch and an early turn-stopping hook remains safe',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('pending-human');
  await f.run('arena_start',{},a);const proposal=await f.run('arena_prepare',entry,a);
  let release;f.clients[0].rememberGate=new Promise(resolve=>{release=resolve;});
  nextHumanTurn(a,'就这套开始');const pending=f.run('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id},a);
  await flush();const stopping=f.emit('agent/turn-stopping',{agent:a,signal:a.controller.signal});
  nextHumanTurn(a,'先不要开局');release();
  await assert.rejects(pending,{code:'arena_human_authorization_required'});await stopping;
  assert.equal(f.runtimes.length,0);
});

test('a local consent write failure before runtime start can retry the same human confirmation',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('consent-retry');
  await f.run('arena_start',{},a);const proposal=await f.run('arena_prepare',entry,a);
  f.clients[0].rememberFailures=1;nextHumanTurn(a,'就这套开始，多搜一点');
  await assert.rejects(f.run('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id},a),{code:'store_write_failed'});
  assert.equal(f.runtimes.length,0);assert.equal((await f.run('arena_status',{},a)).phase,'awaiting_confirmation');
  const retried=await f.run('arena_start',{},a);
  assert.equal(retried.native_loop.armed,true);assert.equal(f.runtimes.length,1);assert.equal(f.clients[0].remembered.length,2);
});

test('a pre-start scope mounting failure is retryable but a runtime-start failure never replays a possible attempt',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('scope-retry');
  await f.run('arena_start',{},a);const proposal=await f.run('arena_prepare',entry,a);nextHumanTurn(a,'确认开始');
  const plugin=a.ctx.plugin;a.ctx.plugin=()=>{throw Object.assign(new Error('scope unavailable'),{code:'scope_unavailable'});};
  await assert.rejects(f.run('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id},a),{code:'scope_unavailable'});
  assert.ok(f.runtimes.every(r=>!r.startOptions));a.ctx.plugin=plugin;
  assert.equal((await f.run('arena_start',{},a)).native_loop.armed,true);
  assert.equal(f.runtimes.filter(r=>r.startOptions).length,1);
  const g=fixture({}, {confirmedEntry:entry});t.after(()=>g.host.dispose());const b=g.agent('started-failure',{text:'先显示配置'});
  await g.run('arena_start',{},b);g.clients[0].runtimeStartError=Object.assign(new Error('transport lost'),{code:'network_error'});
  nextHumanTurn(b,'再来一局');await assert.rejects(g.run('arena_start',{},b),{code:'network_error'});
  await assert.rejects(g.run('arena_start',{},b,new AbortController().signal),{code:'arena_human_authorization_required'});
  assert.equal(g.runtimes.length,1);
});

test('review-first requests show preparation and do not fast-start the saved configuration',async t=>{
  for(const text of ['等我确认后再开始','先看看配置，再开始']){
    const f=fixture({}, {confirmedEntry:entry});t.after(()=>f.host.dispose());const a=f.agent('review-first-'+text,{text});
    assert.equal((await f.run('arena_start',{},a)).native_loop.armed,false);assert.equal(f.runtimes.length,0);
  }
});

test('a later human message during repeat lookup prevents the old request from launching',async t=>{
  const f=fixture({}, {confirmedEntry:entry});t.after(()=>f.host.dispose());const a=f.agent('later-human',{text:'先显示配置'});
  await f.run('arena_start',{},a);let release;const client=f.clients[0],original=client.catalog.bind(client);
  client.catalog=()=>new Promise(resolve=>{release=async()=>resolve(await original());});
  nextHumanTurn(a,'再来一局');const pending=f.run('arena_start',{},a);await flush();
  nextHumanTurn(a,'不要开始');release();
  await assert.rejects(pending,{code:'arena_human_authorization_required'});assert.equal(f.runtimes.length,0);
});

test('a new human refusal during asynchronous scope mounting prevents the old request from starting a runtime',async t=>{
  const f=fixture({}, {confirmedEntry:entry});t.after(()=>f.host.dispose());const a=f.agent('scope-human-window',{text:'再来一局'});
  let release;const gate=new Promise(resolve=>{release=resolve;});const plugin=a.ctx.plugin;
  a.ctx.plugin=definition=>{
    const fiber=plugin(definition);
    return {then(resolve,reject){return gate.then(()=>fiber).then(resolve,reject);},dispose(){return fiber.dispose();}};
  };
  const pending=f.run('arena_start',{},a);await flush();
  assert.equal(f.runtimes.length,1);assert.equal(f.runtimes[0].startOptions,undefined);
  nextHumanTurn(a,'先不要开始');assert.equal(a.controller.signal.aborted,false);
  release();await assert.rejects(pending,{code:'arena_human_authorization_required'});
  assert.equal(f.runtimes.filter(runtime=>runtime.startOptions).length,0);
});

test('a pre-existing server game is shown without queueing, arming or abandoning it',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('existing');await f.run('arena_start',{},a);f.clients[0].serverState='in_world';nextHumanTurn(a,'继续 Model行动');const status=await f.run('arena_start',{},a);
  assert.equal(status.phase,'existing_game');assert.equal(status.native_loop.armed,false);assert.equal(f.runtimes.length,0);
  await assert.rejects(f.run('arena_prepare',entry,a),{code:'arena_game_already_running'});
});

test('credential guards remain active while conversational onboarding yields for a human reply',async()=>{
  const f=fixture({}, {qualified:false});const a=f.agent('guard-before-ticket');await f.run('arena_start',{},a);
  assert.equal(f.globalGuards.length,1);assert.ok(f.globalGuards[0]({name:'bash',arguments:{command:'cat ~/.dsh/plugins/dsh-aea/*/*.json'}}));assert.equal(a.scopeState.restricted,false);
  await f.host.dispose();assert.equal(f.globalGuards.length,0);
});


test('a pending native connection is replayed without asking the user for the same invite again',async t=>{
  const f=fixture({}, {qualified:false,pending:true});t.after(()=>f.host.dispose());const a=f.agent('recover-native-pending');
  const opened=await f.run('arena_start',{},a);assert.equal(opened.phase,'configuring');assert.equal(f.clients[0].nativeCalls.length,1);assert.equal(f.clients[0].nativeCalls[0].ticket,undefined);assert.equal(f.runtimes.length,0);
});


test('late configuration reads cannot overwrite a newer proposal and stop invalidates an in-flight confirm',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('configuration-race');await f.run('arena_start',{},a);const client=f.clients[0],catalog=structuredClone(client.catalogValue);let release;
  client.catalog=()=>new Promise(resolve=>{release=()=>resolve(catalog)});
  const old=f.run('arena_prepare',entry,a);await flush();client.catalog=async()=>catalog;
  const current=await f.run('arena_prepare',{...entry,name:'新方案'},a);release();await assert.rejects(old,{code:'arena_configuration_changed'});
  assert.equal((await f.run('arena_status',{},a)).dialogue.draft.name,'新方案');nextHumanTurn(a,'确认');
  client.catalog=()=>new Promise(resolve=>{release=()=>resolve(catalog)});
  const pending=f.run('arena_confirm',{confirmation_id:current.dialogue.confirmation_id},a);await flush();await f.run('arena_stop',{},a);release();await assert.rejects(pending,{code:'arena_confirmation_stale'});assert.equal(f.runtimes.length,0);
});

test('simultaneous replay of the same confirmed proposal starts one native runtime only',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('double-confirm');await f.run('arena_start',{},a);const proposal=await f.run('arena_prepare',entry,a);nextHumanTurn(a,'就这样');
  const client=f.clients[0],catalog=structuredClone(client.catalogValue);let release;const gate=new Promise(resolve=>{release=resolve});client.catalog=async()=>{await gate;return catalog};
  const first=f.run('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id},a),second=f.run('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id},a);release();await Promise.all([first,second]);assert.equal(f.runtimes.length,1);
});


test('an expired browser-era control without reusable native access asks for an invite in chat',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=f.agent('browser-control-expired');await f.run('arena_start',{},a);await f.run('arena_stop',{},a);
  f.clients[0].nativeError=Object.assign(new Error('invite required'),{code:'invite_required'});nextHumanTurn(a,'开启 Model行动');
  await assert.rejects(f.run('arena_start',{},a),{code:'invite_required'});const status=await f.run('arena_status',{},a);assert.equal(status.phase,'awaiting_ticket');assert.equal(status.native_loop.armed,false);assert.equal(f.runtimes.length,0);
});

async function existingGame(f, state='in_world') {
  const a=f.agent('existing-'+state);await f.run('arena_start',{},a);
  Object.assign(f.clients[0],{serverState:state,serverAttempt:{id:'old-attempt'}});
  nextHumanTurn(a,'继续 Model行动');await f.run('arena_start',{},a);return a;
}
test('existing game stop requires current authentic explicit abandonment and does not revive gameplay',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=await existingGame(f);
  for(const [text,source] of [['不要退出旧局','user'],['确认','user'],['stop writing','user'],['退出旧局','plugin']]){
    nextHumanTurn(a,text,source);await assert.rejects(f.run('arena_stop',{abandon:true},a),{code:'arena_human_authorization_required'});
  }
  a.session.log.push({type:'turn/start',seq:a.session.log.length,data:{turn:99}});await assert.rejects(f.run('arena_stop',{abandon:true},a),{code:'arena_human_authorization_required'});
  nextHumanTurn(a,'退出旧局');const still=await f.run('arena_stop',{abandon:false},a);
  assert.equal(still.character_state,'still_in_world');assert.equal(still.exit_confirmed,false);assert.equal(f.runtimes.length,0);
  assert.equal((await f.run('arena_status',{},a)).phase,'existing_game');
  const ended=await f.run('arena_stop',{abandon:true},a);assert.equal(ended.exit_confirmed,true);assert.equal(ended.terminal_confirmed,true);
  assert.equal(f.runtimes.length,1);assert.deepEqual(f.runtimes[0].startOptions,{autoEnter:false});assert.equal(f.runtimes[0].options.version,'0.2.1');
  assert.equal(a.injections.length,0);assert.equal(a.followups.length,0);assert.equal(a.scopeState.restricted,false);assert.equal(a.scoped.size,0);
  nextHumanTurn(a,'开始Model行动');assert.equal((await f.run('arena_start',{},a)).phase,'configuring');
});
test('existing reservations withdraw before clearing attempt without mounting a runtime',async t=>{
  for(const phase of ['queued','offered','waiting','countdown']){
    const f=fixture();t.after(()=>f.host.dispose());const a=await existingGame(f,phase);
    nextHumanTurn(a,'放弃旧局');const result=await f.run('arena_stop',{abandon:true},a);
    assert.equal(result.exit_confirmed,true);assert.equal(result.reservation_state,'released');assert.equal(f.clients[0].withdrawals,1);assert.deepEqual(f.clients[0].cleared,['old-attempt']);assert.equal(f.runtimes.length,0);
  }
});
test('unconfirmed exits keep existing game blocked and ended sessions only fetch results',async t=>{
  const f=fixture();t.after(()=>f.host.dispose());const a=await existingGame(f);f.clients[0].exitUnconfirmed=true;
  nextHumanTurn(a,'停止旧局');assert.equal((await f.run('arena_stop',{abandon:true},a)).exit_confirmed,false);
  assert.equal((await f.run('arena_status',{},a)).phase,'existing_game');await assert.rejects(f.run('arena_prepare',entry,a),{code:'arena_game_already_running'});
  f.clients[0].serverState='ended';f.clients[0].serverResult={outcome:'extracted'};
  const result=await f.run('arena_stop',{abandon:true},a);assert.equal(result.exit_confirmed,true);assert.equal(result.result.outcome,'extracted');assert.equal(f.runtimes.length,1);
  const g=fixture();t.after(()=>g.host.dispose());const b=await existingGame(g,'waiting');g.clients[0].withdrawError=Object.assign(new Error('offline'),{code:'network_error'});nextHumanTurn(b,'退出旧局');
  assert.equal((await g.run('arena_stop',{abandon:true},b)).exit_confirmed,false);assert.equal(g.clients[0].cleared,undefined);assert.equal((await g.run('arena_status',{},b)).phase,'existing_game');
});
