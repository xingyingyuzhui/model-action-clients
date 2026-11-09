import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clearLock, unlockSessions, inspectLock } from '../shared/lock-inspect.js';
import { AtomicStore } from '../shared/store.js';
import { privateStateAccess } from '../shared/credential-guard.js';

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
function layout(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-action-unlock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dsh = path.join(home, '.dsh', 'plugins', 'dsh-model-action', 'server');
  const mcp = path.join(home, '.model-action', 'mcp', 'server');
  fs.mkdirSync(dsh, { recursive: true }); fs.mkdirSync(mcp, { recursive: true });
  return { home, dsh, mcp };
}
const lock = (dir, name, body) => {
  const file = path.join(dir, name + '.json.lock');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  fs.writeFileSync(path.join(dir, name + '.json'), '{"private":"identity"}');
  return file;
};

test('only stale locks are cleared by default; unknown needs force; live ones and identity files are never touched', t => {
  const { dsh, mcp } = layout(t), host = os.hostname();
  const stale = lock(dsh, 'stale', { pid: deadPid(), host, nonce: 'n' });
  const live = lock(dsh, 'live', { pid: process.pid, host, nonce: 'n' });
  const foreign = lock(mcp, 'foreign', { pid: deadPid(), host: host + '-other', nonce: 'n' });
  const torn = lock(mcp, 'torn', '{"pid":');
  const roots = [path.dirname(dsh), path.dirname(mcp)];
  const preview = unlockSessions({ roots, dryRun: true });
  assert.equal(preview.filter(r => r.would_remove).length, 1);
  assert.ok(fs.existsSync(stale), 'dry run removes nothing');
  unlockSessions({ roots });
  assert.ok(!fs.existsSync(stale));
  for (const file of [live, foreign, torn]) assert.ok(fs.existsSync(file), file);
  unlockSessions({ roots, force: true });
  assert.ok(fs.existsSync(live), 'a running holder is never unlocked, even with --force');
  assert.ok(!fs.existsSync(foreign) && !fs.existsSync(torn));
  for (const name of ['stale', 'live', 'foreign', 'torn'])
    assert.ok(fs.existsSync(path.join(name === 'foreign' || name === 'torn' ? mcp : dsh, name + '.json')), 'identity file kept: ' + name);
});

test('a lock taken over between inspection and removal is left alone', t => {
  const { dsh } = layout(t);
  const file = lock(dsh, 'race', { pid: deadPid(), host: os.hostname(), nonce: 'old' });
  let calls = 0;
  const inspect = target => {
    if (++calls === 2) { fs.unlinkSync(target); fs.writeFileSync(target, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'new' })); }
    return inspectLock(target);
  };
  assert.equal(clearLock(file, { inspect }).removed, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, 'new');
});

test('after clearing a stale lock the session store opens again', async t => {
  const { dsh } = layout(t);
  const file = path.join(dsh, 'session.json');
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: deadPid(), host: os.hostname(), nonce: 'n' }), { mode: 0o600 });
  assert.throws(() => new AtomicStore(file), { code: 'store_locked' });
  assert.equal(clearLock(file + '.lock').removed, true);
  const store = new AtomicStore(file);
  await store.close();
});

test('the unlock command reports what it did and the model cannot run it', t => {
  const { home, dsh } = layout(t);
  const stale = lock(dsh, 'cli', { pid: deadPid(), host: os.hostname(), nonce: 'n' });
  const bin = fileURLToPath(new URL('../bin/unlock-sessions.mjs', import.meta.url));
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh') };
  const result = spawnSync(process.execPath, [bin], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已删除/);
  assert.ok(!fs.existsSync(stale));
  for (const command of ['npx model-action-unlock --force', 'node bin/unlock-sessions.mjs'])
    assert.ok(privateStateAccess({ name: 'bash', arguments: { command } }), command);
});
