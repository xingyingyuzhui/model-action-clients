import { createHash, randomUUID } from 'node:crypto';

const SAFE = Symbol('arena-client-error');
const error = (code, status = null, retryable = false) => Object.assign(new Error(code), { code, status, retryable, [SAFE]: true });
const clone = value => structuredClone(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,200}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const states = new Set(['preparing','ready','queued','offered','waiting','countdown','in_world','ended']);
const accessFailure = cause => [401,403,410].includes(cause?.status) && /^(?:beta_(?:access|invite)_(?:invalid|expired|revoked|required)|invite_required|public_access_closed|client_unauthorized|unauthorized)$/.test(cause?.code??'');
function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw error('invalid_server_url'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw error('invalid_server_url');
  return url.origin;
}
function mcpUrl(value, serverOrigin) {
  let url;
  try { url = new URL(value); } catch { throw error('unsafe_mcp_url'); }
  if (url.origin !== serverOrigin || url.username || url.password || url.search || url.hash || !['/mcp','/agent-game/mcp'].includes(url.pathname)) throw error('unsafe_mcp_url');
  return url.href;
}
function requireText(value, max) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw error('invalid_client_input'); }
const ENTRY_FIELDS = ['name', 'character_id', 'loadout_id', 'mode_id', 'room_id'];
function completeEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ENTRY_FIELDS.some(k => !Object.hasOwn(value, k))) return null;
  const {name, character_id, loadout_id, mode_id, room_id} = value;
  if (typeof name !== 'string' || !name.trim() || name.length > 24 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name) ||
    !['default','mimo','deepseek','qwen','kimi','glm'].includes(character_id) || !['rifle','smg','shotgun','armored'].includes(loadout_id) ||
    !(mode_id === 'extraction' && room_id === 'public-1' || mode_id === 'battle_royale' && [null,'br-1','br-2','br-3'].includes(room_id))) return null;
  return {name:name.trim(), character_id, loadout_id, mode_id, room_id};
}
const sameEntry = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
// Bind saved configuration to qualification identity; the current server session
// decides access. Local expiry metadata can lag an administrator extension.
function nativeConsentScope(value) {
  const access = value.native_access;
  if (token(access?.token) && identifier(access.grant?.id) && access.grant.state === 'active') return access.grant.id;
  if(token(value.native_legacy_ticket))return 'legacy-native';
  if(!access&&value.control?.acked&&token(value.control.token)){
    const digest=createHash('sha256').update(value.control.token).digest('hex');
    if(value.native_verified_control===digest)return 'verified-lease:'+digest;
  }
  return null;
}
function confirmedEntry(value) {
  const entry = completeEntry(value.entry_preferences), scope = nativeConsentScope(value);
  const profile = value.profiles[value.last_profile_id];
  if (!entry || !scope || !profile?.acked || profile.unavailable || profile.public_agent_id !== value.last_profile_id ||
    profile.name !== entry.name || profile.appearance?.character !== entry.character_id) return null;
  const record = value.entry_consent;
  if (record) return record.scope === scope && record.public_agent_id === profile.public_agent_id && sameEntry(completeEntry(record.entry), entry) ? entry : null;
  // 0.2.0 native hosts wrote preferences only after human confirmation and
  // successful server preparation. New SDK preparations set the marker first.
  return value.entry_consent_schema === undefined ? entry : null;
}
function pairingRecord(reply) {
  if (!identifier(reply.pairing_id) || !token(reply.device_secret) || typeof reply.user_code !== 'string' || !/^[A-Z0-9]{10}$/.test(reply.user_code) || !Number.isSafeInteger(reply.expires_at_ms) || !Number.isSafeInteger(reply.poll_interval_ms)) throw error('invalid_response');
  return { pairing_id: reply.pairing_id, device_secret: reply.device_secret, user_code: reply.user_code, expires_at_ms: reply.expires_at_ms, poll_interval_ms: reply.poll_interval_ms };
}
const publicPairing = pairing => ({ state: 'pending', user_code: pairing.user_code, expires_at_ms: pairing.expires_at_ms, poll_interval_ms: pairing.poll_interval_ms });


// Native invitation exchange and browser pairing are separate admission paths.
// Both retain private credentials in the store and expose only safe DTOs.
export class ArenaClient {
  constructor({ serverUrl, store, fetcher = globalThis.fetch, clock = Date.now, timeoutMs = 15000, signal } = {}) {
    this.serverUrl = origin(serverUrl); this.store = store; this.fetcher = fetcher; this.clock = clock;
    if (!store || typeof store.read !== 'function' || typeof store.write !== 'function' || typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw error('invalid_client_config');
    this.timeoutMs = timeoutMs; this.signal = signal; this.chain = Promise.resolve(); this.controllers = new Set();
  }

  exclusive(fn) { const next = this.chain.then(fn, fn); this.chain = next.catch(() => {}); return next; }

  async load() {
    const value = await this.store.read();
    if (!value) return { schema_version: 1, origin: this.serverUrl, pairing: null, control: null, profiles: {}, attempt: null, pending_claim: null, pending_operations: {} };
    if (value.schema_version !== 1 || value.origin !== this.serverUrl || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) throw error(value.origin !== this.serverUrl ? 'store_origin_mismatch' : 'store_corrupt');
    value.pending_operations ??= {};
    return clone(value);
  }

  async request(route, { method = 'POST', body, bearer, key } = {}) {
    if (this.signal?.aborted) throw error('request_cancelled');
    const controller = new AbortController(); let timedOut = false;
    this.controllers.add(controller);
    const abort = () => controller.abort(); this.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const response = await this.fetcher(this.serverUrl + route, { method, redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(key ? { 'idempotency-key': key } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (response.redirected || (response.url && response.url !== this.serverUrl + route)) throw error('unexpected_redirect');
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) throw error('response_too_large');
      let value;
      try { value = JSON.parse(raw); } catch { throw error('invalid_response', response.status); }
      if (!response.ok) {
        const code = value?.error?.code;
        throw error(typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'http_error', response.status, [429,503].includes(response.status));
      }
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 2) throw error('unsupported_schema', response.status);
      return value;
    } catch (err) {
      if (this.signal?.aborted) throw error('request_cancelled');
      if (timedOut) throw error('request_timeout', null, true);
      if (err?.[SAFE]) throw err;
      if (controller.signal.aborted) throw error('request_cancelled');
      throw error('network_error', null, true);
    } finally { clearTimeout(timeout); this.controllers.delete(controller); this.signal?.removeEventListener('abort', abort); }
  }
  cancelPending() { for (const controller of this.controllers) controller.abort(); }

  control(value) { if (!value.control?.acked || !token(value.control.token)) throw error('pairing_required'); return value.control.token; }
  async session() {
    const value = await this.load();
    const result = await this.request('/client/v2/session', { method: 'GET', bearer: this.control(value) });
    if (!states.has(result.state)) throw error('invalid_response');
    return result;
  }
  async heartbeat(loop = { state: 'idle' }) {
    if (!loop || !['idle','running','waiting','stopped','error'].includes(loop.state) || (loop.reason !== undefined && !['user_stop','time_limit','budget_limit','client_error',null].includes(loop.reason))) throw error('invalid_client_input');
    const value = await this.load();
    return this.request('/client/v2/heartbeat', { bearer: this.control(value), body: { loop: { state: loop.state, ...(loop.reason !== undefined ? { reason: loop.reason } : {}) } } });
  }

  async catalog(){
    const data=await this.request('/lobby/v2/catalog',{method:'GET'});
    if(!Array.isArray(data.appearance?.character)||!Array.isArray(data.loadouts)||!Array.isArray(data.mode_ids))throw error('invalid_response');
    return {schema_version:2,catalog_revision:data.catalog_revision,appearance:{character:data.appearance.character.map(p=>({id:p.id,name:p.name,enabled:p.enabled!==false,cosmetic_only:true}))},
      loadouts:data.loadouts.map(p=>({id:p.id,name:p.name,enabled:p.enabled!==false,weapon:p.weapon,equipment:p.equipment,weight_kg:p.weight_kg,total_value:p.total_value})),mode_ids:data.mode_ids};
  }
  async admissionPolicy(){
    const policy=await this.request('/lobby/v2/access',{method:'GET'});
    // Old enabled:false deployments still require their private legacy invite.
    // Only an explicit, coherent open-policy response authorizes bootstrap.
    return {admission_mode:policy.enabled===true&&policy.admission_mode==='open'&&policy.invite_required===false?'open':'invite',
      invite_required:!(policy.enabled===true&&policy.admission_mode==='open'&&policy.invite_required===false)};
  }
  async connectNative({ticket,label='Model行动 client',version='0.2.9'}={}){
    requireText(label,60);requireText(version,40);
    if(ticket!==undefined){
      if(typeof ticket!=='string')throw error('invalid_invite_input');
      ticket=ticket.trim();
      if(ticket.startsWith('https://')||ticket.startsWith('http://')){
        let url;try{url=new URL(ticket);}catch{throw error('invalid_invite_input');}
        const params=new URLSearchParams(url.hash.slice(1));
        if(url.origin!==this.serverUrl||url.pathname!=='/agent-arena/lobby/'||url.search||url.username||url.password||params.getAll('invite').length!==1||[...params.keys()].some(k=>k!=='invite'))throw error('invalid_invite_input');
        ticket=params.get('invite');
      }
      requireText(ticket,200);
    }
    return this.exclusive(async()=>{
      const value=await this.load();
      let freshGuest=false;
      if(typeof this.store.readNativeMigration==='function'){
        const ids=Object.values(value.profiles).filter(p=>p.acked).map(p=>p.public_agent_id);
        const migration=await this.store.readNativeMigration(this.serverUrl,ids);
        if(migration&&!value.native_access){value.native_access=migration;await this.store.write(value);}
        if(migration&&value.native_access?.token===migration.token)await this.store.consumeNativeMigration?.();
      }
      if(value.control?.acked){
        try{
          const session=await this.request('/client/v2/session',{method:'GET',bearer:this.control(value)});
          if(!states.has(session.state))throw error('invalid_response');
          let replaceGuest=false;
          if(value.native_access?.grant?.kind==='open'&&session.state!=='in_world'&&(await this.admissionPolicy()).invite_required){
            // Keeping the old lease permits reading a finished result, but does
            // not make this guest eligible to prepare another match.
            if(ticket===undefined)throw error('invite_required');
            if(!['preparing','ready','ended'].includes(session.state))throw error('previous_attempt_not_cleared');
            replaceGuest=true;
          }
          if(replaceGuest){this.clearConnection(value);await this.store.write(value);}else{
          const restored=await this.restoreNativeProfile(value,session,{strict:value.native_access?.grant?.kind==='open'});
          // Old stdio clients may still have a valid browser-era lease without
          // a persistent native grant. Bind preference consent only after the
          // current server actually validates this exact lease.
          value.native_verified_control=createHash('sha256').update(value.control.token).digest('hex');
          await this.store.write(value);
          return {state:'connected',grant:value.native_access?.grant??null,session:restored};
          }
        }catch(cause){
          if(!accessFailure(cause))throw cause;
          if(cause.status!==401){
            if(ticket===undefined){if((await this.admissionPolicy()).invite_required)throw cause;freshGuest=true;}
          }
          this.clearConnection(value);await this.store.write(value);
        }
      }
      let pending=value.pending_native_connect;
      if(pending&&ticket!==undefined&&pending.body.ticket!==ticket){
        if(pending.body.ticket===undefined&&pending.body.access_token===undefined&&(await this.admissionPolicy()).invite_required){
          value.pending_native_connect=null;pending=null;await this.store.write(value);
        }else throw error('pending_native_connection_conflict');
      }
      if(!pending){
        const proof=freshGuest?undefined:ticket??value.native_access?.token??value.native_legacy_ticket;
        if(!proof&&(await this.admissionPolicy()).invite_required)throw error('invite_required');
        const body={...(proof===undefined?{}:ticket!==undefined||!value.native_access?.token?{ticket:proof}:{access_token:proof}),label,version,protocol_version:1};
        pending={key:randomUUID(),body};value.pending_native_connect=pending;await this.store.write(value);
      }
      let reply;
      try{reply=await this.request('/client/v2/access/connect',{body:pending.body,key:pending.key});}
      catch(cause){
        if([400,401,403,404,409,410,422].includes(cause.status)){value.pending_native_connect=null;await this.store.write(value);}
        // A saved, now-expired qualification may be replaced by a public guest
        // only after the server explicitly advertises open admission. Recovery
        // proofs are retained, and profile/administration errors never enter here.
        if(ticket===undefined&&pending.body.access_token&&accessFailure(cause)&&!(await this.admissionPolicy()).invite_required){
          this.clearConnection(value);
          pending={key:randomUUID(),body:{label,version,protocol_version:1}};
          value.pending_native_connect=pending;await this.store.write(value);
          try{reply=await this.request('/client/v2/access/connect',{body:pending.body,key:pending.key});}
          catch(fallback){if([400,401,403,404,409,410,422].includes(fallback.status)){value.pending_native_connect=null;await this.store.write(value);}throw fallback;}
        }else throw cause;
      }
      if(!token(reply.control_token)||!(reply.access_token===null||token(reply.access_token))||!states.has(reply.session?.state))throw error('invalid_response');
      if(reply.access_token===null&&pending.body.ticket===undefined)throw error('invalid_response');
      if(reply.access_token!==null&&(!identifier(reply.grant?.id)||!Number.isSafeInteger(reply.grant?.expires_at_ms)||reply.grant.state!=='active'))throw error('invalid_response');
      value.control={token:reply.control_token,acked:true};value.pairing=null;
      value.native_access=reply.access_token===null?null:{token:reply.access_token,grant:{id:reply.grant.id,expires_at_ms:reply.grant.expires_at_ms,state:reply.grant.state,max_concurrent_agents:reply.grant.max_concurrent_agents??1,...(reply.grant.kind==='open'?{kind:'open'}:{})}};
      if(reply.access_token===null)value.native_legacy_ticket=pending.body.ticket??value.native_legacy_ticket;
      else delete value.native_legacy_ticket;
      value.pending_native_connect=null;await this.store.write(value);
      return {state:'connected',grant:value.native_access?.grant??null,session:await this.restoreNativeProfile(value,reply.session,{strict:value.native_access?.grant?.kind==='open'})};
    });
  }
  async restoreNativeProfile(value,session,{strict=false}={}){
    const preferred=value.profiles[value.last_profile_id];
    const recent=preferred?.acked&&!preferred.unavailable?preferred:Object.values(value.profiles).filter(p=>p.acked&&!p.unavailable).at(-1);
    if(session.state==='preparing'&&!session.public_agent_id&&recent?.acked&&token(recent.recovery_secret)){
      try{return await this.request('/client/v2/profile/recover',{bearer:this.control(value),body:{public_agent_id:recent.public_agent_id,recovery_secret:recent.recovery_secret}});}
      catch(cause){
        if(strict||!['agent_deleted','invalid_profile_proof','profile_not_found'].includes(cause.code))throw cause;
        recent.unavailable=true;await this.store.write(value);
      }
    }
    return session;
  }

  async pairInit({ label, version }) {
    requireText(label, 60); requireText(version, 40);
    return this.exclusive(async () => {
      const value = await this.load();
      if (value.control && !value.control.acked && (value.control.expires_at_ms <= this.clock() || value.pairing?.expires_at_ms <= this.clock())) {
        // An ACK reply may have been lost even after its delivery window. Only
        // a control-session 401 proves this saved connection can be discarded.
        try {
          await this.request('/client/v2/session', { method: 'GET', bearer: value.control.token });
          value.control.acked = true; delete value.control.receipt;
          if (value.pairing) delete value.pairing.device_secret;
          await this.store.write(value);
        } catch (err) {
          if (err.status !== 401) throw err;
          this.clearConnection(value); await this.store.write(value);
        }
      }
      if (value.control || (value.pairing?.device_secret && value.pairing.expires_at_ms > this.clock())) throw error('pairing_in_progress');
      const reply = await this.request('/client/v2/pair/init', { body: { label, version, protocol_version: 1 } });
      value.pairing = pairingRecord(reply);
      await this.store.write(value);
      return publicPairing(value.pairing);
    });
  }

  // Explicit public repair API: never unlink private state or discard a grant
  // before the replacement proof has been received and durably committed.
  async repairPairing({ label, version }) {
    requireText(label, 60); requireText(version, 40);
    return this.exclusive(async () => {
      const value = await this.load();
      if (value.attempt || value.pending_claim || Object.keys(value.pending_operations).length) throw error('pairing_repair_not_safe');
      if (value.control) {
        if (!token(value.control.token)) throw error('store_corrupt');
        try {
          await this.request('/client/v2/session', { method: 'GET', bearer: value.control.token });
          throw error('connection_active');
        } catch (err) { if (err.status !== 401) throw err; }
      }
      let reply;
      if (value.pairing?.device_secret) {
        try {
          // Server replacement and browser approval serialize on the same
          // pending request. Replay of this exact old proof returns the same
          // replacement, including after a transport/disk failure here.
          reply = await this.request('/client/v2/pair/replace', { body: { pairing_id: value.pairing.pairing_id, device_secret: value.pairing.device_secret, label, version, protocol_version: 1 } });
        } catch (err) {
          // Only an explicit missing/expired pairing proves that the old code
          // cannot be approved. An unsupported route is not such evidence.
          if (![404,410].includes(err.status) || !['pairing_not_found','pairing_expired'].includes(err.code)) throw err;
        }
      }
      reply ??= await this.request('/client/v2/pair/init', { body: { label, version, protocol_version: 1 } });
      const pairing = pairingRecord(reply);
      // Preserve profiles and all other harmless local metadata. On transport,
      // validation or disk failure the prior proof is still the committed one.
      value.pairing = pairing; value.control = null;
      await this.store.write(value);
      return { ...publicPairing(pairing), profiles_preserved: Object.keys(value.profiles).length };
    });
  }

  async pairPoll() {
    return this.exclusive(async () => {
      const value = await this.load(), pairing = value.pairing;
      if (value.control?.acked) return { state: 'connected' };
      if (!pairing || !token(pairing.device_secret)) throw error('pairing_required');
      if (value.control?.token) {
        // Pair ACK consumes its proof and is not replayable. A lost ACK reply is
        // reconciled with the already-durable control token before any replay.
        try {
          await this.request('/client/v2/session', { method: 'GET', bearer: value.control.token });
          value.control.acked = true; delete value.control.receipt; delete pairing.device_secret;
          await this.store.write(value); return { state: 'connected' };
        } catch (err) { if (err.status !== 401) throw err; }
      } else {
        const reply = await this.request('/client/v2/pair/poll', { body: { pairing_id: pairing.pairing_id, device_secret: pairing.device_secret } });
        if (['pending','cancelled'].includes(reply.state)) return { state: reply.state };
        if (reply.state !== 'awaiting_receipt' || !token(reply.control_token) || !token(reply.receipt) || !Number.isSafeInteger(reply.receipt_expires_at_ms)) throw error('invalid_response');
        value.control = { token: reply.control_token, receipt: reply.receipt, expires_at_ms: reply.receipt_expires_at_ms, acked: false };
        await this.store.write(value);
      }
      const reply = await this.request('/client/v2/pair/poll', { body: { pairing_id: pairing.pairing_id, device_secret: pairing.device_secret, receipt: value.control.receipt } });
      if (reply.state !== 'connected') throw error('invalid_response');
      value.control.acked = true; delete value.control.receipt; delete pairing.device_secret;
      await this.store.write(value); return { state: 'connected' };
    });
  }

  clearConnection(value) {
    value.control = null; value.pairing = null; value.attempt = null;
    delete value.native_verified_control;
    value.pending_claim = null; value.pending_operations = {};
  }
  async resetConnection() {
    return this.exclusive(async () => {
      const value = await this.load();
      if (value.control?.token) {
        try {
          await this.request('/client/v2/session', { method: 'GET', bearer: value.control.token });
          throw error('connection_active');
        } catch (err) { if (err.status !== 401) throw err; }
      }
      this.clearConnection(value); await this.store.write(value);
      return { state: 'unpaired', profiles_preserved: Object.keys(value.profiles).length };
    });
  }

  async claimProfile() {
    return this.exclusive(async () => {
      const value = await this.load(), bearer = this.control(value);
      const session = await this.request('/client/v2/session', { method: 'GET', bearer });
      const id = session.public_agent_id;
      if (!id) return { state: 'not_ready' };
      if (!identifier(id)) throw error('invalid_response');
      let profile = value.profiles[id];
      if (profile?.acked) return { state: 'saved', public_agent_id: id };
      if (!profile?.receipt) {
        const reply = await this.request('/client/v2/profile/claim', { body: {}, bearer });
        if (reply.public_agent_id !== id || !token(reply.recovery_secret) || !token(reply.receipt)) throw error('invalid_response');
        profile = { public_agent_id: id, recovery_secret: reply.recovery_secret, receipt: reply.receipt, acked: false };
        value.profiles[id] = profile; await this.store.write(value);
      }
      const reply = await this.request('/client/v2/profile/claim', { body: { receipt: profile.receipt }, bearer });
      if (reply.state !== 'acknowledged' || reply.public_agent_id !== id) throw error('invalid_response');
      profile.acked = true; delete profile.receipt;value.last_profile_id=id;
      if(value.entry_preferences){profile.name=value.entry_preferences.name;profile.appearance={character:value.entry_preferences.character_id??'default'};}
      const consent=value.entry_consent;
      if(consent&&!consent.public_agent_id&&consent.scope===nativeConsentScope(value)&&sameEntry(completeEntry(consent.entry),completeEntry(value.entry_preferences)))consent.public_agent_id=id;
      await this.store.write(value);
      return { state: 'saved', public_agent_id: id };
    });
  }

  async recoverProfile(publicAgentId) {
    if (!identifier(publicAgentId)) throw error('invalid_client_input');
    const value = await this.load(), profile = value.profiles[publicAgentId];
    if (!profile?.acked || !token(profile.recovery_secret)) throw error('profile_not_saved');
    return this.request('/client/v2/profile/recover', { bearer: this.control(value), body: { public_agent_id: publicAgentId, recovery_secret: profile.recovery_secret } });
  }

  async claimAttempt({ attemptId, model, renew = false }) {
    if (!identifier(attemptId) || typeof renew !== 'boolean') throw error('invalid_client_input');
    if (model !== undefined) requireText(model, 120);
    return this.exclusive(async () => {
      const value = await this.load(), bearer = this.control(value);
      let grant = value.attempt;
      if (grant && grant.attempt_id !== attemptId) throw error('previous_attempt_not_cleared');
      if (grant?.acked && !renew) return { state: 'acknowledged', attempt_id: attemptId, mcp_url: mcpUrl(grant.mcp_url, this.serverUrl) };
      if (!grant || grant.acked) {
        const body = { attempt_id: attemptId, ...(model !== undefined ? { model } : {}), ...(renew ? { renew: true } : {}) };
        if (value.pending_claim && JSON.stringify(value.pending_claim.body) !== JSON.stringify(body)) throw error('pending_grant_conflict');
        value.pending_claim ??= { key: randomUUID(), body }; await this.store.write(value);
        const reply = await this.request('/client/v2/attempt/claim', { bearer, body: value.pending_claim.body, key: value.pending_claim.key });
        if (reply.attempt_id !== attemptId || reply.credential_scope !== 'current_attempt' || !token(reply.game_token) || !token(reply.receipt) || !Number.isSafeInteger(reply.expires_at_ms)) throw error('invalid_response');
        grant = { attempt_id: attemptId, game_token: reply.game_token, receipt: reply.receipt, mcp_url: mcpUrl(reply.mcp_url, this.serverUrl), expires_at_ms: reply.expires_at_ms, key: value.pending_claim.key, acked: false };
        value.attempt = grant; await this.store.write(value);
      }
      const reply = await this.request('/client/v2/attempt/claim', { bearer, key: grant.key, body: { attempt_id: attemptId, receipt: grant.receipt } });
      if (reply.state !== 'acknowledged' || reply.attempt_id !== attemptId) throw error('invalid_response');
      grant.acked = true; delete grant.receipt; value.pending_claim = null; await this.store.write(value);
      return { state: 'acknowledged', attempt_id: attemptId, mcp_url: grant.mcp_url };
    });
  }

  async readyAttempt(attemptId) {
    if (!identifier(attemptId)) throw error('invalid_client_input');
    const value = await this.load();
    if (value.attempt?.attempt_id !== attemptId || !value.attempt.acked) throw error('grant_not_acknowledged');
    return this.request('/client/v2/attempt/ready', { bearer: this.control(value), body: { attempt_id: attemptId } });
  }
  async result() { const value = await this.load(); return this.request('/client/v2/result', { method: 'GET', bearer: this.control(value) }); }
  async entryMutation(name, route, body, allowedStates) {
    return this.exclusive(()=>this.performEntryMutation(name,route,body,allowedStates));
  }
  async performEntryMutation(name,route,body,allowedStates){
      const value = await this.load(), bearer = this.control(value);
      let intent = value.pending_operations[name];
      if (intent && JSON.stringify(intent.body) !== JSON.stringify(body)) throw error('pending_operation_conflict');
      if (!intent) {
        const session = await this.request('/client/v2/session', { method: 'GET', bearer });
        if (!allowedStates.includes(session.state)) return session;
        intent = { key: randomUUID(), body }; value.pending_operations[name] = intent;
        await this.store.write(value);
      }
      const reply = await this.request(route, { bearer, key: intent.key, body: intent.body });
      if (!states.has(reply.state)) throw error('invalid_response');
      if (name === 'withdraw') value.pending_operations = {};
      else delete value.pending_operations[name];
      await this.store.write(value);
      return reply;
  }
  async prepareEntry({ mode_id, room_id, name, loadout_id, character_id }) {
    if (!['extraction','battle_royale'].includes(mode_id) || (room_id !== null && !['public-1','br-1','br-2','br-3'].includes(room_id)) || (mode_id === 'extraction' && room_id !== null && room_id !== 'public-1') || (mode_id === 'battle_royale' && room_id === 'public-1')) throw error('invalid_client_input');
    if (name !== undefined) requireText(name, 24);
    if (loadout_id !== undefined && !['rifle','smg','shotgun','armored'].includes(loadout_id)) throw error('invalid_client_input');
    if(character_id!==undefined&&!['default','mimo','deepseek','qwen','kimi','glm'].includes(character_id))throw error('invalid_client_input');
    const body={mode_id,room_id,...(name!==undefined?{name}:{}),...(loadout_id!==undefined?{loadout_id}:{}),...(character_id!==undefined?{character_id}:{})};
    return this.exclusive(async()=>{
      let value=await this.load();
      const previousConsent=confirmedEntry(value);
      if(previousConsent&&!value.entry_consent)value.entry_consent={entry:previousConsent,scope:nativeConsentScope(value),public_agent_id:value.last_profile_id};
      value.entry_consent_schema=1;
      await this.store.write(value);
      if(value.pending_operations.withdraw){await this.performEntryMutation('withdraw','/client/v2/withdraw',{},['preparing','ready','ended']);value=await this.load();}
      if(!value.pending_operations.prepare){
        const session=await this.request('/client/v2/session',{method:'GET',bearer:this.control(value)});
        if(session.state==='ready')await this.performEntryMutation('withdraw','/client/v2/withdraw',{},['ready']);
      }
      const result=await this.performEntryMutation('prepare','/client/v2/prepare',body,['preparing','ended']);
      if(result.state==='ready'){
        value=await this.load();value.entry_preferences=body;
        const profile=value.profiles[result.public_agent_id];
        if(profile){
          if(profile.acked&&!profile.unavailable)value.last_profile_id=result.public_agent_id;
          if(body.name!==undefined)profile.name=body.name;if(body.character_id!==undefined)profile.appearance={character:body.character_id};
        }
        const consent=value.entry_consent,prepared=completeEntry(body);
        if(consent&&profile?.acked&&!profile.unavailable&&consent.scope===nativeConsentScope(value)&&sameEntry(completeEntry(consent.entry),prepared)&&
          (!consent.public_agent_id||consent.public_agent_id===result.public_agent_id))consent.public_agent_id=result.public_agent_id;
        await this.store.write(value);
      }
      return result;
    });
  }
  async rememberConfirmedEntry(input) {
    const entry=completeEntry(input);
    if(!entry||Object.keys(input).some(k=>!ENTRY_FIELDS.includes(k)))throw error('invalid_client_input');
    return this.exclusive(async()=>{
      const value=await this.load(),scope=nativeConsentScope(value);
      if(!scope)throw error('native_access_required');
      const profile=value.profiles[value.last_profile_id];
      value.entry_consent_schema=1;
      value.entry_consent={entry,scope,public_agent_id:profile?.acked&&!profile.unavailable?profile.public_agent_id:null};
      await this.store.write(value);
      return {saved:true};
    });
  }
  async queueEntry() { return this.entryMutation('queue','/client/v2/queue',{},['ready']); }
  async acceptOffer(offerId) {
    if (!identifier(offerId)) throw error('invalid_client_input');
    return this.entryMutation('accept','/client/v2/offer/accept',{offer_id:offerId},['offered']);
  }
  async withdrawEntry() { return this.entryMutation('withdraw','/client/v2/withdraw',{},['preparing','ready','queued','offered','waiting','countdown','ended']); }
  async clearAttempt(attemptId) {
    return this.exclusive(async () => {
      const value = await this.load();
      if (value.attempt && value.attempt.attempt_id !== attemptId) throw error('attempt_mismatch');
      if (value.pending_claim && value.pending_claim.body.attempt_id !== attemptId) throw error('attempt_mismatch');
      value.attempt = null; value.pending_claim = null; await this.store.write(value);
    });
  }
  async attemptCredentials(attemptId) {
    const value = await this.load(), grant = value.attempt;
    if (!grant?.acked || grant.attempt_id !== attemptId || !token(grant.game_token)) throw error('grant_not_acknowledged');
    return { attempt_id: attemptId, game_token: grant.game_token, mcp_url: mcpUrl(grant.mcp_url, this.serverUrl) };
  }
  async publicState() {
    const value = await this.load();
    const migration=!value.native_access&&typeof this.store.readNativeMigration==='function'?await this.store.readNativeMigration(this.serverUrl,Object.values(value.profiles).filter(p=>p.acked).map(p=>p.public_agent_id)):null;
    return { server_url: this.serverUrl, connected: !!value.control?.acked,
      pairing: value.pairing ? { user_code: value.pairing.user_code, expires_at_ms: value.pairing.expires_at_ms, poll_interval_ms: value.pairing.poll_interval_ms } : null,
      profiles: Object.values(value.profiles).map(p => ({ public_agent_id: p.public_agent_id, saved: !!p.acked&&!p.unavailable,...(p.name?{name:p.name}:{}),...(p.appearance?{appearance:clone(p.appearance)}:{}) })),
      access_credential_saved:!!value.native_access?.token||!!value.native_legacy_ticket||!!migration,native_connect_pending:!!value.pending_native_connect,
      entry_preferences:value.entry_preferences?clone(value.entry_preferences):null,
      confirmed_entry:confirmedEntry(value),
      attempt: value.attempt ? { attempt_id: value.attempt.attempt_id, acknowledged: !!value.attempt.acked } : null };
  }
}
