import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const executable = fileURLToPath(new URL('../packages/model-action-mcp/bin/model-action-mcp.mjs', import.meta.url));
const decode = result => JSON.parse(result.content[0].text);
const secret = 'private_fixture_secret_123456789';
async function fixture(t) {
  let approved = false, state = 'preparing', count = 0, currentAttempt = null, pairCalls = 0, cancelled = false, controlValid = true;
  const result = () => ({ outcome: 'abandoned', public_agent_id: 'agent_fixture', attempt_id: currentAttempt.id });
  const session = () => ({ state, connection: { state: 'connected' }, public_agent_id: state === 'preparing' ? null : 'agent_fixture', attempt: currentAttempt,
    ...(state === 'offered' ? { offer: { id: 'offer_fixture' } } : {}), ...(state === 'ended' ? { result: result() } : {}) });
  let origin;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    let value;
    if (['/client/v2/session', '/client/v2/heartbeat'].includes(req.url) && !controlValid) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ schema_version: 2, error: { code: 'unauthorized' } })); return;
    }
    switch (req.url) {
      case '/client/v2/pair/init': pairCalls++; value = { pairing_id: 'pair_fixture', device_secret: secret, user_code: 'ABCDEFGHIJ', expires_at_ms: Date.now() + 60000, poll_interval_ms: 2000 }; break;
      case '/client/v2/pair/poll': value = !approved ? { state: 'pending' } : body.receipt ? { state: 'connected' } : { state: 'awaiting_receipt', control_token: 'control_' + secret, receipt: 'receipt_' + secret, receipt_expires_at_ms: Date.now() + 60000 }; break;
      case '/client/v2/session': case '/client/v2/heartbeat': value = session(); break;
      case '/client/v2/prepare': state = 'ready'; currentAttempt = null; value = session(); break;
      case '/client/v2/profile/claim': value = body.receipt ? { state: 'acknowledged', public_agent_id: 'agent_fixture' } : { public_agent_id: 'agent_fixture', recovery_secret: 'recovery_' + secret, receipt: 'profile_' + secret }; break;
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
  return { origin, approve: () => { approved = true; controlValid = true; }, revoke: () => { approved = false; controlValid = false; }, pairs: () => pairCalls, cancelled: () => cancelled };
}
function stateFiles(dir) { return fs.readdirSync(dir, { recursive: true }).map(name => path.join(dir, name)).filter(p => fs.statSync(p).isFile()); }
async function open(t, origin, directory, session = 'test-agent') {
  const transport = new StdioClientTransport({ command: process.execPath, args: [executable, '--server-url', origin, '--session', session, '--state-dir', directory], stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'model-action-explicit-test-fixture', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, stderr: () => stderr };
}

test('official SDK stdio: pairing, dynamic game tools, authoritative terminal, next start and private lock cleanup', async t => {
  const server = await fixture(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-action-mcp-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { client, stderr } = await open(t, server.origin, directory);
  let notifications = 0; client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
  assert.equal(client.getServerVersion().name, 'model-action');
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['arena_start', 'arena_connect', 'arena_status', 'arena_stop']);
  const invalid = await client.callTool({ name: 'arena_start', arguments: { mode_id: 'extraction', room_id: 'br-1' } });
  assert.equal(decode(invalid).error.code, 'invalid_client_input'); assert.equal(server.pairs(), 0);
  const before = await client.callTool({ name: 'game_observe_compact', arguments: {} });
  assert.equal(decode(before).error.code, 'attempt_not_in_world');
  const unknown = await client.callTool({ name: 'invented_tool', arguments: {} });
  assert.equal(decode(unknown).error.code, 'unknown_tool');
  const start = await client.callTool({ name: 'arena_start', arguments: {} });
  assert.equal(decode(start).pairing.user_code, 'ABCDEFGHIJ'); assert.equal(decode(start).phase, 'pairing');
  assert.ok(!JSON.stringify(start).includes(secret));
  const file = stateFiles(directory).find(file => file.endsWith('.json'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.ok(fs.existsSync(file + '.lock'));
  server.approve();
  const status = decode(await client.callTool({ name: 'arena_status', arguments: {} }));
  assert.equal(status.entry_state, 'in_world');
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('game_observe_compact')); assert.ok(!names.includes('observe_compact')); assert.ok(notifications > 0);
  const observation = await client.callTool({ name: 'game_observe_compact', arguments: {} });
  assert.equal(decode(observation).self.hp, 100); assert.ok(!JSON.stringify(observation).includes(secret));
  const cancellation = new AbortController();
  const pending = client.callTool({ name: 'game_observe_compact', arguments: { slow: true } }, undefined, { signal: cancellation.signal });
  const rejected = assert.rejects(pending);
  await new Promise(resolve => setTimeout(resolve, 50)); cancellation.abort(); await rejected;
  for (let n = 0; n < 20 && !server.cancelled(); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(server.cancelled(), 'cancelled MCP request aborts the upstream HTTP request');
  assert.equal(decode(await client.callTool({ name: 'arena_status', arguments: {} })).entry_state, 'in_world');
  const forged = await client.callTool({ name: 'game_not_a_tool', arguments: {} });
  assert.equal(decode(forged).error.code, 'unknown_game_tool');
  await client.callTool({ name: 'game_abandon', arguments: {} });
  const ended = decode(await client.callTool({ name: 'arena_status', arguments: {} }));
  assert.equal(ended.entry_state, 'ended'); assert.equal(ended.result.outcome, 'abandoned');
  assert.equal((await client.listTools()).tools.length, 4);
  const next = decode(await client.callTool({ name: 'arena_start', arguments: {} }));
  assert.equal(next.entry_state, 'in_world'); assert.notEqual(next.current_attempt.attempt_id, status.current_attempt.attempt_id);
  const stopped = decode(await client.callTool({ name: 'arena_stop', arguments: { abandon: true } }));
  assert.equal(stopped.terminal_confirmed, true);
  await client.close();
  assert.ok(!fs.existsSync(file + '.lock')); assert.ok(!stderr().includes(secret));
});

test('stdio EOF/SIGTERM releases a session lock so the same identity can reconnect safely', async t => {
  const server = await fixture(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-action-mcp-reconnect-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = await open(t, server.origin, directory, 'persistent');
  await first.client.callTool({ name: 'arena_start', arguments: {} });
  const file = stateFiles(directory).find(file => file.endsWith('.json'));
  await first.client.close(); assert.ok(!fs.existsSync(file + '.lock'));
  const second = await open(t, server.origin, directory, 'persistent');
  const state = decode(await second.client.callTool({ name: 'arena_start', arguments: {} }));
  assert.equal(state.pairing.user_code, 'ABCDEFGHIJ'); assert.equal(server.pairs(), 1);
  await second.client.close(); assert.ok(!fs.existsSync(file + '.lock'));
});


test('revoked control lease is kept until confirmed, then a new explicit start requests fresh browser pairing', async t => {
  const server = await fixture(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-action-mcp-control-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { client } = await open(t, server.origin, directory, 'revoked-control');
  await client.callTool({ name: 'arena_start', arguments: {} }); server.approve();
  assert.equal(decode(await client.callTool({ name: 'arena_status', arguments: {} })).entry_state, 'in_world');
  server.revoke();
  const failed = decode(await client.callTool({ name: 'arena_status', arguments: {} }));
  assert.equal(failed.phase, 'error'); assert.equal(failed.active, false); assert.equal(failed.last_error.status, 401);
  const file = stateFiles(directory).find(file => file.endsWith('.json'));
  assert.ok(JSON.parse(fs.readFileSync(file)).control, 'old authorization is retained after 401 until explicit retry');
  const retry = decode(await client.callTool({ name: 'arena_start', arguments: {} }));
  assert.equal(retry.phase, 'pairing'); assert.equal(retry.entry_state, null); assert.equal(retry.pairing.user_code, 'ABCDEFGHIJ');
  assert.equal(server.pairs(), 2); assert.equal(JSON.parse(fs.readFileSync(file)).control, null);
  assert.ok(!JSON.stringify(retry).includes(secret));
});
