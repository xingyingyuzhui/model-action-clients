// Lock files written by AtomicStore hold {pid, host, nonce}. A lock left by a
// process that was force-quit or lost power is never reclaimed automatically;
// these helpers let a person clear it explicitly. They read lock files only,
// never the identity files next to them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const processAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};

// "running": a live process on this machine. "stale": its process is gone.
// "unknown": unreadable, incomplete or written on another machine.
export function inspectLock(file, { alive = processAlive, host = os.hostname() } = {}) {
  let holder;
  try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? { state: 'released' } : { state: 'unknown' }; }
  const pid = Number.isSafeInteger(holder?.pid) && holder.pid > 0 ? holder.pid : null;
  if (pid === null) return { state: 'unknown' };
  if (typeof holder.host === 'string' && holder.host !== host) return { state: 'unknown', pid };
  return { state: alive(pid) ? 'running' : 'stale', pid };
}

// Remove one lock if allowed: stale always, unknown only with force, running
// never. The file is re-inspected and its identity re-checked right before
// removal, so a lock taken over by a new owner in the meantime is left alone.
export function clearLock(file, { force = false, dryRun = false, inspect = inspectLock } = {}) {
  const first = inspect(file);
  if (first.state === 'released') return { ...first, removed: false };
  if (first.state === 'running' || (first.state === 'unknown' && !force)) return { ...first, removed: false };
  if (dryRun) return { ...first, removed: false, would_remove: true };
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile()) return { ...first, removed: false };
    const again = inspect(file), after = fs.lstatSync(file);
    if (again.state === 'running' || (again.state === 'unknown' && !force) || after.ino !== before.ino || after.dev !== before.dev)
      return { ...again, removed: false };
    fs.unlinkSync(file);
    return { ...first, removed: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'released', removed: false };
    throw error;
  }
}

// Session locks live one directory below each root: <root>/<server hash>/<session hash>.json.lock
export function sessionLocks(root) {
  const found = [];
  let servers = [];
  try { servers = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const server of servers) {
    if (!server.isDirectory()) continue;
    const dir = path.join(root, server.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) if (name.endsWith('.json.lock')) found.push(path.join(dir, name));
  }
  return found;
}

export function unlockSessions({ roots, force = false, dryRun = false, inspect = inspectLock }) {
  return roots.flatMap(root => sessionLocks(root).map(file => ({ file, ...clearLock(file, { force, dryRun, inspect }) })));
}
