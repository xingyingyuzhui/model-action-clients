import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtomicStore, syncDirectory } from '../shared/store.js';
import { ArenaClient } from '../shared/client.js';

const failure = code => Object.assign(new Error(code), { code });
function directoryIo({ openError, syncError } = {}) {
  const calls = [];
  return {
    calls,
    openSync(directory, flags) { calls.push(['open', directory, flags]); if (openError) throw failure(openError); return 42; },
    fsyncSync(fd) { calls.push(['fsync', fd]); if (syncError) throw failure(syncError); },
    closeSync(fd) { calls.push(['close', fd]); },
  };
}

test('directory sync requests write access on Windows and closes supported handles', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const io = directoryIo();
    assert.equal(syncDirectory('/private/state', { platform, io }), true);
    assert.deepEqual(io.calls, [['open', '/private/state', platform === 'win32' ? 'r+' : 'r'], ['fsync', 42], ['close', 42]]);
  }
});

test('only unsupported Windows directory sync falls back and opened handles are closed', () => {
  for (const code of ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP']) {
    for (const stage of ['openError', 'syncError']) {
      const io = directoryIo({ [stage]: code });
      assert.equal(syncDirectory('/private/state', { platform: 'win32', io }), false);
      assert.equal(io.calls.filter(call => call[0] === 'close').length, stage === 'syncError' ? 1 : 0);
    }
  }
});

test('directory sync propagates real errors and all POSIX failures', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const code of platform === 'win32' ? ['EIO', 'EACCES', 'ENOSPC', 'EBADF'] : ['EPERM', 'EIO', 'EINVAL', 'ENOTSUP']) {
      for (const stage of ['openError', 'syncError']) {
        const io = directoryIo({ [stage]: code });
        assert.throws(() => syncDirectory('/private/state', { platform, io }), { code });
        assert.equal(io.calls.filter(call => call[0] === 'close').length, stage === 'syncError' ? 1 : 0);
      }
    }
  }
});

test('native platform persists consecutive states, reopens and releases its session lock', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-store-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'private', 'session.json');
  const store = new AtomicStore(file);
  try {
    for (let revision = 1; revision <= 3; revision++) {
      await store.write({ schema_version: 1, revision });
      assert.deepEqual(await store.read(), { schema_version: 1, revision });
    }
  } finally { await store.close(); }
  assert.equal(fs.existsSync(file + '.lock'), false);
  const reopened = new AtomicStore(file);
  try { assert.equal((await reopened.read()).revision, 3); }
  finally { await reopened.close(); }
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('file fsync and rename failures reject without replacing the prior state and retries recover', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-store-file-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.json'), store = new AtomicStore(file);
  try {
    await store.write({ revision: 1 });
    for (const method of ['fsyncSync', 'renameSync']) {
      const fault = t.mock.method(fs, method, () => { throw failure('EPERM'); });
      try { await assert.rejects(store.write({ revision: 2 }), { code: 'store_write_failed' }); }
      finally { fault.mock.restore(); }
      assert.deepEqual(await store.read(), { revision: 1 });
      assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
    }
    await store.write({ revision: 3 });
    assert.deepEqual(await store.read(), { revision: 3 });
  } finally { await store.close(); }
});

test('native authorization persists through the real file store and reconnects after reopen', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-store-native-connect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.json');
  const access = 'model_beta_' + 'a'.repeat(43), control = 'control_' + 'c'.repeat(32);
  const fetcher = async url => {
    const route = new URL(url).pathname;
    if (route === '/client/v2/access/connect') return new Response(JSON.stringify({
      schema_version: 2, access_token: access, control_token: control,
      grant: { id: 'beta_fixture', state: 'active', expires_at_ms: Date.now() + 60000, max_concurrent_agents: 1 },
      session: { state: 'preparing' },
    }));
    assert.equal(route, '/client/v2/session');
    return new Response(JSON.stringify({ schema_version: 2, state: 'preparing' }));
  };
  let store = new AtomicStore(file);
  try {
    let client = new ArenaClient({ serverUrl: 'https://arena.test', store, fetcher });
    assert.equal((await client.connectNative({ ticket: 'fixture_invitation' })).state, 'connected');
    const saved = await store.read();
    assert.equal(saved.control.acked, true);
    assert.equal(saved.native_access.token, access);
    await store.close();
    store = new AtomicStore(file);
    client = new ArenaClient({ serverUrl: 'https://arena.test', store, fetcher });
    assert.equal((await client.connectNative()).state, 'connected');
    assert.equal((await store.read()).control.acked, true);
  } finally { await store.close(); }
  assert.equal(fs.existsSync(file + '.lock'), false);
});
