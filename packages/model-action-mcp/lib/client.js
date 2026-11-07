import { randomUUID } from 'node:crypto';

const SAFE = Symbol('arena-client-error');
const error = (code, status = null, retryable = false) => Object.assign(new Error(code), { code, status, retryable, [SAFE]: true });
const clone = value => structuredClone(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,200}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const states = new Set(['preparing','ready','queued','offered','waiting','countdown','in_world','ended']);
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
function pairingRecord(reply) {
  if (!identifier(reply.pairing_id) || !token(reply.device_secret) || typeof reply.user_code !== 'string' || !/^[A-Z0-9]{10}$/.test(reply.user_code) || !Number.isSafeInteger(reply.expires_at_ms) || !Number.isSafeInteger(reply.poll_interval_ms)) throw error('invalid_response');
  return { pairing_id: reply.pairing_id, device_secret: reply.device_secret, user_code: reply.user_code, expires_at_ms: reply.expires_at_ms, poll_interval_ms: reply.poll_interval_ms };
}
const publicPairing = pairing => ({ state: 'pending', user_code: pairing.user_code, expires_at_ms: pairing.expires_at_ms, poll_interval_ms: pairing.poll_interval_ms });


// The client never approves a browser pairing, manipulates a browser session or
// exposes game credentials as a tool result. All grants are durable before ACK.
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
      profile.acked = true; delete profile.receipt; await this.store.write(value);
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
    return this.exclusive(async () => {
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
    });
  }
  async prepareEntry({ mode_id, room_id, name, loadout_id }) {
    if (!['extraction','battle_royale'].includes(mode_id) || (room_id !== null && !['public-1','br-1','br-2','br-3'].includes(room_id)) || (mode_id === 'extraction' && room_id !== null && room_id !== 'public-1') || (mode_id === 'battle_royale' && room_id === 'public-1')) throw error('invalid_client_input');
    if (name !== undefined) requireText(name, 24);
    if (loadout_id !== undefined && !['rifle','smg','shotgun','armored'].includes(loadout_id)) throw error('invalid_client_input');
    return this.entryMutation('prepare','/client/v2/prepare',{mode_id,room_id,...(name !== undefined ? {name}:{}),...(loadout_id !== undefined ? {loadout_id}:{})},['preparing','ended']);
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
    return { server_url: this.serverUrl, connected: !!value.control?.acked,
      pairing: value.pairing ? { user_code: value.pairing.user_code, expires_at_ms: value.pairing.expires_at_ms, poll_interval_ms: value.pairing.poll_interval_ms } : null,
      profiles: Object.values(value.profiles).map(p => ({ public_agent_id: p.public_agent_id, saved: !!p.acked })),
      attempt: value.attempt ? { attempt_id: value.attempt.attempt_id, acknowledged: !!value.attempt.acked } : null };
  }
}
