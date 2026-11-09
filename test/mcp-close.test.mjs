import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelActionBridge } from '../packages/model-action-mcp/server.js';

test('MCP bridge close retries a failed lock release and completes idempotently', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-mcp-close-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const bridge = createModelActionBridge({ serverUrl: 'http://127.0.0.1:9', stateDir });
  const fault = t.mock.method(fs, 'unlinkSync', () => { throw Object.assign(new Error('fixture'), { code: 'EPERM' }); });
  try { await assert.rejects(bridge.close(), { code: 'store_lock_release_failed' }); }
  finally { fault.mock.restore(); }
  await bridge.close(); await bridge.close();
  assert.equal(fs.existsSync(bridge.stateFile + '.lock'), false);
});
