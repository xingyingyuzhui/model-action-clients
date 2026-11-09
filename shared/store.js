import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
const failure = code => Object.assign(new Error(code), { code });
function ownRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw failure('store_permissions');
  return stat;
}

// Windows directory handles may not support FlushFileBuffers even after a
// write-capable open. Only that optional metadata flush may be unavailable.
// File contents must already be fsynced before rename and receipt ACK.
export function syncDirectory(directory, { platform = process.platform, io = fs } = {}) {
  let fd;
  try {
    fd = io.openSync(directory, platform === 'win32' ? 'r+' : 'r');
    io.fsyncSync(fd);
    return true;
  } catch (error) {
    if (platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code)) return false;
    throw error;
  } finally {
    if (fd !== undefined) io.closeSync(fd);
  }
}

// One instance owns one session's private file until close(). An exclusive lock
// prevents two harness sessions from racing a receipt or replacing each other's
// tokens. Existing locks fail closed, including apparently stale PID files:
// safely reclaiming a crashed process's lock requires an external ownership
// check. A read/PID-check/unlink sequence could delete a new owner's live lock.
export class AtomicStore {
  constructor(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw failure('invalid_store_path');
    this.file = file; this.lock = file + '.lock'; this.nonce = randomBytes(16).toString('hex');
    this.closed = false; this.chain = Promise.resolve();
    try {
      const directory = path.dirname(file);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw failure('store_permissions');
      fs.chmodSync(directory, 0o700);
      this.acquire();
      if (fs.existsSync(file)) { ownRegular(file); fs.chmodSync(file, 0o600); }
    } catch (error) {
      this.release();
      throw failure(['store_locked', 'store_permissions'].includes(error.code) ? error.code : 'store_unavailable');
    }
  }

  acquire() {
    let fd;
    try {
      fd = fs.openSync(this.lock, 'wx', 0o600);
      this.lockIdentity = fs.fstatSync(fd);
      this.ownsLock = true;
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: this.nonce }));
        fs.fsyncSync(fd);
      } catch (error) {
        this.release({ incomplete: true });
        throw error;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      ownRegular(this.lock);
      throw failure('store_locked');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  release({ incomplete = false } = {}) {
    if (!this.ownsLock) return;
    try {
      const stat = ownRegular(this.lock);
      if (stat.dev !== this.lockIdentity.dev || stat.ino !== this.lockIdentity.ino ||
          (!incomplete && JSON.parse(fs.readFileSync(this.lock, 'utf8')).nonce !== this.nonce)) throw failure('store_lock_changed');
      fs.unlinkSync(this.lock);
      this.ownsLock = false;
    } catch (error) {
      if (error.code === 'ENOENT') { this.ownsLock = false; return; }
      throw failure(error.code === 'store_lock_changed' ? error.code : 'store_lock_release_failed');
    }
  }

  assertOpen() { if (this.closed) throw failure('store_closed'); }

  async read() {
    await this.chain; this.assertOpen();
    try {
      if (!fs.existsSync(this.file)) return null;
      const stat = ownRegular(this.file);
      if (stat.size > MAX_BYTES) throw failure('store_corrupt');
      fs.chmodSync(this.file, 0o600);
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('store_corrupt');
      return value;
    } catch (error) { throw failure(['store_permissions', 'store_corrupt'].includes(error.code) || error instanceof SyntaxError ? (error instanceof SyntaxError ? 'store_corrupt' : error.code) : 'store_read_failed'); }
  }

  async readNativeMigration(origin, profileIds) {
    await this.chain; this.assertOpen(); this.nativeMigration = null;
    const file = this.file + '.native-access.local.json';
    let stat;
    try { stat = ownRegular(file); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    if ((stat.mode & 0o7777) !== 0o600) throw failure('store_permissions');
    if (stat.size > 16384) throw failure('native_migration_corrupt');
    let fd, raw, value;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o600) throw failure('store_permissions');
      const buffer = Buffer.alloc(16385), size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (size > 16384) throw failure('native_migration_corrupt');
      raw = buffer.subarray(0, size).toString('utf8');
      try { value = JSON.parse(raw); } catch { throw failure('native_migration_corrupt'); }
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    const plain = v => v && typeof v === 'object' && !Array.isArray(v);
    const id = value?.public_agent_id, grant = value?.grant;
    if (!plain(value) || Object.keys(value).some(k => !['schema_version','origin','public_agent_id','token','grant'].includes(k)) ||
        value.schema_version !== 1 || value.origin !== origin || typeof origin !== 'string' ||
        !/^agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id ?? '') ||
        typeof value.token !== 'string' || !/^model_beta_[A-Za-z0-9_-]{43}$/.test(value.token) ||
        !plain(grant) || !/^beta_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.id ?? '') ||
        !Number.isSafeInteger(grant.expires_at_ms) || grant.expires_at_ms <= Date.now() || grant.state !== 'active' || grant.max_concurrent_agents !== 1) throw failure('native_migration_corrupt');
    const saved = await this.read(), allowed = Array.isArray(profileIds) ? profileIds : profileIds instanceof Set ? [...profileIds] : [];
    if (saved?.schema_version !== 1 || saved.origin !== origin || !allowed.includes(id) || !Object.hasOwn(saved.profiles ?? {}, id) ||
        saved.profiles[id]?.public_agent_id !== id || saved.profiles[id]?.acked !== true || saved.profiles[id]?.unavailable) throw failure('native_migration_profile_mismatch');
    const result = { token:value.token, grant:{ id:grant.id, expires_at_ms:grant.expires_at_ms, state:grant.state, max_concurrent_agents:1 } };
    this.nativeMigration = { file, dev:stat.dev, ino:stat.ino, digest:createHash('sha256').update(raw).digest('hex'), result };
    return structuredClone(result);
  }

  async consumeNativeMigration() {
    await this.chain; this.assertOpen();
    const pending = this.nativeMigration; if (!pending) return false;
    // A failed main-store write must leave the private recovery sidecar intact.
    const saved = await this.read(), access = saved?.native_access;
    if (access?.token !== pending.result.token || access?.grant?.id !== pending.result.grant.id ||
        access?.grant?.expires_at_ms !== pending.result.grant.expires_at_ms || access?.grant?.state !== pending.result.grant.state || access?.grant?.max_concurrent_agents !== 1) throw failure('native_migration_not_committed');
    const stat = ownRegular(pending.file);
    if (stat.dev !== pending.dev || stat.ino !== pending.ino || (stat.mode & 0o7777) !== 0o600 || stat.size > 16384 ||
        createHash('sha256').update(fs.readFileSync(pending.file)).digest('hex') !== pending.digest) throw failure('native_migration_changed');
    fs.unlinkSync(pending.file);
    syncDirectory(path.dirname(pending.file));
    this.nativeMigration = null; return true;
  }

  write(value) {
    let encoded;
    try { encoded = JSON.stringify(value); } catch { return Promise.reject(failure('invalid_store_value')); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(encoded + '\n') > MAX_BYTES) return Promise.reject(failure('invalid_store_value'));
    const run = () => {
      this.assertOpen();
      const temporary = this.file + '.' + randomBytes(12).toString('hex') + '.tmp';
      let fd;
      try {
        if (fs.existsSync(this.file)) ownRegular(this.file);
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, encoded + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, this.file);
        syncDirectory(path.dirname(this.file));
      } catch (error) { throw failure(error.code === 'store_permissions' ? error.code : 'store_write_failed'); }
      finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    };
    const next = this.chain.then(run, run); this.chain = next.catch(() => {}); return next;
  }

  async close() { await this.chain; this.closed = true; this.release(); }
}
