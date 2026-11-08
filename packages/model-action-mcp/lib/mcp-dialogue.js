// Transport-neutral conversation state for MCP. The MCP host owns user intent:
// tool arguments are not authenticated human-message evidence.
import { randomBytes } from 'node:crypto';
const fail = code => { throw Object.assign(new Error(code), {code}); };
const clone = value => structuredClone(value);
const fields = ['name','character_id','loadout_id','mode_id','room_id'];
const busyStates = new Set(['queued','offered','waiting','countdown','in_world']);
const safe = value => {
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:token|secret|receipt|proof|cookie|authorization|pairing|lobby_url)/i.test(key)).map(([key,item])=>[key,safe(item)]));
  return value ?? null;
};
export function validateObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key))) fail('invalid_client_input');
}
function catalogView(value) {
  const list = rows => Array.isArray(rows) ? rows.filter(v=>v&&typeof v.id==='string').map(v=>({id:v.id,name:typeof v.name==='string'?v.name:v.id,enabled:v.enabled!==false})) : [];
  const characters=list(value?.appearance?.character),loadouts=list(value?.loadouts);
  const modes=(value?.mode_ids??[]).filter(id=>['extraction','battle_royale'].includes(id)).map(id=>({id,name:id==='extraction'?'持久搜打撤':'大逃杀'}));
  if(!characters.length||!loadouts.length||!modes.length)fail('catalog_unavailable');
  return {catalog_revision:value.catalog_revision??null,characters,loadouts,modes,rooms:[{id:'public-1',mode_id:'extraction',name:'公开持久房'},...[1,2,3].map(n=>({id:'br-'+n,mode_id:'battle_royale',name:'大逃杀 '+n+' 号房'}))]};
}
function entry(value,catalog) {
  validateObject(value,fields);
  if(fields.some(key=>!Object.hasOwn(value,key)))fail('configuration_incomplete');
  const {name,character_id,loadout_id,mode_id,room_id}=value;
  if(typeof name!=='string'||!name.trim()||name.length>24||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name))fail('invalid_client_input');
  if(!catalog.characters.some(v=>v.id===character_id&&v.enabled)||!catalog.loadouts.some(v=>v.id===loadout_id&&v.enabled)||!catalog.modes.some(v=>v.id===mode_id)||
    !(mode_id==='battle_royale'&&room_id===null)&&!catalog.rooms.some(v=>v.id===room_id&&v.mode_id===mode_id))fail('invalid_client_input');
  return {name:name.trim(),character_id,loadout_id,mode_id,room_id};
}
function summary(value,catalog,previous) {
  const labels={name:'昵称',character_id:'形象',loadout_id:'装备',mode_id:'模式',room_id:'房间'};
  const name=(key,id)=>key==='name'?id:key==='room_id'&&id===null?'自动匹配大逃杀房间':(catalog[{character_id:'characters',loadout_id:'loadouts',mode_id:'modes',room_id:'rooms'}[key]].find(v=>v.id===id)?.name??id);
  const changed=previous?fields.filter(key=>previous[key]!==value[key]):fields;
  if(!changed.length)return '沿用已确认配置，无变更。';
  return (previous?'变更：':'')+changed.map(key=>labels[key]+'：'+name(key,value[key])).join('；')+'。';
}
export class McpDialogue {
  constructor(runtime,{serverUrl,version,clock=Date.now,confirm,confirmationMode=()=> 'host_dialogue'}={}) {
    this.runtime=runtime;this.client=runtime.client;this.serverUrl=serverUrl;this.version=version;this.clock=clock;this.confirmForm=confirm;this.confirmationMode=confirmationMode;
    this.phase='idle';this.connected=false;this.catalog=null;this.preferences=null;this.confirmed=null;this.proposal=null;this.lastConfirmation=null;
    this.generation=0;this.pending=new Set();this.chain=Promise.resolve();this.closed=false;this.session=null;
  }
  view() {
    const runtime=this.runtime.state();
    const phase=runtime.active?runtime.phase:runtime.entry_state==='ended'&&['starting','in_world'].includes(this.phase)?'ended':this.phase;
    const instructions={
      idle:'用户想玩时调用 arena_start 打开对话备战；不要要求固定开局口令。',
      awaiting_ticket:'请用户在对话中提供邀请码或完整邀请链接，再调用 arena_submit_invite。不会生成网页配对码，不需要打开网页；不要复述邀请码。',
      configuring:'核对昵称、形象、装备、模式和房间；已有配置只询问变更项，调用 arena_prepare 展示简短方案。用户要求再来一局且配置不变时，调用 arena_start({reuse_previous:true})。',
      awaiting_confirmation:'向用户展示方案。支持原生确认表单的宿主可调用 arena_confirm 展示表单；其他宿主先取得用户自然同意再调用。不要展示内部确认ID，不要求固定措辞。',
      existing_game:'此身份已有正在进行或候场的对局，未重排。可用 arena_stop({abandon:true})明确退出后再准备；不能把停止决策当作退出成功。',
      stopped:'已停止自动入场与决策连接；是否真正退出以服务端状态为准。用户再次要求游玩后才调用 arena_start。',
      ended:'服务器已确认终局，只报告真实结果。等用户要求再来一局，再调用 arena_start({reuse_previous:true})，不重复确认原配置，不自动连开。',
      starting:'配置已确认，自动备赛、排队与入场；持续使用真实 game_ 工具直到服务端终局。',
    };
    const confirmationMode=this.confirmationMode();
    if(phase==='awaiting_confirmation')instructions.awaiting_confirmation=confirmationMode==='form'?'调用 arena_confirm 展示这份非敏感方案的原生确认表单，一次确认即可，不要先在聊天再索要一次确认。':'向用户展示方案，取得自然语言同意后调用 arena_confirm；由宿主负责真实用户意图，不要求固定措辞，也不展示内部确认ID。';
    return safe({...runtime,phase,confirmation_mode:confirmationMode,onboarding_mode:'conversation',plugin_loaded:true,plugin_name:'model-action-mcp',game_name:'Model行动',server_url:this.serverUrl,browser_required:false,connected:this.connected,
      ...(this.session&&!runtime.active?{entry_state:['configuring','awaiting_confirmation','awaiting_ticket'].includes(phase)?null:this.session.state,current_attempt:['configuring','awaiting_confirmation','awaiting_ticket'].includes(phase)?null:this.session.attempt??null,result:['configuring','awaiting_confirmation','awaiting_ticket'].includes(phase)?null:this.session.result??runtime.result,...(this.session.result?{previous_result:this.session.result}:{})}:{}),
      dialogue:{phase,preferences:this.preferences,confirmed_entry:this.confirmed,draft:this.proposal?.entry??null,summary:this.proposal?.summary??null,confirmation_id:this.proposal?.id??null,confirmation_expires_at_ms:this.proposal?.expires??null,...(['configuring','awaiting_confirmation'].includes(phase)?{options:this.catalog}:{})},
      human_consent:'由MCP宿主根据真实用户对话决定何时调用确认或续局工具；工具参数不证明真人来源。',
      instructions:[instructions[phase]??'使用 arena_status 查看权威状态；入场后持续调用 game_ 工具直到 ended。',
        ...(runtime.entry_state==='in_world'&&this.runtime.gameplayHint?.()?[this.runtime.gameplayHint().replace('调用 step','调用 game_step')]:[])]});
  }
  run(fn,signal) {
    const controller=new AbortController(),generation=this.generation;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
    this.pending.add(controller);
    const check=()=>{if(this.closed||controller.signal.aborted||this.generation!==generation)fail('request_cancelled');};
    const task=this.chain.then(async()=>{if(this.stopFlight)await this.stopFlight.catch(()=>{});check();return fn(check,controller.signal);}).catch(cause=>{if(controller.signal.aborted||this.generation!==generation)fail('request_cancelled');throw cause;});
    this.chain=task.catch(()=>{});
    return task.finally(()=>{this.pending.delete(controller);signal?.removeEventListener('abort',abort);});
  }
  async access(check,ticket) {
    const connected=await this.client.connectNative({...(ticket===undefined?{}:{ticket}),label:'Model行动 MCP',version:this.version});check();
    this.session=connected.session;this.connected=true;
    this.catalog=catalogView(await this.client.catalog());check();
    const local=await this.client.publicState();check();this.preferences=local.entry_preferences??null;this.confirmed=null;
    if(local.confirmed_entry){try{this.confirmed=entry(local.confirmed_entry,this.catalog);}catch{}}
    this.phase=busyStates.has(this.session?.state)?'existing_game':'configuring';
  }
  supersedeProposal() {
    if(!this.proposal)return;
    this.generation++;for(const controller of this.pending)controller.abort();this.client.cancelPending?.();this.proposal=null;
  }
  start(args,signal) {
    validateObject(args,['reuse_previous']);if(args.reuse_previous!==undefined&&typeof args.reuse_previous!=='boolean')fail('invalid_client_input');
    this.supersedeProposal();
    return this.run(async(check,pendingSignal)=>{
      if(this.runtime.state().active){await this.runtime.refresh();check();}
      if(this.runtime.state().entry_state==='ended'&&this.runtime.state().active){await this.runtime.stop('server_terminal',{abandon:false});check();}
      if(this.runtime.state().active)return this.view();
      this.proposal=null;
      try{await this.access(check);}catch(error){if(['invite_required','native_access_required'].includes(error.code)){this.phase='awaiting_ticket';this.connected=false;return this.view();}throw error;}
      if(args.reuse_previous===true){if(this.phase==='existing_game')return this.view();if(!this.confirmed)fail('confirmed_configuration_required');await this.launch(this.confirmed,check,pendingSignal);}
      return this.view();
    },signal);
  }
  submit(args,signal) {
    validateObject(args,['invitation']);
    if(args.invitation!==undefined&&(typeof args.invitation!=='string'||!args.invitation.trim()||args.invitation.length>1000))fail('invalid_invite_input');
    this.supersedeProposal();
    return this.run(async check=>{
      if(this.runtime.state().active||this.phase==='existing_game')fail('game_already_running');
      if(args.invitation===undefined){this.phase='awaiting_ticket';return this.view();}
      this.proposal=null;await this.access(check,args.invitation);return this.view();
    },signal);
  }
  prepare(args,signal) {
    this.supersedeProposal();
    return this.run(async check=>{
      if(this.runtime.state().active||this.phase==='existing_game')fail('game_already_running');
      if(!this.connected)fail('access_required');
      const catalog=catalogView(await this.client.catalog());check();const selected=entry(args,catalog);
      this.catalog=catalog;this.lastConfirmation=null;
      this.proposal={id:randomBytes(32).toString('hex'),entry:selected,summary:summary(selected,catalog,this.confirmed),catalogRevision:catalog.catalog_revision,expires:this.clock()+300000};
      this.phase='awaiting_confirmation';return this.view();
    },signal);
  }
  accept(args,signal,requestId) {
    validateObject(args,['confirmation_id']);if(typeof args.confirmation_id!=='string')fail('invalid_confirmation');
    return this.run(async(check,pendingSignal)=>{
      if(this.lastConfirmation===args.confirmation_id)return this.view();
      const proposal=this.proposal;
      if(!proposal||proposal.id!==args.confirmation_id||proposal.expires<=this.clock())fail('confirmation_stale');
      if(this.runtime.state().active||this.phase==='existing_game')fail('game_already_running');
      if(this.confirmForm){const reply=await this.confirmForm(proposal.summary,pendingSignal,requestId);check();if(reply===false){this.proposal=null;this.phase='configuring';return this.view();}}
      const catalog=catalogView(await this.client.catalog());check();
      if(this.proposal!==proposal||proposal.expires<=this.clock()||catalog.catalog_revision!==proposal.catalogRevision)fail('confirmation_stale');
      const selected=entry(proposal.entry,catalog);
      await this.launch(selected,check,pendingSignal);this.lastConfirmation=proposal.id;this.proposal=null;return this.view();
    },signal);
  }
  async launch(selected,check,signal) {
    check();
    // Reconcile the authoritative session immediately before changing entry.
    const session=await this.client.session();check();this.session=session;
    if(busyStates.has(session.state)){this.phase='existing_game';fail('game_already_running');}
    await this.client.rememberConfirmedEntry(selected);check();
    this.confirmed=clone(selected);this.preferences=clone(selected);this.phase='starting';
    const owner=Symbol('MCP entry');this.launchOwner=owner;let stopping;
    const cancel=()=>{if(this.launchOwner===owner)stopping=this.runtime.stop('user_stop',{abandon:false}).catch(()=>{});};
    signal?.addEventListener('abort',cancel,{once:true});
    try{check();await this.runtime.start({entry:selected,autoEnter:true});check();}
    finally{signal?.removeEventListener('abort',cancel);if(stopping)await stopping;if(this.launchOwner===owner)this.launchOwner=null;}
  }
  status(args,signal) {
    validateObject(args,[]);
    return this.run(async check=>{
      if(this.runtime.state().active){await this.runtime.refresh();if(this.runtime.state().entry_state==='ended'){await this.runtime.stop('server_terminal',{abandon:false});this.phase='ended';this.session=await this.client.session();}}
      else if(this.connected){this.session=await this.client.session();if(this.session.state==='ended'&&['starting','in_world','existing_game'].includes(this.phase))this.phase='ended';}
      check();return this.view();
    },signal);
  }
  stop(args={}) {
    validateObject(args,['abandon']);if(args.abandon!==undefined&&typeof args.abandon!=='boolean')fail('invalid_client_input');
    if(this.stopFlight)return this.stopFlight;
    const flight=this.performStop(args).finally(()=>{if(this.stopFlight===flight)this.stopFlight=null;});this.stopFlight=flight;return flight;
  }
  async performStop(args) {
    this.generation++;for(const controller of this.pending)controller.abort();this.client.cancelPending?.();
    this.proposal=null;this.lastConfirmation=null;this.phase='stopped';
    const abandon=args.abandon??true;
    if(abandon&&!this.runtime.state().active&&this.connected){
      const current=await this.client.session();this.session=current;
      if(['queued','offered','waiting','countdown'].includes(current.state)){
        const withdrawn=await this.client.withdrawEntry();this.session=withdrawn;
        if(!['preparing','ready','ended'].includes(withdrawn.state))fail('exit_unconfirmed');
        const id=current.attempt?.id??current.attempt?.attempt_id;
        if(id)await this.client.clearAttempt(id);
        const stopped=await this.runtime.stop('user_stop',{abandon:false});
        return safe({...stopped,reservation_state:'released',exit_confirmed:true});
      }
      if(current.state==='in_world')await this.runtime.start({autoEnter:false});
    }
    const stopped=await this.runtime.stop('user_stop',{abandon});
    if(this.connected){try{this.session=await this.client.session();}catch{}}
    return safe(stopped);
  }
  async close() {
    this.closed=true;this.generation++;for(const controller of this.pending)controller.abort();this.client.cancelPending?.();
    await this.runtime.stop('user_stop',{abandon:false});await this.chain.catch(()=>{});
  }
}
