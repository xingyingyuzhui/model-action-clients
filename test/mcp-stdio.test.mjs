import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const executable = fileURLToPath(new URL('../packages/model-action-mcp/bin/model-action-mcp.mjs', import.meta.url));
const decode = result => JSON.parse(result.content[0].text);
const secret = 'private_fixture_secret_123456789';
const invitation='model_beta_invite_'+'i'.repeat(43),access='model_beta_'+'a'.repeat(43);
const entry={name:'小鱼',character_id:'qwen',loadout_id:'rifle',mode_id:'extraction',room_id:'public-1'};
async function fixture(t) {
  let approved = false, state = 'preparing', count = 0, currentAttempt = null, pairCalls = 0, cancelled = false, controlValid = true;
  const routes=[];let prepareGate,prepareArrived;
  const result = () => ({ outcome: 'abandoned', public_agent_id: 'agent_fixture', attempt_id: currentAttempt.id });
  const session = () => ({ state, connection: { state: 'connected' }, public_agent_id: state === 'preparing' ? null : 'agent_fixture', attempt: currentAttempt,
    ...(state === 'offered' ? { offer: { id: 'offer_fixture' } } : {}), ...(state === 'ended' ? { result: result() } : {}) });
  let origin;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};routes.push(req.url);
    let value;
    if (['/client/v2/session', '/client/v2/heartbeat'].includes(req.url) && !controlValid) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ schema_version: 2, error: { code: 'unauthorized' } })); return;
    }
    switch (req.url) {
      case '/lobby/v2/catalog':value={catalog_revision:'mcp-1',appearance:{character:[{id:'default',name:'默认形象',enabled:true},{id:'qwen',name:'Qwen 娘',enabled:true},{id:'deepseek',name:'DeepSeek 娘',enabled:true}]},loadouts:[{id:'rifle',name:'步枪标准配置',enabled:true},{id:'smg',name:'冲锋枪配置',enabled:true}],mode_ids:['extraction','battle_royale']};break;
      case '/client/v2/access/connect':
        if(body.ticket!==invitation&&body.access_token!==access){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({schema_version:2,error:{code:'invite_invalid'}}));return;}
        controlValid=true;value={access_token:access,grant:{id:'beta_fixture',state:'active',expires_at_ms:Date.now()+86400000,max_concurrent_agents:1},control_token:'control_'+secret,session:session()};break;
      case '/client/v2/pair/replace':
      case '/client/v2/pair/init': pairCalls++; value = { pairing_id: 'pair_fixture', device_secret: secret, user_code: 'ABCDEFGHIJ', expires_at_ms: Date.now() + 60000, poll_interval_ms: 2000 }; break;
      case '/client/v2/pair/poll': value = !approved ? { state: 'pending' } : body.receipt ? { state: 'connected' } : { state: 'awaiting_receipt', control_token: 'control_' + secret, receipt: 'receipt_' + secret, receipt_expires_at_ms: Date.now() + 60000 }; break;
      case '/client/v2/session': case '/client/v2/heartbeat': value = session(); break;
      case '/client/v2/prepare': if(prepareGate){prepareArrived();await prepareGate;}state = 'ready'; currentAttempt = null; value = session(); break;
      case '/client/v2/profile/claim': value = body.receipt ? { state: 'acknowledged', public_agent_id: 'agent_fixture' } : { public_agent_id: 'agent_fixture', recovery_secret: 'recovery_' + secret, receipt: 'profile_' + secret }; break;
      case '/client/v2/withdraw':state='preparing';currentAttempt=null;value=session();break;
      case '/client/v2/queue': state = 'offered'; currentAttempt = { id: 'attempt_fixture_' + ++count, room_id: 'public-1', mode_id: 'extraction' }; value = session(); break;
      case '/client/v2/offer/accept': state = 'in_world'; value = session(); break;
      case '/client/v2/attempt/claim': value = body.receipt ? { state: 'acknowledged', attempt_id: currentAttempt.id } : { attempt_id: currentAttempt.id, credential_scope: 'current_attempt', game_token: 'game_' + secret, receipt: 'attempt_' + secret, expires_at_ms: Date.now() + 60000, mcp_url: origin + '/agent-game/mcp' }; break;
      case '/client/v2/result': value = { result: result() }; break;
      case '/agent-game/mcp': {
        if (body.method === 'tools/call' && body.params.arguments?.slow === true) { res.once('close', () => { cancelled = true; }); return; }
        const descriptors = [{ name: 'observe_compact', description: 'Real fixture observation', inputSchema: { type: 'object', properties: {} } }, { name: 'abandon', description: 'Real fixture abandon', inputSchema: { type: 'object', properties: {} } }];
        if (body.method === 'tools/list') value = { jsonrpc: '2.0', id: body.id, result: { tools: descriptors } };
        else {
          if (body.params.name === 'abandon') state = 'ended';
          value = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(body.params.name === 'abandon' ? { ok: true, outcome: 'abandoned' } : { ok: true, tick: 12, self: { hp: 100 } }) }] } };
        }
        break;
      }
      default: res.writeHead(404); res.end('{}'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/agent-game/mcp' ? value : { schema_version: 2, ...value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin, approve: () => { approved = true; controlValid = true;
  const routes=[];let prepareGate,prepareArrived; }, revoke: () => { approved = false; controlValid = false; }, holdPrepare:()=>{let release;prepareGate=new Promise(r=>release=r);const seen=new Promise(r=>prepareArrived=r);return {release,seen};},existing:value=>{state=value;currentAttempt={id:'attempt_existing',room_id:'br-1',mode_id:'battle_royale'};},routes:()=>[...routes], pairs: () => pairCalls, cancelled: () => cancelled };
}
function stateFiles(dir) { return fs.readdirSync(dir, { recursive: true }).map(name => path.join(dir, name)).filter(p => fs.statSync(p).isFile()); }
async function open(t, origin, directory, session = 'test-agent', elicitation) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [executable, '--server-url', origin, '--session', session, '--state-dir', directory], stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'model-action-explicit-test-fixture', version: '1.0.0' },elicitation?{capabilities:{elicitation:elicitation.capabilities}}:{});
  if(elicitation)client.setRequestHandler(ElicitRequestSchema,elicitation.handler);
  await client.connect(transport);
  t.after(() => client.close());
  return { client, stderr: () => stderr };
}

const controlNames=['arena_start','arena_connect','arena_submit_invite','arena_prepare','arena_confirm','arena_status','arena_stop'];
async function connect(client){
 const begin=decode(await client.callTool({name:'arena_start',arguments:{}}));assert.equal(begin.browser_required,false);assert.equal(begin.phase,'awaiting_ticket');
 const ready=decode(await client.callTool({name:'arena_submit_invite',arguments:{invitation}}));assert.equal(ready.phase,'configuring');return ready;
}
async function propose(client,selected=entry){const proposal=decode(await client.callTool({name:'arena_prepare',arguments:selected}));assert.equal(proposal.phase,'awaiting_confirmation');return proposal.dialogue.confirmation_id;}
async function directory(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'model-action-dialogue-mcp-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}

test('official stdio: conversation invitation, all choices, dynamic game tools, terminal and explicit one-call replay',async t=>{
 const server=await fixture(t),dir=await directory(t),{client,stderr}=await open(t,server.origin,dir);
 let notifications=0;client.setNotificationHandler(ToolListChangedNotificationSchema,()=>notifications++);
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name),controlNames);
 assert.equal(decode(await client.callTool({name:'arena_start',arguments:{mode_id:'extraction'}})).error.code,'invalid_client_input');
 assert.equal(decode(await client.callTool({name:'game_observe_compact',arguments:{}})).error.code,'attempt_not_in_world');
 assert.equal(decode(await client.callTool({name:'arena_repair_pairing',arguments:{}})).error.code,'unknown_tool');
 const ready=await connect(client);assert.ok(!JSON.stringify(ready).includes(invitation));assert.ok(!JSON.stringify(ready).includes(access));
 const file=stateFiles(dir).find(p=>p.endsWith('.json'));assert.equal(fs.statSync(file).mode&0o777,0o600);assert.ok(fs.existsSync(file+'.lock'));
 const id=await propose(client);assert.equal(server.routes().filter(p=>p==='/client/v2/queue').length,0);
 const start=decode(await client.callTool({name:'arena_confirm',arguments:{confirmation_id:id}}));assert.equal(start.entry_state,'in_world');
 assert.equal((await client.listTools()).tools.filter(t=>t.name.startsWith('game_')).length,2);assert.ok(notifications>0);
 assert.equal(decode(await client.callTool({name:'game_observe_compact',arguments:{}})).self.hp,100);
 const cancellation=new AbortController(),pending=client.callTool({name:'game_observe_compact',arguments:{slow:true}},undefined,{signal:cancellation.signal});const rejected=assert.rejects(pending);await new Promise(r=>setTimeout(r,50));cancellation.abort();await rejected;
 for(let n=0;n<20&&!server.cancelled();n++)await new Promise(r=>setTimeout(r,10));assert.equal(server.cancelled(),true);
 assert.equal(decode(await client.callTool({name:'game_not_a_tool',arguments:{}})).error.code,'unknown_game_tool');
 await client.callTool({name:'game_abandon',arguments:{}});const ended=decode(await client.callTool({name:'arena_status',arguments:{}}));assert.equal(ended.entry_state,'ended');assert.equal(ended.result.outcome,'abandoned');
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name),controlNames);
 const queueBefore=server.routes().filter(p=>p==='/client/v2/queue').length;
 assert.equal(decode(await client.callTool({name:'arena_start',arguments:{}})).phase,'configuring');assert.equal(server.routes().filter(p=>p==='/client/v2/queue').length,queueBefore);
 const replay=decode(await client.callTool({name:'arena_start',arguments:{reuse_previous:true}}));assert.equal(replay.entry_state,'in_world');assert.notEqual(replay.current_attempt.attempt_id,start.current_attempt.attempt_id);
 const stop=decode(await client.callTool({name:'arena_stop',arguments:{abandon:true}}));assert.equal(stop.terminal_confirmed,true);
 assert.equal(server.pairs(),0);assert.ok(!server.routes().some(p=>/pair|approve|lobby\/v2\/session/.test(p)));
 await client.close();assert.ok(!fs.existsSync(file+'.lock'));assert.ok(!stderr().includes(secret));
});

test('stdio reload reuses saved native qualification and profile, including a revoked control lease',async t=>{
 const server=await fixture(t),dir=await directory(t),first=await open(t,server.origin,dir,'persistent');await connect(first.client);const id=await propose(first.client);await first.client.callTool({name:'arena_confirm',arguments:{confirmation_id:id}});await first.client.callTool({name:'game_abandon',arguments:{}});await first.client.callTool({name:'arena_status',arguments:{}});await first.client.close();
 server.revoke();const second=await open(t,server.origin,dir,'persistent');const view=decode(await second.client.callTool({name:'arena_start',arguments:{reuse_previous:true}}));assert.equal(view.entry_state,'in_world');assert.equal(server.routes().filter(p=>p==='/client/v2/access/connect').length,2);assert.equal(server.pairs(),0);await second.client.callTool({name:'arena_stop',arguments:{abandon:true}});
});

test('MCP form confirmation supports explicit and legacy form capability without collecting invitations',async t=>{
 for(const capabilities of [{form:{}},{}]){
  const server=await fixture(t),dir=await directory(t),forms=[];
  const {client}=await open(t,server.origin,dir,'form-'+forms.length,{capabilities,handler:async request=>{forms.push(request.params);return {action:'accept',content:{confirmed:true}};}});
  await connect(client);assert.equal(forms.length,0,'invitation is never requested through elicitation');const id=await propose(client);assert.equal(forms.length,0);
  const state=decode(await client.callTool({name:'arena_confirm',arguments:{confirmation_id:id}}));assert.equal(state.entry_state,'in_world');assert.equal(forms.length,1);assert.equal(forms[0].mode,'form');assert.ok(!JSON.stringify(forms).includes(invitation));assert.deepEqual(Object.keys(forms[0].requestedSchema.properties),['confirmed']);await client.callTool({name:'arena_stop',arguments:{abandon:true}});await client.close();
 }
});

test('declined or cancelled native confirmation never queues, and URL-only hosts use dialogue consent',async t=>{
 for(const action of ['decline','cancel']){
  const server=await fixture(t),dir=await directory(t),{client}=await open(t,server.origin,dir,'declined',{capabilities:{form:{}},handler:async()=>({action})});await connect(client);const id=await propose(client);const state=decode(await client.callTool({name:'arena_confirm',arguments:{confirmation_id:id}}));assert.equal(state.phase,'configuring');assert.equal(server.routes().filter(p=>p==='/client/v2/queue').length,0);await client.close();
 }
 const server=await fixture(t),dir=await directory(t);let forms=0;const {client}=await open(t,server.origin,dir,'url-only',{capabilities:{url:{}},handler:async()=>{forms++;return {action:'cancel'};}});await connect(client);const id=await propose(client);assert.equal(decode(await client.callTool({name:'arena_confirm',arguments:{confirmation_id:id}})).entry_state,'in_world');assert.equal(forms,0);await client.callTool({name:'arena_stop',arguments:{abandon:true}});
});

test('pending confirmation is superseded by a new proposal and stop cancels the pending form',async t=>{
 const server=await fixture(t),dir=await directory(t);let gate,arrived;
 const entered=new Promise(resolve=>arrived=resolve),{client}=await open(t,server.origin,dir,'superseded',{capabilities:{form:{}},handler:async()=>{arrived();await new Promise(resolve=>gate=resolve);return {action:'accept',content:{confirmed:true}};}});
 await connect(client);const id=await propose(client);const old=client.callTool({name:'arena_confirm',arguments:{confirmation_id:id}});await entered;
 const next=client.callTool({name:'arena_prepare',arguments:{...entry,character_id:'deepseek'}});const proposal=decode(await next);gate();const stale=decode(await old);assert.equal(stale.error.code,'request_cancelled');assert.equal(proposal.phase,'awaiting_confirmation');assert.equal(proposal.dialogue.draft.character_id,'deepseek');assert.equal(server.routes().filter(p=>p==='/client/v2/queue').length,0);
 await client.callTool({name:'arena_stop',arguments:{abandon:false}});assert.equal(decode(await client.callTool({name:'arena_confirm',arguments:{confirmation_id:proposal.dialogue.confirmation_id}})).error.code,'confirmation_stale');
});


test('cancelled entry request during HTTP preparation stops the owned runtime before queue/offer/ready',async t=>{
 const server=await fixture(t),dir=await directory(t),{client}=await open(t,server.origin,dir);await connect(client);const id=await propose(client),gate=server.holdPrepare(),cancel=new AbortController();
 const pending=client.callTool({name:'arena_confirm',arguments:{confirmation_id:id}},undefined,{signal:cancel.signal});const rejection=assert.rejects(pending);await gate.seen;cancel.abort();await rejection;
 await new Promise(r=>setTimeout(r,40));gate.release();await new Promise(r=>setTimeout(r,40));
 const state=decode(await client.callTool({name:'arena_status',arguments:{}}));assert.equal(state.active,false);assert.ok(!server.routes().some(p=>['/client/v2/queue','/client/v2/offer/accept','/client/v2/attempt/ready'].includes(p)));
});

test('existing waiting reservation exits directly without marking ready or claiming a game grant',async t=>{
 const server=await fixture(t),dir=await directory(t),{client}=await open(t,server.origin,dir);await connect(client);server.existing('waiting');
 const state=decode(await client.callTool({name:'arena_start',arguments:{}}));assert.equal(state.phase,'existing_game');const before=server.routes().length;
 const stopped=decode(await client.callTool({name:'arena_stop',arguments:{abandon:true}}));assert.equal(stopped.reservation_state,'released');assert.equal(stopped.exit_confirmed,true);
 const routes=server.routes().slice(before);assert.ok(routes.includes('/client/v2/withdraw'));assert.ok(!routes.some(p=>/queue|offer\/accept|attempt\/(?:claim|ready)/.test(p)));
});

test('stop during an outstanding form cancels it and stopped in-world tools trigger directory notification',async t=>{
 const server=await fixture(t),dir=await directory(t);let gate,arrived;const shown=new Promise(r=>arrived=r),{client}=await open(t,server.origin,dir,'stop-form',{capabilities:{form:{}},handler:async()=>{arrived();await new Promise(r=>gate=r);return {action:'accept',content:{confirmed:true}};}});
 await connect(client);const id=await propose(client),pending=client.callTool({name:'arena_confirm',arguments:{confirmation_id:id}});await shown;await client.callTool({name:'arena_stop',arguments:{abandon:false}});gate();assert.equal(decode(await pending).error.code,'request_cancelled');assert.ok(!server.routes().includes('/client/v2/queue'));
 await client.close();
 const second=await open(t,server.origin,dir,'stop-directory');await connect(second.client);const next=await propose(second.client);await second.client.callTool({name:'arena_confirm',arguments:{confirmation_id:next}});let notices=0;second.client.setNotificationHandler(ToolListChangedNotificationSchema,()=>notices++);
 const stopped=decode(await second.client.callTool({name:'arena_stop',arguments:{abandon:false}}));assert.equal(stopped.character_state,'still_in_world');assert.equal((await second.client.listTools()).tools.length,7);assert.ok(notices>0);
});


test('a terminal may be replayed directly without an intermediate status call',async t=>{
 const server=await fixture(t),dir=await directory(t),{client}=await open(t,server.origin,dir);await connect(client);const id=await propose(client),first=decode(await client.callTool({name:'arena_confirm',arguments:{confirmation_id:id}}));
 await client.callTool({name:'game_abandon',arguments:{}});
 const next=decode(await client.callTool({name:'arena_start',arguments:{reuse_previous:true}}));assert.equal(next.entry_state,'in_world');assert.notEqual(next.current_attempt.attempt_id,first.current_attempt.attempt_id);assert.equal(server.routes().filter(p=>p==='/client/v2/queue').length,2);await client.callTool({name:'arena_stop',arguments:{abandon:true}});
});
