import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ArenaClient } from './lib/client.js';
import { ArenaRuntime } from './lib/runtime.js';
import { AtomicStore } from './lib/store.js';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const VERSION = '0.1.0';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = cause => /^[a-z][a-z0-9_]{0,63}$/.test(cause?.code ?? '') ? cause.code : 'client_error';
const result = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const emptySchema = { type: 'object', additionalProperties: false, properties: {} };
const entrySchema = { type: 'object', additionalProperties: false, properties: {
  mode_id: { type: 'string', enum: ['extraction', 'battle_royale'] },
  room_id: { type: ['string', 'null'], enum: [null, 'public-1', 'br-1', 'br-2', 'br-3'] },
  name: { type: 'string', minLength: 1, maxLength: 24 },
  loadout_id: { type: 'string', enum: ['rifle', 'smg', 'shotgun', 'armored'] },
} };
const controls = [
  { name: 'arena_start', description: '在用户明确要求开始 Model行动时调用。自动备赛与入场；首次返回公开配对码，请用户在游戏大厅批准。不要索取邀请码或令牌。', inputSchema: entrySchema },
  { name: 'arena_connect', description: 'arena_start 的连接/恢复别名，不会自行批准浏览器配对。', inputSchema: entrySchema },
  { name: 'arena_status', description: '查看公开配对码、入场状态和服务端结算。等待期间可轮询；入场后使用 game_ 工具持续决策。', inputSchema: emptySchema },
  { name: 'arena_stop', description: '停止本客户端的自动入场和轮询。abandon=true 请求真实放弃或退出候场；仅服务端确认后才报告终局。', inputSchema: { type: 'object', additionalProperties: false, properties: { abandon: { type: 'boolean', default: true } } } },
];
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_client_input');
}
function entry(value) {
  object(value, ['mode_id', 'room_id', 'name', 'loadout_id']);
  const mode = value.mode_id ?? 'extraction', room = value.room_id === undefined ? (mode === 'extraction' ? 'public-1' : null) : value.room_id;
  if (!['extraction', 'battle_royale'].includes(mode) || ![null, 'public-1', 'br-1', 'br-2', 'br-3'].includes(room) ||
      (mode === 'extraction' && room !== null && room !== 'public-1') || (mode === 'battle_royale' && room === 'public-1')) fail('invalid_client_input');
  if (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 24 || /[\u0000-\u001f\u007f]/.test(value.name))) fail('invalid_client_input');
  if (value.loadout_id !== undefined && !['rifle', 'smg', 'shotgun', 'armored'].includes(value.loadout_id)) fail('invalid_client_input');
  return { mode_id: mode, room_id: room, ...(value.name === undefined ? {} : { name: value.name }), ...(value.loadout_id === undefined ? {} : { loadout_id: value.loadout_id }) };
}

// Protocol adapter: runtime remains responsible for grants, visibility and terminal authority.
export function createModelActionServer(runtime, { serverUrl = 'https://xingying.dev' } = {}) {
  const server = new Server({ name: 'model-action', version: VERSION }, { capabilities: { tools: { listChanged: true } },
    instructions: 'Model行动：先在用户要求时调用 arena_start，向用户展示公开配对码与大厅链接。用户批准后以 arena_status 等待入场。进入 in_world 后持续使用 game_ 工具的真实规则与感知自行游玩，直到服务端明确 ended；总结不代表游戏结束。此 MCP 不创建模型循环，持续调用由宿主 Agent 负责。' });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let game = [];
    if (runtime.state().entry_state === 'in_world') {
      try { game = await runtime.listGameTools(); } catch { /* Keep status/stop available during transport recovery. */ }
    }
    return { tools: [...controls, ...game.map(tool => ({ ...tool, name: 'game_' + tool.name }))] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (name === 'arena_start' || name === 'arena_connect') {
        const selected = entry(args);
        if (!runtime.state().active && runtime.state().last_error?.status === 401 && runtime.client?.resetConnection) {
          try {
            await runtime.client.resetConnection();
            runtime.notify({ entry_state: null, current_attempt: null, connected: false, character_state: 'unknown' });
          } catch (cause) { if (cause?.code !== 'connection_active') throw cause; }
        }
        if (runtime.state().entry_state === 'ended') await runtime.stop('server_terminal', { abandon: false });
        const state = await runtime.start({ entry: selected, autoEnter: true });
        return result({ ...state, lobby_url: serverUrl + '/agent-arena/lobby/', next: state.entry_state === 'in_world' ? '使用 game_ 工具自主游玩直到服务端终局。' : '如有配对码，请在大厅审阅并批准；随后调用 arena_status 等待入场。' });
      }
      if (name === 'arena_status') {
        object(args, []);
        if (runtime.state().active) await runtime.refresh();
        return result(runtime.state());
      }
      if (name === 'arena_stop') {
        object(args, ['abandon']);
        if (args.abandon !== undefined && typeof args.abandon !== 'boolean') fail('invalid_client_input');
        return result(await runtime.stop('user_stop', { abandon: args.abandon ?? true }));
      }
      if (!/^game_[a-z][a-z0-9_]{0,63}$/.test(name)) fail('unknown_tool');
      return await runtime.callGame(name.slice(5), args, extra.signal);
    } catch (cause) { return result({ ok: false, error: { code: safeCode(cause) } }, true); }
  });
  return server;
}

export function createModelActionBridge({ serverUrl = 'https://xingying.dev', session = 'default', stateDir = path.join(os.homedir(), '.model-action', 'mcp') } = {}) {
  if (typeof session !== 'string' || !session.trim() || session.length > 120 || /[\u0000-\u001f\u007f]/.test(session)) fail('invalid_session');
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) fail('invalid_state_dir');
  // Validate the URL before touching private state. ArenaClient performs strict origin checks.
  const lifecycle = new AbortController();
  const client = new ArenaClient({ serverUrl, store: { read() {}, write() {} }, signal: lifecycle.signal });
  const file = path.join(stateDir, hash(client.serverUrl).slice(0, 24), hash(session).slice(0, 40) + '.json');
  const store = new AtomicStore(file); client.store = store;
  let server, connected = false, previousKey = null, closing;
  const notifyTools = state => {
    const key = [state.entry_state === 'in_world', state.current_attempt?.attempt_id].join(':');
    if (key === previousKey) return;
    previousKey = key;
    if (connected) void server.sendToolListChanged().catch(() => {});
  };
  const runtime = new ArenaRuntime({ client, label: 'Model行动 MCP · ' + session.slice(0, 30), version: VERSION, onState: notifyTools, onWake: () => { if (connected) void server.sendToolListChanged().catch(() => {}); } });
  server = createModelActionServer(runtime, { serverUrl: client.serverUrl });
  server.oninitialized = () => { connected = true; };
  const close = () => {
    if (closing) return closing;
    connected = false; lifecycle.abort(); client.cancelPending();
    closing = runtime.stop('user_stop', { abandon: false }).finally(() => store.close());
    return closing;
  };
  server.onclose = () => { void close().catch(() => {}); };
  return { server, runtime, close, stateFile: file };
}
