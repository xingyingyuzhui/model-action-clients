import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaRuntime, EARLY_RETURN_TIP, LONG_HOLD_TIP, supportsEarlyReturn, maxHoldMs } from '../shared/runtime.js';
import { McpDialogue } from '../shared/mcp-dialogue.js';

const step = properties => ({ name: 'step', inputSchema: { type: 'object', properties } });

test('early return is advertised only when the server step schema declares return_after_ms', () => {
  assert.equal(supportsEarlyReturn([step({ input: {}, return_after_ms: { type: 'number' } })]), true);
  assert.equal(supportsEarlyReturn([step({ input: {} })]), false, 'older server');
  assert.equal(supportsEarlyReturn([{ name: 'observe', inputSchema: { properties: { return_after_ms: {} } } }]), false);
  assert.equal(supportsEarlyReturn(null), false);
  const hint = ArenaRuntime.prototype.gameplayHint;
  assert.equal(hint.call({ tools: null }), null, 'no tool list yet');
  assert.equal(hint.call({ tools: [step({ return_after_ms: {} })] }), EARLY_RETURN_TIP);
  assert.match(EARLY_RETURN_TIP, /return_after_ms 300~500/);
  assert.match(EARLY_RETURN_TIP, /hold_ms 设为 1000/);
});

test('MCP status adds the game_step hint while in the world', () => {
  let hint = EARLY_RETURN_TIP, entry = 'in_world';
  const runtime = { client: {}, active: true, state: () => ({ active: true, phase: 'in_world', entry_state: entry }), gameplayHint: () => hint };
  const dialogue = new McpDialogue(runtime, { serverUrl: 'https://arena.test', version: 'test', clock: () => 1000 });
  let view = dialogue.view();
  assert.ok(view.instructions.some(text => text.includes('调用 game_step') && text.includes('return_after_ms')));
  hint = null; view = dialogue.view();
  assert.ok(!view.instructions.some(text => text.includes('return_after_ms')), 'older server');
  hint = EARLY_RETURN_TIP; entry = 'waiting'; view = dialogue.view();
  assert.ok(!view.instructions.some(text => text.includes('return_after_ms')), 'not in the world yet');
});

test('servers that accept long holds get the long-hold advice; older ones keep the 1 s advice', () => {
  const longHold = { input: { type: 'object', properties: { hold_ms: { type: 'number', minimum: 100, maximum: 5000 } } }, return_after_ms: { type: 'number' } };
  const shortHold = { input: { type: 'object', properties: { hold_ms: { type: 'number', description: '100–1000ms' } } }, return_after_ms: { type: 'number' } };
  assert.equal(maxHoldMs([step(longHold)]), 5000);
  assert.equal(maxHoldMs([step(shortHold)]), null, 'rules 0.6 schemas declare no maximum');
  const hint = ArenaRuntime.prototype.gameplayHint;
  assert.equal(hint.call({ tools: [step(longHold)] }), LONG_HOLD_TIP);
  assert.equal(hint.call({ tools: [step(shortHold)] }), EARLY_RETURN_TIP);
  assert.match(LONG_HOLD_TIP, /3000~5000/);
  assert.match(LONG_HOLD_TIP, /return_after_ms 300~500/);
  assert.match(LONG_HOLD_TIP, /调用 step/, 'MCP rewrites this prefix to game_step');
});
