import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ArenaClient } from './lib/client.js';
import { ArenaRuntime } from './lib/runtime.js';
import { McpDialogue } from './lib/mcp-dialogue.js';
import { containsPrivateCredentials } from './lib/credential-guard.js';
import { AtomicStore } from './lib/store.js';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const VERSION = '0.2.3';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = cause => /^[a-z][a-z0-9_]{0,63}$/.test(cause?.code ?? '') ? cause.code : 'client_error';
const result = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const emptySchema = { type: 'object', additionalProperties: false, properties: {} };
const entrySchema = { type: 'object', additionalProperties: false, required: ['name','character_id','loadout_id','mode_id','room_id'], properties: {
  name: {type:'string',minLength:1,maxLength:24}, character_id: {type:'string',enum:['default','mimo','deepseek','qwen','kimi','glm']},
  loadout_id: {type:'string',enum:['rifle','smg','shotgun','armored']}, mode_id: {type:'string',enum:['extraction','battle_royale']},
  room_id: {type:['string','null'],enum:[null,'public-1','br-1','br-2','br-3']},
} };
const startSchema = {type:'object',additionalProperties:false,properties:{reuse_previous:{type:'boolean',description:'仅当用户新要求再来一局、且沿用已确认配置时为true；普通问答不设置。'}}};
const controls = [
  {name:'arena_start',description:'打开Model行动对话备战，复用有效资格；首次不会默认开局。缺少资格时请用户在对话提供邀请码。用户说再来一局且配置不变时设置reuse_previous:true直接沿用已确认配置入场，无需第二次确认。不要把普通问题、引用、停止或默认启动当成再玩请求。',inputSchema:startSchema},
  {name:'arena_connect',description:'与arena_start相同，在对话中连接资格和备战，不需要浏览器批准。',inputSchema:startSchema},
  {name:'arena_submit_invite',description:'用户在对话中提供邀请码或完整邀请链接后，将其放入invitation完成资格接入；仅单次邀请码经过宿主参数，不索取控制令牌或恢复密钥，不回显邀请码。省略时返回对话提示，不打开网页，也不使用表单采集凭证。',inputSchema:{type:'object',additionalProperties:false,properties:{invitation:{type:'string',minLength:1,maxLength:1000}}}},
  {name:'arena_prepare',description:'根据服务端选项核对完整昵称/模型少女形象/装备/模式/房间，生成本地方案摘要，不排队。只询问缺少或变更项，不展示内部确认ID。',inputSchema:entrySchema},
  {name:'arena_confirm',description:'确认当前方案并入场。支持原生非敏感表单时调用以展示方案确认；不支持时由宿主先取得用户自然同意再调用。MCP工具参数不证明真实用户来源，禁止模型自己同意。方案过期或变更需重新核对。',inputSchema:{type:'object',additionalProperties:false,required:['confirmation_id'],properties:{confirmation_id:{type:'string'}}}},
  {name:'arena_status',description:'查看对话阶段、已确认配置、入场状态和服务端终局；不会隐式配对或开局。in_world后持续使用game_工具直到ended。',inputSchema:emptySchema},
  {name:'arena_stop',description:'停止入场或游玩连接，取消待确认方案。abandon=true请求真实退出，只有服务端确认后才算终局；false仅停止决策，角色可能仍在场。',inputSchema:{type:'object',additionalProperties:false,properties:{abandon:{type:'boolean',default:true}}}},
];

// Protocol routing and capability negotiation only; dialogue owns entry state.
export function createModelActionServer(runtime, {serverUrl='https://xingying.dev',clock=Date.now}={}) {
  const server=new Server({name:'model-action',version:VERSION},{capabilities:{tools:{listChanged:true}},instructions:'Model行动全程在对话内入场，不需要网页配对。arena_start打开备战；用户提供邀请码后arena_submit_invite；核对完整配置后arena_prepare，再取得用户自然同意或通过宿主原生确认表单调用arena_confirm。用户要求再来一局时arena_start({reuse_previous:true})复用已确认配置，不反复询问。普通应答、问题、引用、停止不是新局授权。MCP没有宿主真实用户消息日志，宿主负责用户意图；工具参数不是真人证明。不要展示内部ID或复述邀请码，不索取长期凭证。in_world后持续使用真实game_工具直到服务端ended；不自动连开，持续模型调用由宿主Agent负责。'});
  const confirmationMode=()=>{const capability=server.getClientCapabilities()?.elicitation;return capability&&(Object.hasOwn(capability,'form')||!Object.hasOwn(capability,'url'))?'form':'host_dialogue';};
  const dialogue=new McpDialogue(runtime,{serverUrl,version:VERSION,clock,confirmationMode,confirm:async(summary,signal,requestId)=>{
    if(confirmationMode()!=='form')return undefined;
    // SDK 1.32.2's elicitInput incorrectly rejects legacy elicitation:{}.
    // request() is public SDK API and honors both legacy and form capabilities.
    const response=await server.request({method:'elicitation/create',params:{mode:'form',message:'请核对Model行动备战方案：'+summary,requestedSchema:{type:'object',required:['confirmed'],properties:{confirmed:{type:'boolean',title:'按此方案开始'}}}}},ElicitResultSchema,{signal,timeout:300000,relatedRequestId:requestId});
    return response.action==='accept'&&response.content?.confirmed===true;
  }});
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    let game=[];
    if(runtime.state().entry_state==='in_world'&&runtime.state().active){try{game=await runtime.listGameTools();}catch{}}
    return {tools:[...controls,...game.map(tool=>({...tool,name:'game_'+tool.name}))]};
  });
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    const {name,arguments:args={}}=request.params;
    try{
      let value;
      if(name==='arena_start'||name==='arena_connect')value=await dialogue.start(args,extra.signal);
      else if(name==='arena_submit_invite')value=await dialogue.submit(args,extra.signal);
      else if(name==='arena_prepare')value=await dialogue.prepare(args,extra.signal);
      else if(name==='arena_confirm')value=await dialogue.accept(args,extra.signal,extra.requestId);
      else if(name==='arena_status')value=await dialogue.status(args,extra.signal);
      else if(name==='arena_stop')value=await dialogue.stop(args);
      else{
        if(!/^game_[a-z][a-z0-9_]{0,63}$/.test(name))fail('unknown_tool');
        const game=await runtime.callGame(name.slice(5),args,extra.signal);
        if(containsPrivateCredentials(game))fail('private_output_blocked');
        return game;
      }
      if(containsPrivateCredentials(value))fail('private_output_blocked');
      return result(value);
    }catch(cause){return result({ok:false,error:{code:safeCode(cause)}},true);}
  });
  // The bridge uses this lifecycle without introducing non-standard MCP methods.
  return Object.assign(server,{modelActionDialogue:dialogue});
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
    const key = [state.entry_state === 'in_world' && state.active, state.current_attempt?.attempt_id].join(':');
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
    closing = server.modelActionDialogue.close().finally(() => store.close());
    return closing;
  };
  server.onclose = () => { void close().catch(() => {}); };
  return { server, runtime, close, stateFile: file };
}
