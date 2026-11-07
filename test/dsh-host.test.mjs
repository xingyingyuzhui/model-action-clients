import test from 'node:test';
import assert from 'node:assert/strict';
import { installArenaHost, apply as officialApply, inject as nativeInject } from '../packages/dsh-model-action/host.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(config = {}) {
  const globals = new Map(), listeners = new Map(), roots = [], agents = new Map(), stores = [], runtimes = [];
  let nextMessage = 0;
  const register = map => definition => {
    assert.equal(map.has(definition.name), false, definition.name);
    map.set(definition.name, definition); return () => map.delete(definition.name);
  };
  const ctx = {
    tools: { register: register(globals) },
    agents: { get: id => agents.get(id), roots: () => [...roots] },
    on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
    effect() {},
  };
  async function emit(name, ...args) { for (const fn of [...listeners.get(name) ?? []]) await fn(...args); }
  class Store { constructor(file) { this.file = file; this.closed = false; stores.push(this); } async close() { this.closed = true; } }
  class Client {
    constructor(options) { this.options = options; this.connected = false; this.resets = 0; }
    async publicState() { return { connected: this.connected }; }
    async session() { if (this.sessionError) throw this.sessionError; return { state: 'preparing' }; }
    async resetConnection() { this.resets++; this.connected = false; }
  }
  class Runtime {
    constructor(options) { this.options = options; this.calls = []; this.stops = []; this.view = { phase: 'idle', entry_state: null, active: false, current_attempt: null }; runtimes.push(this); }
    state() { return structuredClone(this.view); }
    async start(options) {
      this.entry = options.entry;
      this.view = { ...this.view, phase: 'pairing', active: true, pairing: { user_code: 'SAFE-PAIR', expires_at_ms: Date.now() + 300000 }, game_token: 'private-never-output' };
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
      this.stops.push({ reason, options }); this.view.active = false; this.view.phase = 'stopped';
      return { stopped: true, character_state: this.view.entry_state === 'ended' || options.abandon ? 'ended' : this.view.entry_state === 'in_world' ? 'still_in_world' : 'not_in_world' };
    }
    async terminal(result = { outcome: 'won' }) {
      this.view = { ...this.view, entry_state: 'ended', phase: 'ended', result };
      this.options.onState(this.state()); await this.options.onTerminal({ attempt_id: 'attempt_fixture', result });
    }
  }
  const dependencies = {
    ArenaRuntime: Runtime, ArenaClient: Client, AtomicStore: Store, defineTool: x => x,
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
  return { ctx, host, globals, stores, runtimes, agent, run, emit };
}

test('native start rejects child agents, non-human/tool messages, unrelated human turns and secret arguments', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  await assert.rejects(f.run('arena_start', {}, f.agent('child', { root: false })), { code: 'arena_root_agent_required' });
  await assert.rejects(f.run('arena_start', {}, f.agent('injection', { source: 'plugin' })), { code: 'arena_human_authorization_required' });
  await assert.rejects(f.run('arena_start', {}, f.agent('weather', { text: '今天天气如何' })), { code: 'arena_human_authorization_required' });
  await assert.rejects(f.run('arena_start', { game_token: 'secret' }, f.agent('secret')), { code: 'arena_invalid_entry' });
  assert.equal(f.stores.length, 0);
});

test('session-scoped native tools isolate two agents and never expose private credentials', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('a/../../unsafe'), b = f.agent('b');
  const paired = await f.run('arena_start', {}, a); await f.run('arena_start', { mode_id: 'battle_royale', room_id: 'br-1' }, b);
  assert.equal(paired.pairing.user_code, 'SAFE-PAIR');
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
  const a = f.agent('headless'); await f.run('arena_start', {}, a);
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
  const a = f.agent('desktop-idle', { status: 'idle' }); await f.run('arena_start', {}, a);
  f.runtimes[0].enter(); await flush();
  assert.equal(a.followups.length, 1); assert.equal(a.injections.length, 0);
  assert.equal(f.ctx.agents.roots().length, 1);
});

test('abort while pairing stops pending native continuation and late entry cannot revive it', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('cancelled'); await f.run('arena_start', {}, a);
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
  const a = f.agent('terminal'); await f.run('arena_start', {}, a); f.runtimes[0].enter(); await flush();
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
  await assert.rejects(f.run('arena_start', {}, a, new AbortController().signal), { code: 'arena_new_human_start_required' });
  const before = a.injections.length; f.runtimes[0].enter(); await flush(); assert.equal(a.injections.length, before);
  await f.emit('agent/turn-stopping', { agent: a, signal: a.controller.signal });
  assert.equal(a.injections.length, before, 'terminal closing does not arm another gameplay step');
  await f.emit('session/event', a.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(a.scopeState.restricted, false); assert.equal(a.scoped.size, 0);
});

test('game-tool and native continuation budgets are enforced outside model instructions', async t => {
  const f = fixture({ maxToolCalls: 1, maxContinuations: 2 }); t.after(() => f.host.dispose());
  const a = f.agent('budget'); await f.run('arena_start', {}, a); f.runtimes[0].enter(); await flush();
  const definition = a.scoped.get('mcp__model_action__observe');
  await definition.execute({}, { agent: a, signal: a.controller.signal });
  await assert.rejects(definition.execute({}, { agent: a, signal: a.controller.signal }), { code: 'arena_budget_exhausted' });
  assert.equal(f.runtimes[0].calls.length, 1); assert.equal(f.runtimes[0].stops[0].reason, 'budget_limit');
  assert.equal(f.runtimes[0].stops[0].options.abandon, true);
  assert.equal(a.scopeState.restricted, false);
  const g = fixture({ maxContinuations: 1 }); t.after(() => g.host.dispose());
  const b = g.agent('continuation-budget'); await g.run('arena_start', {}, b); g.runtimes[0].enter(); await flush();
  b.inbox.nextStep.length = 0;
  await g.emit('agent/turn-stopping', { agent: b, signal: b.controller.signal }); await flush();
  assert.equal(b.injections.length, 1); assert.equal(g.runtimes[0].stops[0].reason, 'budget_limit');
  assert.equal(g.runtimes[0].stops[0].options.abandon, true);
});

test('explicit stop distinguishes remaining character and disposal closes each store without revival', async () => {
  const f = fixture(), a = f.agent('stopped'); await f.run('arena_start', {}, a); f.runtimes[0].enter(); await flush();
  const result = await f.run('arena_stop', { abandon: false }, a);
  assert.equal(result.character_state, 'still_in_world');
  const before = a.injections.length; f.runtimes[0].enter(); await flush(); assert.equal(a.injections.length, before);
  await f.host.dispose();
  assert.ok(f.stores.every(store => store.closed)); assert.equal(f.globals.has('arena_start'), false);
  f.runtimes[0].enter(); await flush(); assert.equal(a.injections.length, before);
});

test('explicit new human start recovers a saved control lease only after confirmed control 401', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('restart'); await f.run('arena_start', {}, a);
  await f.run('arena_stop', {}, a);
  const client = f.runtimes[0].options.client;
  client.connected = true; client.sessionError = Object.assign(new Error('expired'), { code: 'client_unauthorized', status: 401 });
  a.session.log.push({ type: 'turn/start', seq: 10, data: { turn: 2 } },
    { type: 'user/message', seq: 11, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请恢复连接并加入游戏' }] } });
  await f.run('arena_connect', {}, a);
  assert.equal(client.resets, 1); assert.equal(f.runtimes.length, 2);
  assert.equal((await f.run('arena_status', {}, a)).phase, 'pairing');
});

test('network failure on saved control verification never clears the stored identity', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('network'); await f.run('arena_start', {}, a); await f.run('arena_stop', {}, a);
  const client = f.runtimes[0].options.client;
  client.connected = true; client.sessionError = Object.assign(new Error('offline'), { code: 'network_error', retryable: true });
  a.session.log.push({ type: 'turn/start', seq: 10, data: { turn: 2 } },
    { type: 'user/message', seq: 11, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请恢复连接游戏' }] } });
  await assert.rejects(f.run('arena_connect', {}, a), { code: 'network_error' });
  assert.equal(client.resets, 0);
});

test('fatal runtime failure cannot continue merely because its last entry state was in-world', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('fatal'); await f.run('arena_start', {}, a); f.runtimes[0].enter(); await flush();
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
    const local = createRequire(new URL('../packages/dsh-model-action/host.js', import.meta.url));
    const official = createRequire(local.resolve('@deepseek-ai/dsh-tools'));
    ({ Context } = await import(pathToFileURL(official.resolve('@deepseek-ai/cordis'))));
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') { t.skip('official dsh peer dependencies are not installed in this environment'); return; }
    throw e;
  }
  const ctx = new Context(), definitions = new Set();
  ctx.provide('agents', { get() {}, roots() { return []; } });
  ctx.provide('tools', { register(definition) { definitions.add(definition.name); return () => definitions.delete(definition.name); } });
  const fiber = ctx.plugin({ name: 'model-action-official-effect-contract-test', inject: nativeInject,
    async apply(inner) {
      const result = await officialApply(inner, { home: '/tmp/model-action-native-no-session-effect-test' });
      assert.equal(result, undefined);
    } });
  await fiber;
  assert.deepEqual([...definitions], ['arena_start', 'arena_connect', 'arena_status', 'arena_stop']);
  await fiber.dispose();
  assert.equal(definitions.size, 0);
  await ctx.fiber.dispose();
});

test('entered callback and turn-stopping share one in-flight MCP bridge installation', async t => {
  const f = fixture(); t.after(() => f.host.dispose());
  const a = f.agent('bridge-race'); await f.run('arena_start', {}, a);
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
  const a = f.agent('stale-bridge'); await f.run('arena_start', {}, a);
  const old = f.runtimes[0]; let release;
  old.listGameTools = () => new Promise(resolve => { release = () => resolve([{ name: 'old_tool', inputSchema: { type: 'object', properties: {} } }]); });
  old.enter(); await flush();
  assert.equal(a.scoped.has('mcp__model_action__old_tool'), false);
  await f.run('arena_stop', {}, a);
  a.session.log.push({ type: 'turn/start', seq: 10, data: { turn: 2 } },
    { type: 'user/message', seq: 11, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再次开始游戏' }] } });
  await f.run('arena_start', {}, a); const current = f.runtimes[1];
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
  const a = f.agent('slow-terminal-stop'); await f.run('arena_start', {}, a); f.runtimes[0].enter(); await flush();
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
  const a = f.agent('terminal-then-stop'); await f.run('arena_start', {}, a); f.runtimes[0].enter(); await flush();
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
