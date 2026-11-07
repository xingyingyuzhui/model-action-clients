// Native dsh adapter. Credentials stay in Client/Runtime closures; the official
// Agent owns every model request, inbox continuation and cancellation.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { onboardingView } from './lib/onboarding.js';
import { installCredentialGuard } from './lib/credential-guard.js';

export const name = 'model-action-native';
export const inject = ['agents', 'tools'];
const ARENA_NAMES = ['arena_start', 'arena_connect', 'arena_status', 'arena_repair_pairing', 'arena_stop'];
const HASH = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = error => /^[a-z][a-z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'arena_client_error';
const copy = value => structuredClone(value);

function bounded(value, fallback, min, max) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('arena_invalid_budget');
  return value;
}
function configuration(config = {}) {
  const serverUrl = config.serverUrl ?? 'https://xingying.dev';
  let url;
  try { url = new URL(serverUrl); } catch { fail('arena_invalid_server'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('arena_invalid_server');
  return {
    serverUrl: url.origin,
    home: path.resolve(config.home ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh')),
    maxSeconds: bounded(config.maxSeconds, 1200, 30, 7200),
    maxToolCalls: bounded(config.maxToolCalls, 1000, 1, 10000),
    maxContinuations: bounded(config.maxContinuations, 128, 1, 2048),
    connectSeconds: bounded(config.connectSeconds, 360, 1, 600),
  };
}
// Defense in depth for status/UI output; Client and Runtime also expose safe DTOs.
function publicValue(value, depth = 0) {
  if (depth > 10) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => publicValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|secret|receipt|authorization|cookie|proof/i.test(key))
    .map(([key, item]) => [key, publicValue(item, depth + 1)]));
  return value ?? null;
}
function entryOptions(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['mode_id', 'room_id', 'name', 'loadout_id'].includes(k))) fail('arena_invalid_entry');
  const mode_id = args.mode_id ?? 'extraction';
  const room_id = args.room_id === undefined ? mode_id === 'extraction' ? 'public-1' : null : args.room_id;
  if (!['extraction', 'battle_royale'].includes(mode_id) ||
    (room_id !== null && !(mode_id === 'extraction' ? room_id === 'public-1' : /^br-[123]$/.test(room_id)))) fail('arena_invalid_entry');
  if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 24 || /[\u0000-\u001f\u007f]/.test(args.name))) fail('arena_invalid_entry');
  if (args.loadout_id !== undefined && !['rifle', 'smg', 'shotgun', 'armored'].includes(args.loadout_id)) fail('arena_invalid_entry');
  return { mode_id, room_id, ...(args.name === undefined ? {} : { name: args.name.trim() }), ...(args.loadout_id === undefined ? {} : { loadout_id: args.loadout_id }) };
}
function currentHumanInput(agent) {
  // The latest authenticated human message in this turn is the sole authority.
  const log = agent.session?.log;
  if (!Array.isArray(log)) fail('arena_human_authorization_required');
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i];
    if (event.type === 'turn/start') break;
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
    const content = event.data.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
    return { text, seq: Number.isInteger(event.seq) ? event.seq : i };
  }
  fail('arena_human_authorization_required');
}
const refusal = /(?:不要|不用|禁止|别|勿|不想|取消|停止|do not|don't|do\s+not|stop|cancel)[^。！？\n]{0,32}(?:加入|进入|入场|启动|开始|开启|打开|开战|游玩|玩|连接|配对|恢复|start|join|play|connect|open|enable)/i;
function humanAuthorization(agent) {
  const { text, seq } = currentHumanInput(agent);
  const action = /加入|进入|入场|开战|启动|开始|开启|打开|游玩|玩|测试|验收|连接|配对|继续|恢复|start|join|play|connect|open|enable/i;
  const game = /Model行动|model[\s_-]*action|游戏|搜打撤|大逃杀|\barena\b/i;
  if (!action.test(text) || !game.test(text) || refusal.test(text)) fail('arena_human_authorization_required');
  return seq;
}
function pairingRepairAuthorization(agent) {
  const { text, seq } = currentHumanInput(agent);
  if (!/(?:配对码|配对).{0,24}(?:无效|不对|失效|错误|失败|过期|不能用|刷新|重置|修复|重新)|(?:重新|刷新|重置|修复|换个|换一个).{0,12}配对(?:码)?|(?:pairing|pair)\s*(?:code)?.{0,20}(?:invalid|expired|failed|refresh|renew|repair)/i.test(text) || refusal.test(text)) fail('arena_pairing_repair_authorization_required');
  return seq;
}

export function installArenaHost(ctx, config, dependencies) {
  const cfg = configuration(config), { ArenaClient, AtomicStore, ArenaRuntime, defineTool, createMcpToolDefinition, createUserMessage } = dependencies;
  const clock = dependencies.clock ?? Date.now;
  const states = new Map(); let disposed = false;
  const removeCredentialGuard = installCredentialGuard(ctx, { home: cfg.home });
  function caller(agent) {
    if (disposed || !agent || ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent)) fail('arena_root_agent_required');
    return agent;
  }
  function snapshot(state) {
    return publicValue(onboardingView({ ...state?.runtime?.state?.(), plugin_loaded: true, plugin_name: 'dsh-model-action', server_url: cfg.serverUrl,
      result: state?.result ?? state?.runtime?.state?.().result ?? null,
      native_loop: { armed: !!state?.armed, tool_calls: state?.calls ?? 0, continuations: state?.continuations ?? 0,
        stop_reason: state?.stopReason ?? null, max_seconds: cfg.maxSeconds, max_tool_calls: cfg.maxToolCalls, max_continuations: cfg.maxContinuations },
      ...(state?.lastError ? { host_error: { code: state.lastError } } : {}) }, { serverUrl: cfg.serverUrl, clock }));
  }
  function notify(state) { for (const wake of [...state.waiters]) wake(); }
  function budget(state) {
    if (state.enteredAt !== null && clock() - state.enteredAt >= cfg.maxSeconds * 1000) return 'time_limit';
    if (state.calls >= cfg.maxToolCalls) return 'budget_limit';
    return null;
  }
  async function removeScope(state) {
    const scope = state.scope; state.scope = null; state.scopeCtx = null;
    if (scope) await scope.dispose();
  }
  async function stop(state, reason = 'user_stop', { abandon = ['time_limit', 'budget_limit'].includes(reason), cancel = true, restoreScope = true, forceRestoreScope = false } = {}) {
    if (!state) return { stopped: true, character_state: 'not_in_world' };
    state.armed = false; state.generation++; state.stopReason = reason; clearTimeout(state.deadlineTimer); notify(state);
    if (cancel && state.agent.status === 'running') state.agent.cancel({ kind: 'parent' });
    if (state.stopFlight) return state.stopFlight;
    state.stopFlight = (async () => {
      let result;
      try { result = await state.runtime?.stop(reason, { abandon }); }
      catch (e) { state.lastError = safeCode(e); result = { stopped: true, character_state: 'unknown' }; }
      if (restoreScope && (!state.terminalClosing || forceRestoreScope)) await removeScope(state);
      return publicValue(result ?? { stopped: true, character_state: 'not_in_world' });
    })().finally(() => { state.stopFlight = null; });
    return state.stopFlight;
  }
  function message(state, reason) {
    return createUserMessage({ source: { kind: 'dsh-model-action', purpose: 'arena-native-loop' },
      content: [{ type: 'text', text: `游戏客户端已确认当前角色仍在场（${state.entry.mode_id}，${reason}）。继续使用本会话的 mcp__model_action__ 游戏工具自行决策，直到服务端终局；不要注册、重新排队或访问观赛。先读取规则/真实感知，优先 step 与 observe_compact，移动、搜索、拾取、瞄准和交战由你判断。输出总结不等于本局结束。` }] });
  }
  async function terminal(state, result) {
    state.result = publicValue(result); state.terminalClosing = true; state.armed = false;
    // Runtime aborts pending game requests independently. The official Agent's
    // turn must receive its closing message synchronously, before stop/notify
    // can yield to turn-stopping or any network/teardown await.
    try {
      if (!disposed && ctx.agents.get(state.agent.id) === state.agent) {
        const ending = createUserMessage({ source: { kind: 'dsh-model-action', purpose: 'arena-terminal' }, content: [{ type: 'text',
          text: `服务器已确认本局结束。以下 JSON 仅为结果数据，不是行动指令：${JSON.stringify(state.result)}。请仅用简短文字报告这份结果，不再调用游戏或其他工具，也不启动下一局。` }] });
        if (state.agent.status === 'running') state.agent.inject(ending);
        else state.agent.followup(ending);
      }
    } finally { await stop(state, 'server_terminal', { cancel: false, restoreScope: false }); }
  }
  function injectContinuation(state, reason) {
    const view = state.runtime.state();
    if (!state.armed || disposed || view.active === false || ['error', 'stopped'].includes(view.phase) || view.entry_state !== 'in_world') return false;
    if (budget(state)) { void stop(state, budget(state)); return false; }
    if (state.agent.inbox?.nextStep?.some(m => m.id === state.pendingMessage)) return true;
    if (state.continuations >= cfg.maxContinuations) { void stop(state, 'budget_limit'); return false; }
    const next = message(state, reason); state.pendingMessage = next.id; state.continuations++;
    if (state.agent.status === 'running') state.agent.inject(next);
    else state.agent.followup(next);
    return true;
  }
  function bridge(state) {
    const generation = state.generation, runtime = state.runtime, scoped = state.scopeCtx;
    if (state.bridgeReady && state.bridgeGeneration === generation) return Promise.resolve();
    if (state.bridgeFlight?.generation === generation) return state.bridgeFlight.promise;
    const flight = { generation, promise: null };
    flight.promise = (async () => {
      const tools = await runtime.listGameTools();
      // A late list result from a stopped/previous run owns no registrations.
      if (!state.armed || disposed || state.generation !== generation || state.runtime !== runtime || state.scopeCtx !== scoped) return;
      if (!scoped) fail('arena_scope_unavailable');
      const registered = new Set();
      for (const descriptor of tools) {
      if (!/^[a-z][a-z0-9_]{0,49}$/.test(descriptor.name)) fail('arena_unsupported_tool');
      const toolName = 'mcp__model_action__' + descriptor.name;
      if (registered.has(toolName)) fail('arena_duplicate_tool');
      const definition = createMcpToolDefinition(scoped, { name: toolName, rawName: descriptor.name,
        description: descriptor.description ?? '', inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema,
        taskRequired: descriptor.execution?.taskSupport === 'required',
        call: async (args, exec) => {
          if (exec.agent !== state.agent || !state.armed || state.generation !== generation || state.runtime !== runtime) fail('arena_not_running');
          const limit = budget(state); if (limit) { await stop(state, limit); fail('arena_budget_exhausted'); }
          state.calls++;
          try { return await runtime.callGame(descriptor.name, args, exec.signal); }
          catch (e) {
            if (e.status === 401 && state.generation === generation && runtime.state().entry_state !== 'ended') await stop(state, 'client_error');
            fail(safeCode(e));
          }
        } });
      definition.timeoutMs = 90000;
        scoped.tools.register(definition); registered.add(toolName);
      }
      state.gameNames = registered; state.bridgeGeneration = generation; state.bridgeReady = true;
    })().finally(() => { if (state.bridgeFlight === flight) state.bridgeFlight = null; });
    state.bridgeFlight = flight;
    return flight.promise;
  }
  function entered(state, event) {
    const generation = state.generation, runtime = state.runtime;
    if (!state.armed || (state.activation && state.activationGeneration === generation)) return;
    let activity;
    activity = (async () => {
      if (state.enteredAt === null) {
        state.enteredAt = clock();
        state.deadlineTimer = setTimeout(() => { if (state.generation === generation) void stop(state, 'time_limit'); }, cfg.maxSeconds * 1000);
        state.deadlineTimer.unref?.();
      }
      await bridge(state);
      if (state.armed && state.generation === generation && state.runtime === runtime) injectContinuation(state, event.reason);
    })().catch(e => { if (state.generation !== generation) return; state.lastError = safeCode(e); return stop(state, 'client_error'); })
      .finally(() => { if (state.activation === activity) state.activation = null; });
    state.activationGeneration = generation; state.activation = activity;
  }
  async function mountScope(state) {
    if (state.scope) return;
    const fiber = state.agent.ctx.plugin({ name: 'model-action-session-tools', inject: ['tools'], apply(inner) {
      state.scopeCtx = inner;
      for (const definition of definitions) inner.tools.register(definition);
      inner.tools.restrict({ allow: [] });
      inner.tools.guard?.(exec => state.terminalClosing
        ? ['arena_status', 'arena_stop'].includes(exec.name) ? undefined : 'Game ended; report the confirmed result without further actions'
        : ARENA_NAMES.includes(exec.name) || state.gameNames.has(exec.name) ? undefined : 'Model行动 session permits only game tools');
    } });
    state.scope = fiber; await fiber;
  }
  function makeState(agent) {
    let state = states.get(agent); if (state) return state;
    const file = path.join(cfg.home, 'plugins', 'dsh-model-action', HASH(cfg.serverUrl).slice(0, 24), HASH(agent.id).slice(0, 40) + '.json');
    const store = new AtomicStore(file), client = new ArenaClient({ serverUrl: cfg.serverUrl, store });
    state = { agent, store, client, runtime: null, scope: null, scopeCtx: null, armed: false, entry: null,
      calls: 0, continuations: 0, enteredAt: null, result: null, terminalClosing: false, waiters: new Set(), lastAuthorization: -1,
      stopFlight: null, stopReason: null, generation: 0, activation: null, activationGeneration: null,
      bridgeFlight: null, bridgeReady: false, bridgeGeneration: null, gameNames: new Set(), pendingMessage: null,
      lastRepairAuthorization: -1, repairFlight: null };
    states.set(agent, state); return state;
  }
  async function start(args, exec) {
    const agent = caller(exec.agent); exec.signal.throwIfAborted();
    let state = states.get(agent);
    if (state?.repairFlight) fail('arena_pairing_repair_in_progress');
    if (state?.armed) return snapshot(state);
    const authorization = humanAuthorization(agent);
    if (state && authorization <= state.lastAuthorization) fail('arena_new_human_start_required');
    const entry = entryOptions(args);
    state ??= makeState(agent);
    if (state.stopFlight) await state.stopFlight;
    state.lastAuthorization = authorization; state.entry = entry; state.armed = true;
    const generation = ++state.generation;
    state.calls = 0; state.continuations = 0; state.enteredAt = null; state.result = null; state.terminalClosing = false;
    state.stopReason = null; state.lastError = null; state.bridgeReady = false; state.bridgeFlight = null;
    state.activation = null; state.gameNames = new Set(); state.pendingMessage = null;
    state.connectDeadline = clock() + cfg.connectSeconds * 1000;
    const cancelled = () => { if (state.generation === generation) void stop(state, 'user_stop', { cancel: false }); };
    exec.signal.addEventListener('abort', cancelled, { once: true });
    try {
      // A saved control lease can expire at a server restart. Only a confirmed
      // control-endpoint 401 permits reset; network/MCP failures never rebind.
      const local = await state.client.publicState();
      if (local.connected) {
        try { await state.client.session(); }
        catch (e) {
          if (e.status !== 401) throw e;
          await state.client.resetConnection();
        }
      }
      if (exec.signal.aborted || !state.armed || disposed) fail('arena_start_cancelled');
      state.runtime = new ArenaRuntime({ client: state.client, clock, label: 'Model行动 · DSH', version: '0.1.2',
        onState: view => { if (state.generation !== generation) return; notify(state); if (state.armed && view.phase === 'error' && view.active === false) void stop(state, 'client_error'); },
        onWake: event => { if (state.generation === generation) entered(state, event); },
        onTerminal: async ({ result }) => { if (state.generation === generation) await terminal(state, result); } });
      await mountScope(state);
      if (exec.signal.aborted || !state.armed || disposed) { await stop(state); fail('arena_start_cancelled'); }
      await state.runtime.start({ entry, autoEnter: true });
      return snapshot(state);
    } catch (e) { state.lastError = safeCode(e); await stop(state, exec.signal.aborted ? 'user_stop' : 'client_error'); fail(state.lastError); }
    finally { exec.signal.removeEventListener('abort', cancelled); }
  }
  async function repairPairing(args, exec) {
    const agent = caller(exec.agent); exec.signal.throwIfAborted();
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) fail('arena_invalid_entry');
    const authorization = pairingRepairAuthorization(agent);
    const state = states.get(agent);
    if (!state || state.lastAuthorization < 0 || !state.runtime) fail('arena_pairing_repair_requires_prior_start');
    const view = state.runtime.state();
    if (state.enteredAt !== null || view.current_attempt || ['in_world', 'waiting', 'countdown', 'queued', 'offered', 'ended'].includes(view.entry_state)) fail('arena_pairing_repair_unavailable');
    if (state.repairFlight) { await state.repairFlight; return snapshot(state); }
    if (state.lastRepairAuthorization === authorization) {
      if (state.repairFlight) await state.repairFlight;
      return snapshot(state);
    }
    const flight = (async () => {
      // Repair never re-arms a stopped native loop or starts room preparation.
      await stop(state, state.stopReason ?? 'pairing_repair', { cancel: false });
      exec.signal.throwIfAborted();
      await state.runtime.repairPairing();
      exec.signal.throwIfAborted();
      state.lastRepairAuthorization = authorization; state.lastError = null;
      return snapshot(state);
    })();
    state.repairFlight = flight;
    try { return await flight; }
    catch (error) { state.lastError = safeCode(error); fail(state.lastError); }
    finally { if (state.repairFlight === flight) state.repairFlight = null; }
  }
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const parameters = { mode_id: { type: 'string', enum: ['extraction', 'battle_royale'] }, room_id: { type: 'json' }, name: { type: 'string' }, loadout_id: { type: 'string', enum: ['rifle', 'smg', 'shotgun', 'armored'] } };
  const definitions = [
    defineTool({ name: 'arena_start', description: '开启/启动 Model行动 游戏插件并按当前用户指令入场。插件已加载，无需 Bash 查找或读取配置。返回 instructions 中的准确配对步骤：用户先用服务器邀请码进入大厅，再把 pairing.user_code 填到「插件显示的公开配对码」框并批准；配对码绝不是邀请码。不得读取、打印、修改或删除私有身份文件，凭证由插件管理。', parameters, output, execute: start }),
    defineTool({ name: 'arena_connect', description: '连接或恢复用户明确要求的 Model行动 游戏；与 arena_start 相同。按返回的 instructions 给用户配对指导，私密凭证不进入对话。若用户只反馈「配对码无效」，使用 arena_repair_pairing，不要读写身份文件。', parameters, output, execute: start }),
    defineTool({ name: 'arena_status', description: '检查 Model行动 插件是否已加载、当前配对/入场状态、预算和真实结果。直接使用此工具诊断，不需 Bash 翻源码或私有文件。返回 instructions 提供邀请码与配对码的分步说明、准确到期时间；不能凭未连接状态断言服务端已作废配对码。', parameters: {}, output,
      execute: (_args, exec) => { const agent = caller(exec.agent); return snapshot(states.get(agent)); } }),
    defineTool({ name: 'arena_repair_pairing', description: '修复本会话此前启动的 Model行动 配对。用户反馈「配对码无效」「重新配对」「刷新配对码」即可，无需重复游戏名。仅重新申请公开配对码、保留档案，不开始游戏、不恢复已停止的游玩循环；连接有效或已有对局时拒绝。不得用 Bash 删除身份文件。', parameters: {}, output, execute: repairPairing }),
    defineTool({ name: 'arena_stop', description: 'Stop this native arena loop. abandon=false stops decisions while the server character can remain alive; abandon=true explicitly requests surrender. Never claims terminal without server confirmation.', parameters: { abandon: { type: 'boolean' } }, output,
      execute: async (args, exec) => { const agent = caller(exec.agent); if (args.abandon !== undefined && typeof args.abandon !== 'boolean') fail('arena_invalid_entry'); return stop(states.get(agent), 'user_stop', { abandon: args.abandon === true, cancel: false }); } }),
  ];
  const disposers = definitions.map(def => ctx.tools.register(def));
  function waitForState(state, signal, duration) {
    return new Promise(resolve => {
      let timer; const finish = () => { clearTimeout(timer); state.waiters.delete(finish); signal.removeEventListener('abort', finish); resolve(); };
      state.waiters.add(finish); signal.addEventListener('abort', finish, { once: true });
      timer = setTimeout(finish, Math.max(1, Math.min(duration, 1000)));
      if (signal.aborted) finish();
    });
  }
  const listeners = [];
  listeners.push(ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const state = states.get(agent); if (!state?.armed) return;
    const generation = state.generation, runtime = state.runtime;
    if (signal.aborted) { await stop(state, 'user_stop', { cancel: false }); return; }
    // Keep the native activity alive while the user approves a pairing or the
    // room counts down. No extra model request is used to poll preparation.
    while (state.armed && state.generation === generation && !signal.aborted && runtime.state().entry_state !== 'in_world') {
      const view = runtime.state();
      if (view.entry_state === 'ended' || view.phase === 'error' || view.active === false) { await stop(state, view.entry_state === 'ended' ? 'server_terminal' : 'client_error', { cancel: false }); return; }
      const remaining = state.connectDeadline - clock();
      if (remaining <= 0) { await stop(state, 'time_limit', { cancel: false }); return; }
      await waitForState(state, signal, remaining);
    }
    if (!state.armed || state.generation !== generation || signal.aborted) { if (signal.aborted && state.generation === generation) await stop(state, 'user_stop', { cancel: false }); return; }
    if (state.activation) await state.activation;
    await runtime.refresh();
    if (state.armed && state.generation === generation && !signal.aborted) {
      await bridge(state);
      if (state.generation === generation) injectContinuation(state, 'continue');
    }
  }));
  listeners.push(ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;
    const agent = ctx.agents.get(session.id), state = states.get(agent);
    if (state?.terminalClosing) { state.terminalClosing = false; return removeScope(state); }
    if (event.data?.reason?.kind === 'completed') return;
    if (state?.armed) void stop(state, event.data?.reason?.kind === 'aborted' ? 'user_stop' : 'client_error', { cancel: false });
  }));
  listeners.push(ctx.on('agent/error', ({ agent }) => { const state = states.get(agent); if (state?.armed) void stop(state, 'client_error', { cancel: false }); }));
  async function disposeState(state) {
    await stop(state, 'user_stop', { forceRestoreScope: true });
    // A terminal stop may already be in flight with deferred scope restoration.
    await removeScope(state); await state.store.close(); states.delete(state.agent);
  }
  listeners.push(ctx.on('agent/disposed', ({ agent }) => { const state = states.get(agent); if (state) return disposeState(state); }));
  let disposal;
  const dispose = () => disposal ??= (async () => {
    disposed = true; for (const off of listeners) off();
    await Promise.allSettled([...states.values()].map(disposeState));
    for (const off of disposers) off();
    removeCredentialGuard();
  })();
  ctx.effect(() => dispose, 'model-action-native.lifecycle');
  return { dispose };
}

export async function apply(ctx, config = {}) {
  const [{ ArenaClient }, { AtomicStore }, { ArenaRuntime }, { defineTool }, { createMcpToolDefinition }, { createUserMessage }] = await Promise.all([
    import('./lib/client.js'), import('./lib/store.js'), import('./lib/runtime.js'),
    import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-mcp-client'), import('@deepseek-ai/dsh-llm'),
  ]);
  installArenaHost(ctx, config, { ArenaClient, AtomicStore, ArenaRuntime, defineTool, createMcpToolDefinition, createUserMessage });
}
