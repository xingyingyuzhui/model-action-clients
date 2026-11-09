// Context-neutral lifecycle coordination. Native dsh owns model turns, followup
// and budgets; this module never spawns models, approves pairings or uses cookies.
const locks = new WeakMap();
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const GAME_PATHS = new Set(['/mcp','/agent-game/mcp']);
const error = (code,status=null,retryable=false) => Object.assign(new Error(code),{code,status,retryable});
const safeError = cause => error(SAFE_CODE.test(cause?.code??'')?cause.code:'network_error',Number.isInteger(cause?.status)?cause.status:null,!!cause?.retryable);
const clone = value => structuredClone(value);
const terminalLoopReasons = new Set(['user_stop','time_limit','budget_limit','client_error']);

function abortRace(promise,signal) {
  if(signal?.aborted)return Promise.reject(error('request_cancelled'));
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(error('request_cancelled'));};
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},cause=>{cleanup();reject(cause);});
  });
}
function signalController(signals,timeoutMs) {
  const controller=new AbortController(),removers=[];let timedOut=false;
  for(const signal of signals.filter(Boolean)){
    const abort=()=>controller.abort();
    if(signal.aborted)controller.abort();else{signal.addEventListener('abort',abort,{once:true});removers.push(()=>signal.removeEventListener('abort',abort));}
  }
  const timeout=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);timeout.unref?.();
  return {signal:controller.signal,timedOut:()=>timedOut,dispose:()=>{clearTimeout(timeout);for(const remove of removers)remove();}};
}
function gameUrl(value,origin) {
  let url,base;
  try{url=new URL(value);base=new URL(origin);}catch{throw error('unsafe_mcp_url');}
  if(url.origin!==base.origin||url.username||url.password||url.search||url.hash||!GAME_PATHS.has(url.pathname))throw error('unsafe_mcp_url');
  return url.href;
}
function publicAttempt(attempt) {
  return attempt?{attempt_id:attempt.id??attempt.attempt_id,room_id:attempt.room_id??null,mode_id:attempt.mode_id??null,
    match_id:attempt.match_id??null,state:attempt.state??null,client_ready:!!attempt.client_ready}:null;
}
function toolData(result) {
  if(result?.isError)return null;
  const text=result?.content?.find(value=>value.type==='text')?.text;
  if(typeof text!=='string')return null;
  try{return JSON.parse(text);}catch{return null;}
}

// Gameplay advice for the model. Only parameters the server's own step schema
// declares are suggested, so an older server never receives unknown fields.
export const EARLY_RETURN_TIP='调用 step 时建议 hold_ms 设为 1000，同时带 return_after_ms 300~500：观察会提前返回，按键继续生效，角色边走你边想下一步，不会原地停顿。世界不会等你，决策越快、越简短，拿到的信息越新；每一步以最新观察为准，不必回顾很早以前的观察。';
export function supportsEarlyReturn(tools){return Array.isArray(tools)&&tools.some(tool=>tool?.name==='step'&&!!tool.inputSchema?.properties?.return_after_ms);}

export class ArenaRuntime {
  constructor({client,transport,onWake=()=>{},onTerminal=()=>{},onState=()=>{},clock=Date.now,
    heartbeatMs=5000,pollMs=2000,maxBackoffMs=30000,gameTimeoutMs=70000,
    label='Model行动 client',version='0.2.9',model,fetcher=globalThis.fetch}={}) {
    if(!client||typeof client.session!=='function'||typeof client.publicState!=='function'||
      [onWake,onTerminal,onState,clock].some(fn=>typeof fn!=='function')||
      [heartbeatMs,pollMs,maxBackoffMs,gameTimeoutMs].some(n=>!Number.isSafeInteger(n)||n<1)||
      (transport!==undefined&&typeof transport!=='function'))throw error('invalid_runtime_config');
    this.client=client;this.transport=transport??(args=>this.httpTransport(args));this.fetcher=fetcher;
    this.onWake=onWake;this.onTerminal=onTerminal;this.onState=onState;this.clock=clock;
    Object.assign(this,{heartbeatMs,pollMs,maxBackoffMs,gameTimeoutMs,label,version,model});
    this.active=false;this.timer=null;this.flight=null;this.wakePending=null;this.stopFlight=null;this.rpcId=0;
    this.entered=new Set();this.terminals=new Set();this.terminalFlights=new Map();this.claimed=new Set();this.profileClaimed=new Set();this.secrets=new Set();this.tools=null;
    this.sessionValue=null;this.nextHeartbeat=0;this.nextPoll=0;this.failures=0;this.gameSuspended=false;
    this.view={phase:'idle',active:false,connected:false,pairing:null,current_attempt:null,last_error:null,
      loop:{state:'idle',reason:null},entry_state:null,character_state:'unknown',result:null};
  }
  state(){return clone(this.view);}
  notify(patch={}) {
    this.view={...this.view,...patch,active:this.active};
    try{Promise.resolve(this.onState(this.state())).catch(()=>{});}catch{}
  }
  redact(value) {
    const raw=JSON.stringify(value);
    if(raw===undefined)return null;
    let result=raw;
    for(const token of this.secrets)if(token)result=result.split(token).join('[redacted]');
    return JSON.parse(result);
  }
  async clientCall(method,...args) {
    if(!this.active)throw error('request_cancelled');
    const value=await abortRace(Promise.resolve().then(()=>this.client[method](...args)),this.lifecycle.signal);
    if(!this.active)throw error('request_cancelled');
    return value;
  }
  async start({entry={mode_id:'extraction',room_id:'public-1'},autoEnter=false,model}={}) {
    if(this.repairFlight)throw error('pairing_repair_in_progress');
    if(this.active)return this.state();
    if(this.stopFlight)await this.stopFlight;
    const owner=locks.get(this.client);if(owner&&owner!==this)throw error('runtime_already_running');
    if(typeof autoEnter!=='boolean'||!entry||typeof entry!=='object'||Array.isArray(entry))throw error('invalid_runtime_config');
    this.entry=clone(entry);this.autoEnter=autoEnter;this.entryIntent={prepared:false,queued:false,sawAttempt:false};this.startPreparePending=autoEnter;if(model!==undefined)this.model=model;
    this.lifecycle=new AbortController();this.gameController=new AbortController();this.active=true;locks.set(this.client,this);
    this.nextHeartbeat=0;this.nextPoll=0;this.failures=0;this.gameSuspended=false;
    this.entered.clear();this.claimed.clear();this.tools=null;
    this.notify({phase:'connecting',last_error:null,loop:{state:'waiting',reason:null},result:null});
    await this.refresh();return this.state();
  }
  schedule(delay) {
    clearTimeout(this.timer);this.timer=null;if(!this.active)return;
    this.timer=setTimeout(()=>{this.timer=null;void this.refresh();},Math.max(1,delay));this.timer.unref?.();
  }
  async refresh() {
    if(!this.active)return this.state();
    if(this.flight)return this.flight;
    this.flight=this.cycle().catch(cause=>this.failed(cause)).finally(()=>{this.flight=null;});
    return this.flight;
  }
  async cycle() {
    const local=await this.clientCall('publicState');
    this.notify({connected:!!local.connected,pairing:local.pairing?{
      user_code:local.pairing.user_code,expires_at_ms:local.pairing.expires_at_ms,poll_interval_ms:local.pairing.poll_interval_ms}:null});
    if(!local.connected){
      if(!local.pairing||local.pairing.expires_at_ms<=this.clock()){
        const pair=await this.clientCall('pairInit',{label:this.label,version:this.version});
        this.notify({phase:'pairing',pairing:{user_code:pair.user_code,expires_at_ms:pair.expires_at_ms,poll_interval_ms:pair.poll_interval_ms}});
      }else{
        const pair=await this.clientCall('pairPoll');
        this.notify({phase:'pairing'});
        if(pair.state==='connected')return this.connectedCycle();
        if(pair.state==='cancelled')throw error('pairing_cancelled');
      }
      this.schedule(this.pollMs);return this.state();
    }
    return this.connectedCycle();
  }
  async connectedCycle() {
    const recovering=this.view.phase==='backoff';
    let session;
    if(this.clock()>=this.nextHeartbeat){
      session=await this.clientCall('heartbeat',this.view.loop);this.nextHeartbeat=this.clock()+this.heartbeatMs;
    }else session=await this.clientCall('session');
    this.nextPoll=this.clock()+this.pollMs;
    await this.reconcile(session);
    if(recovering&&this.view.entry_state==='in_world')this.wake('continue');
    this.failures=0;
    if(this.active)this.schedule(Math.min(this.pollMs,Math.max(1,this.nextHeartbeat-this.clock())));
    return this.state();
  }
  updateSession(session) {
    this.sessionValue=session;
    const state=session?.state,attempt=publicAttempt(session?.attempt);
    this.notify({phase:this.gameSuspended&&state==='in_world'?'error':state,entry_state:state,connected:session?.connection?.state==='connected',current_attempt:attempt,
      character_state:state==='in_world'?'still_in_world':state==='ended'?'ended':'not_in_world',last_error:this.gameSuspended?this.view.last_error:null,
      loop:{state:this.gameSuspended&&state==='in_world'?'error':state==='in_world'?'running':state==='ended'?'stopped':'waiting',reason:this.gameSuspended&&state==='in_world'?'client_error':null}});
  }
  async reconcile(session) {
    if(!session||typeof session.state!=='string')throw error('invalid_response');
    this.updateSession(session);
    this.observeEntryIntent(session);
    if(this.autoEnter&&this.startPreparePending&&['preparing','ready','ended'].includes(session.state)){
      // Complete the confirmed preparation before queueing, including a pending
      // retry or a previous ready configuration. A terminal found later cannot
      // authorize another game.
      if(session.state==='ended'&&session.attempt?.id){await this.clientCall('clearAttempt',session.attempt.id);this.terminals.add(session.attempt.id);}
      session=await this.clientCall('prepareEntry',this.entry);this.entryIntent.prepared=true;this.updateSession(session);this.observeEntryIntent(session);
      this.startPreparePending=false;
    }else if(!['preparing','ready','ended'].includes(session.state))this.startPreparePending=false;
    // Each awaited mutation reconciles before another action. stop() aborts this
    // chain, so a late HTTP response cannot continue into an entry operation.
    if(session.state==='ended'){
      const result=session.result??(await this.clientCall('result')).result;
      if(!result)throw error('result_unavailable');
      await this.finishTerminal(session.attempt?.id??result.attempt_id,result);return;
    }
    if(session.public_agent_id)await this.ensureProfile(session.public_agent_id);
    if(session.state==='preparing'&&this.autoEnter){
      session=await this.clientCall('prepareEntry',this.entry);this.entryIntent.prepared=true;this.updateSession(session);this.observeEntryIntent(session);
      if(session.public_agent_id)await this.ensureProfile(session.public_agent_id);
    }
    if(session.state==='ready'&&this.autoEnter){session=await this.clientCall('queueEntry');this.entryIntent.queued=true;this.updateSession(session);this.observeEntryIntent(session);}
    if(session.state==='offered'&&this.autoEnter){
      const offerId=session.offer?.id??session.attempt?.offer_id;if(!offerId)throw error('invalid_response');
      session=await this.clientCall('acceptOffer',offerId);this.updateSession(session);this.observeEntryIntent(session);
    }
    const attempt=session.attempt,id=attempt?.id;
    if(!['waiting','countdown','in_world'].includes(session.state)||!id)return;
    if(!this.claimed.has(id)){
      await this.clientCall('claimAttempt',{attemptId:id,...(this.model===undefined?{}:{model:this.model})});this.claimed.add(id);
    }
    // Countdown cancellation resets worker readiness: repeat when the next
    // authoritative waiting DTO has client_ready=false, not only once per ID.
    if(session.state==='waiting'&&!attempt.client_ready){
      session=await this.clientCall('readyAttempt',id);this.updateSession(session);
    }
    if(session.state==='in_world'&&!this.entered.has(id)&&!this.gameSuspended){
      this.entered.add(id);this.wake('entered');
    }
  }
  observeEntryIntent(session) {
    if(!this.autoEnter)return;
    const intent=this.entryIntent;
    if(session.attempt&&session.state!=='ended')intent.sawAttempt=true;
    if(!session.attempt&&['preparing','ready'].includes(session.state)&&
      (intent.queued||intent.sawAttempt||(intent.prepared&&session.state==='preparing'))){
      this.autoEnter=false;throw error('entry_cancelled',409);
    }
  }
  wake(reason='continue') {
    if(!this.active||this.gameSuspended||this.view.entry_state!=='in_world'||!this.view.current_attempt?.attempt_id||this.wakePending)return false;
    const payload={...this.view.current_attempt,reason:reason==='entered'?'entered':'continue'};
    this.wakePending=Promise.resolve().then(()=>{
      if(!this.active||this.gameSuspended||this.view.entry_state!=='in_world')return;
      return this.onWake(clone(payload));
    }).catch(()=>{this.notify({last_error:{code:'wake_failed',retryable:false}});}).finally(()=>{this.wakePending=null;});
    return true;
  }
  reportLoop(loop) {
    if(!loop||!['idle','running','waiting','stopped','error'].includes(loop.state)||
      (loop.reason!=null&&!terminalLoopReasons.has(loop.reason)))throw error('invalid_loop_state');
    this.notify({loop:{state:loop.state,reason:loop.reason??null}});
  }
  async ensureProfile(id) {
    if(this.profileClaimed.has(id))return;
    const result=await this.clientCall('claimProfile');if(result.state==='saved')this.profileClaimed.add(id);
  }
  async finishTerminal(attemptId,result) {
    if(!attemptId||this.terminals.has(attemptId))return;
    if(this.terminalFlights.has(attemptId))return this.terminalFlights.get(attemptId);
    const flight=this.completeTerminal(attemptId,result).finally(()=>this.terminalFlights.delete(attemptId));
    this.terminalFlights.set(attemptId,flight);return flight;
  }
  async completeTerminal(attemptId,result) {
    this.gameController?.abort();this.gameSuspended=true;this.autoEnter=false;
    await this.client.clearAttempt(attemptId);
    this.claimed.delete(attemptId);this.terminals.add(attemptId);this.tools=null;
    const safe=this.redact(result);
    this.notify({phase:'ended',entry_state:'ended',character_state:'ended',result:safe,loop:{state:'stopped',reason:null}});
    try{await this.onTerminal({attempt_id:attemptId,result:clone(safe)});}catch{this.notify({last_error:{code:'terminal_callback_failed',retryable:false}});}
  }
  async failed(cause) {
    const err=safeError(cause);
    if(!this.active||err.code==='request_cancelled')return this.state();
    const fatal=[400,401,403,404,422].includes(err.status)||['entry_cancelled','invalid_client_input','pairing_cancelled','pairing_required','store_corrupt','store_locked','store_permissions','store_origin_mismatch','profile_not_saved','grant_consumed','unsafe_mcp_url','unsupported_schema'].includes(err.code);
    if(fatal){
      this.active=false;clearTimeout(this.timer);this.lifecycle.abort();this.gameController.abort();
      if(locks.get(this.client)===this)locks.delete(this.client);
      this.notify({phase:'error',last_error:{code:err.code,status:err.status,retryable:false},loop:{state:'error',reason:'client_error'}});
    }else{
      const wait=Math.min(this.maxBackoffMs,this.pollMs*2**Math.min(this.failures++,10));
      this.notify({phase:'backoff',last_error:{code:err.code,status:err.status,retryable:true}});this.schedule(wait);
    }
    return this.state();
  }
  async httpTransport({url,token,method,params,signal,id}) {
    let response;
    try{response=await this.fetcher(url,{method:'POST',redirect:'error',credentials:'omit',signal,
      headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token},
      body:JSON.stringify({jsonrpc:'2.0',id,method,params})});}
    catch{throw error(signal.aborted?'request_cancelled':'network_error',null,!signal.aborted);}
    if(response.redirected||(response.url&&response.url!==url))throw error('unexpected_redirect');
    const raw=await response.text();if(Buffer.byteLength(raw)>1024*1024)throw error('response_too_large');
    let body;try{body=JSON.parse(raw);}catch{throw error('invalid_mcp_response',response.status);}
    if(!response.ok)throw error(response.status===401?'game_unauthorized':'mcp_http_error',response.status,[429,503].includes(response.status));
    if(body.error)throw error(body.error.code===-32001?'game_unauthorized':'mcp_rpc_error',body.error.code===-32001?401:null);
    if(!body.result||typeof body.result!=='object')throw error('invalid_mcp_response');return body.result;
  }
  async rpc(method,params,signal,{stopping=false}={}) {
    const attemptId=this.view.current_attempt?.attempt_id;if(!attemptId)throw error('attempt_not_ready');
    if(!stopping&&(!this.active||this.gameSuspended))throw error('runtime_stopped');
    const credentials=await this.client.attemptCredentials(attemptId);
    if(!stopping&&(!this.active||this.gameSuspended))throw error('runtime_stopped');
    const url=gameUrl(credentials.mcp_url,this.client.serverUrl);this.secrets.add(credentials.game_token);
    const control=signalController([signal,...(stopping?[]:[this.gameController.signal,this.lifecycle.signal])],stopping?Math.min(10000,this.gameTimeoutMs):this.gameTimeoutMs);
    try{return this.redact(await abortRace(this.transport({url,token:credentials.game_token,method,params,signal:control.signal,id:++this.rpcId}),control.signal));}
    catch(cause){if(control.timedOut())throw error('game_timeout',null,true);throw safeError(cause);}
    finally{control.dispose();}
  }
  async listGameTools({signal}={}) {
    if(!this.active||!this.view.current_attempt?.attempt_id||!['waiting','countdown','in_world'].includes(this.view.entry_state))return [];
    if(this.toolsFlight)return clone(await this.toolsFlight);
    if(!this.tools){
      this.toolsFlight=(async()=>{
      const result=await this.rpc('tools/list',{},signal);
      if(!Array.isArray(result.tools)||result.tools.length>100)throw error('invalid_mcp_response');
      this.tools=result.tools.filter(tool=>typeof tool.name==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(tool.name))
        .map(tool=>({name:tool.name,description:typeof tool.description==='string'?tool.description:'',inputSchema:clone(tool.inputSchema??{type:'object',properties:{}})}));return this.tools;
      })();
      try{return clone(await this.toolsFlight);}finally{this.toolsFlight=null;}
    }
    return clone(this.tools);
  }
  gameplayHint(){return supportsEarlyReturn(this.tools)?EARLY_RETURN_TIP:null;}
  async callGame(name,args={},signal) {
    if(this.view.entry_state!=='in_world')throw error('attempt_not_in_world');
    if(typeof name!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(name)||!args||typeof args!=='object'||Array.isArray(args))throw error('invalid_tool_call');
    try{
      const tools=await this.listGameTools({signal});if(!tools.some(tool=>tool.name===name))throw error('unknown_game_tool');
      return await this.rpc('tools/call',{name,arguments:args},signal);
    }catch(cause){
      const err=safeError(cause);
      if(err.status===401){
        // A game 401 is never a win/loss. Consult the independent control lease.
        await this.refresh();
        if(this.view.entry_state!=='ended'){
          this.gameSuspended=true;this.gameController.abort();
          this.notify({phase:'error',last_error:{code:'game_unauthorized',status:401,retryable:false},loop:{state:'error',reason:'client_error'}});
        }
      }
      throw err;
    }
  }
  repairPairing() {
    if(this.repairFlight)return this.repairFlight;
    if(this.entered.size || this.view.current_attempt || ![null,'preparing'].includes(this.view.entry_state) || typeof this.client.repairPairing!=='function')return Promise.reject(error('pairing_repair_not_safe'));
    this.repairFlight=this.performPairingRepair().finally(()=>{this.repairFlight=null;});
    return this.repairFlight;
  }
  async performPairingRepair() {
    this.autoEnter=false;this.startPreparePending=false;
    await this.stop('user_stop',{abandon:false});
    // Cancelling the lifecycle releases abortRace immediately; wait for the old
    // poll reconciliation too, so it cannot publish its old state after repair.
    if(this.flight)await this.flight;
    if(this.entered.size || this.view.current_attempt || ![null,'preparing'].includes(this.view.entry_state))throw error('pairing_repair_not_safe');
    try {
      const pairing=await this.client.repairPairing({label:this.label,version:this.version});
      this.notify({phase:'pairing',active:false,connected:false,pairing:{user_code:pairing.user_code,expires_at_ms:pairing.expires_at_ms,poll_interval_ms:pairing.poll_interval_ms},
        entry_state:null,current_attempt:null,character_state:'not_in_world',last_error:null,result:null,
        loop:{state:'stopped',reason:'user_stop'},repair:{state:'pending',requires_explicit_start:true}});
      return this.state();
    } catch(cause) {
      const err=safeError(cause);this.notify({last_error:{code:err.code,status:err.status,retryable:err.retryable}});throw err;
    }
  }
  stop(reason='user_stop',{abandon=false}={}) {
    if(this.stopFlight)return this.stopFlight;
    this.stopFlight=this.performStop(reason,{abandon}).finally(()=>{this.stopFlight=null;});return this.stopFlight;
  }
  async performStop(reason,{abandon}) {
    const lastState=this.view.entry_state;
    this.active=false;clearTimeout(this.timer);this.timer=null;this.lifecycle?.abort();this.gameController?.abort();
    this.client.cancelPending?.();
    let confirmed=false;
    try{const current=await this.client.session();this.updateSession(current);confirmed=true;}catch{}
    const wasInWorld=this.view.entry_state==='in_world',attemptId=this.view.current_attempt?.attempt_id;
    let characterState=wasInWorld?'still_in_world':this.view.entry_state==='ended'?'ended':confirmed?'not_in_world':'unknown';
    let reservationState=['queued','offered','waiting','countdown'].includes(this.view.entry_state)?'still_reserved':confirmed?'none':'unknown';
    let result=this.view.result;
    if(this.view.entry_state==='ended'&&this.sessionValue?.result&&attemptId){
      result=this.sessionValue.result;await this.finishTerminal(attemptId,result);
    }else if(abandon&&wasInWorld&&attemptId){
      try{
        const reply=await this.rpc('tools/call',{name:'abandon',arguments:{}},undefined,{stopping:true});
        const data=toolData(reply);
        if(data?.ok===true&&data.outcome==='abandoned'){
          characterState='ended';
          try{result=(await this.client.result()).result??data;}catch{result=data;}
          await this.finishTerminal(attemptId,result);
        }else{
          const session=await this.client.session();
          if(session.state==='ended'&&session.result){result=session.result;characterState='ended';await this.finishTerminal(attemptId,result);}
        }
      }catch(cause){
        // Even if the game grant has already been revoked, only the independent
        // result channel can confirm a terminal; authentication errors cannot.
        try{result=(await this.client.result()).result;if(result){characterState='ended';await this.finishTerminal(attemptId,result);}}
        catch{this.notify({last_error:{code:safeError(cause).code,retryable:false}});}
      }
    }else if(abandon&&reservationState==='still_reserved'&&typeof this.client.withdrawEntry==='function'){
      try{const current=await this.client.withdrawEntry();this.updateSession(current);reservationState='released';}
      catch(cause){this.notify({last_error:{code:safeError(cause).code,retryable:false}});}
    }
    if(locks.get(this.client)===this)locks.delete(this.client);
    this.notify({phase:'stopped',character_state:characterState,loop:{state:'stopped',reason:reason==='server_terminal'?null:terminalLoopReasons.has(reason)?reason:'client_error'}});
    return {stopped:true,character_state:characterState,reservation_state:reservationState,entry_state:this.view.entry_state??lastState,
      terminal_confirmed:characterState==='ended',...(result?{result:this.redact(result)}:{})};
  }
}
