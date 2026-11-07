import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
const failure = code => Object.assign(new Error(code), { code });
function ownRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw failure('store_permissions');
  return stat;
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
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: this.nonce }));
      fs.fsyncSync(fd); this.ownsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      ownRegular(this.lock);
      throw failure('store_locked');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  release() {
    if (!this.ownsLock) return;
    try { if (JSON.parse(fs.readFileSync(this.lock, 'utf8')).nonce === this.nonce) fs.unlinkSync(this.lock); } catch { /* Never remove a lock whose ownership cannot be verified. */ }
    this.ownsLock = false;
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
        const directory = fs.openSync(path.dirname(this.file), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } catch (error) { throw failure(error.code === 'store_permissions' ? error.code : 'store_write_failed'); }
      finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    };
    const next = this.chain.then(run, run); this.chain = next.catch(() => {}); return next;
  }

  async close() { await this.chain; if (this.closed) return; this.closed = true; this.release(); }
}
