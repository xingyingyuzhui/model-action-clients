import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { parseDocument, isMap, isSeq } from "yaml";
import { AtomicStore, syncDirectory } from "../lib/store.js";

export const profileFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "cordis.patch.yml",
];
export const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
export const failure = (code) => Object.assign(new Error(code), { code });
const bytes = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);
const same = (a, b) => (a === null || b === null ? a === b : a.equals(b));

export function readProfile(profile) {
  return new Map(
    profileFiles.map((name) => {
      const file = path.join(profile, name);
      return [
        name,
        {
          content: bytes(file),
          mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600,
        },
      ];
    }),
  );
}

export function assertUnchanged(profile, snapshot) {
  for (const [name, value] of snapshot) {
    if (!same(bytes(path.join(profile, name)), value.content))
      throw failure("profile_changed_during_install");
  }
}

function normalizeOverlay(content) {
  if (!content) return null;
  const document = parseDocument(content.toString());
  if (
    document.errors.length ||
    (document.contents && !isSeq(document.contents))
  )
    throw failure("invalid_profile_overlay");
  let changed = false;
  const items = document.contents?.items ?? [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item?.get?.("id") === "aea-native") {
      item.set("id", "model-action-native");
      changed = true;
    }
    if (item?.get?.("id") === "model-action-native" && item.has("name")) {
      if (!["dsh-model-action", "dsh-aea"].includes(item.get("name")))
        throw failure("conflicting_native_overlays");
      item.delete("name");
      changed = true;
    }
    const inserted = item?.get?.("insert")?.items;
    if (!Array.isArray(inserted)) continue;
    const patches = [];
    for (let child = inserted.length - 1; child >= 0; child--) {
      const node = inserted[child],
        id = node?.get?.("id"),
        name = node?.get?.("name");
      if (
        !["model-action-native", "aea-native"].includes(id) &&
        !["dsh-model-action", "dsh-aea"].includes(name)
      )
        continue;
      if (name && !["dsh-model-action", "dsh-aea"].includes(name))
        throw failure("conflicting_native_overlays");
      const patch = node.clone();
      patch.set("id", "model-action-native");
      patch.delete("name");
      patches.unshift(patch);
      inserted.splice(child, 1);
      changed = true;
    }
    if (!patches.length) continue;
    if (inserted.length === 0) {
      items.splice(index, 1, ...patches);
      index += patches.length - 1;
    } else {
      items.splice(index + 1, 0, ...patches);
      index += patches.length;
    }
  }
  return changed ? Buffer.from(document.toString()) : content;
}

export function planProfile(
  snapshot,
  { version, archive, replaceLegacy = false },
) {
  const raw = snapshot.get("package.json").content;
  if (!raw) throw failure("profile_missing");
  let manifest;
  try {
    manifest = JSON.parse(raw.toString().replace(/^\uFEFF/, ""));
  } catch {
    throw failure("invalid_profile_json");
  }
  if (!Array.isArray(manifest.dsh?.profile?.bundles))
    throw failure("invalid_profile_bundles");
  const legacy =
    Object.hasOwn(manifest.dependencies ?? {}, "dsh-aea") ||
    manifest.dsh.profile.bundles.includes("dsh-aea");
  if (legacy && !replaceLegacy) throw failure("legacy_plugin_present");
  manifest.dependencies ??= {};
  if (legacy) {
    delete manifest.dependencies["dsh-aea"];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
      (name) => name !== "dsh-aea",
    );
  }
  manifest.dependencies["dsh-model-action"] = version;
  manifest.dsh.profile.bundles = [
    ...new Set([...manifest.dsh.profile.bundles, "dsh-model-action"]),
  ];
  const workspace = parseDocument(
    snapshot.get("pnpm-workspace.yaml").content?.toString() ?? "",
  );
  if (
    workspace.errors.length ||
    (workspace.contents && !isMap(workspace.contents))
  )
    throw failure("invalid_profile_workspace");
  if (legacy && workspace.contents)
    workspace.deleteIn(["overrides", "dsh-aea"]);
  workspace.setIn(
    ["overrides", "dsh-model-action"],
    `file:./.dsh-local-plugins/${archive}`,
  );
  const updates = new Map([
    ["package.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")],
    ["pnpm-workspace.yaml", Buffer.from(workspace.toString())],
  ]);
  const overlay = normalizeOverlay(snapshot.get("cordis.patch.yml").content);
  if (overlay && !same(overlay, snapshot.get("cordis.patch.yml").content))
    updates.set("cordis.patch.yml", overlay);
  return { updates, legacy };
}

export function writeAtomic(file, content, mode = 0o600) {
  const temporary = file + "." + randomUUID() + ".tmp";
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export const lockFile = (profile) =>
  path.join(profile, ".dsh-local-plugins", "install", "profile.json.lock");

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Who holds an installer lock. "running": a live process on this machine.
// "stale": its process is gone, e.g. the installer was killed or the machine
// lost power. "unknown": unreadable, incomplete or written on another machine.
export function inspectLock(file, { alive = processAlive, host = os.hostname() } = {}) {
  let holder;
  try {
    holder = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { state: "released" };
    return { state: "unknown" };
  }
  const pid = Number.isSafeInteger(holder?.pid) && holder.pid > 0 ? holder.pid : null;
  if (pid === null) return { state: "unknown" };
  if (typeof holder.host === "string" && holder.host !== host)
    return { state: "unknown", pid };
  return { state: alive(pid) ? "running" : "stale", pid };
}

const lockedFailure = (file, inspected) =>
  Object.assign(failure("profile_install_locked"), {
    lock_file: file,
    holder: inspected.state,
    ...(inspected.pid ? { pid: inspected.pid } : {}),
  });

export function lockProfile(profile, { forceUnlock = false, inspect = inspectLock } = {}) {
  const store = path.join(profile, ".dsh-local-plugins", "install", "profile.json");
  const open = () => new AtomicStore(store);
  try {
    return open();
  } catch (error) {
    if (error.code !== "store_locked") throw failure(error.code);
  }
  const file = lockFile(profile),
    inspected = inspect(file);
  // A live installer is never interrupted, even with --force-unlock. Anything
  // else needs the person's explicit request: only they can rule out another
  // machine sharing this profile directory.
  if (!forceUnlock || inspected.state === "running")
    throw lockedFailure(file, inspected);
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile()) throw failure("profile_install_locked");
    // Re-check the same file right before removal so a lock taken over by a
    // new installer in the meantime is left alone.
    const again = inspect(file),
      after = fs.lstatSync(file);
    if (again.state === "running" || after.ino !== before.ino || after.dev !== before.dev)
      throw lockedFailure(file, again);
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error.code ? error : lockedFailure(file, inspected);
  }
  try {
    return open();
  } catch (error) {
    if (error.code === "store_locked") throw lockedFailure(file, inspect(file));
    throw failure(error.code);
  }
}

// Every install keeps an immutable runtime, a backup and the packed archive.
// After a successful commit, keep the newest backups and whatever the active
// bundle or those backups still reference; delete the rest. Failures here never
// undo a committed install: they are reported for a later run to retry.
export function pruneInstallations({ profile, keepBackups = 2, keep = [] }) {
  const local = path.join(profile, ".dsh-local-plugins"),
    backups = path.join(local, "backups"),
    modules = path.join(profile, "node_modules"),
    current = path.join(modules, "dsh-model-action");
  const removed = [],
    pending = [];
  const remove = (target) => {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(path.relative(profile, target));
    } catch {
      pending.push(path.relative(profile, target));
    }
  };
  const directories = (dir, pattern) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => pattern.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))
        .map((entry) => entry.name);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  // Backup names start with the creation time in milliseconds.
  const stamp = (name) => Number(/^model-action-(\d+)/.exec(name)?.[1] ?? 0);
  const ordered = directories(backups, /^model-action-\d+/).sort(
    (a, b) => stamp(b) - stamp(a) || (a < b ? 1 : -1),
  );
  const kept = ordered.slice(0, keepBackups).map((name) => path.join(backups, name));
  for (const name of ordered.slice(keepBackups)) remove(path.join(backups, name));

  const runtimes = new Set(),
    archives = new Set();
  const runtimeOf = (target) => {
    try {
      const relative = path.relative(fs.realpathSync(local), fs.realpathSync(target));
      const first = relative.split(path.sep)[0];
      if (first && !relative.startsWith("..") && first.startsWith("runtime-")) runtimes.add(first);
    } catch {
      /* A dangling link references nothing that still exists. */
    }
  };
  const archivesOf = (workspace) => {
    try {
      for (const match of fs.readFileSync(workspace, "utf8").matchAll(/\.dsh-local-plugins\/([^\s'"]+\.tgz)/g))
        archives.add(match[1]);
    } catch {
      /* No workspace file, so no archive reference. */
    }
  };
  for (const target of keep) runtimeOf(target);
  if (exists(current)) runtimeOf(current);
  archivesOf(path.join(profile, "pnpm-workspace.yaml"));
  for (const backup of kept) {
    const entry = path.join(backup, "installed-entry");
    if (exists(entry)) runtimeOf(entry);
    archivesOf(path.join(backup, "pnpm-workspace.yaml"));
  }
  // Windows installs copy the bundle, so nothing links back to a runtime.
  // Keep the newest runtimes as well, one per retained backup, so the previous
  // install stays intact on every platform.
  const age = (name) => {
    try {
      return fs.statSync(path.join(local, name)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const allRuntimes = directories(local, /^runtime-/).sort((a, b) => age(b) - age(a));
  for (const name of allRuntimes.slice(0, keepBackups)) runtimes.add(name);
  for (const name of allRuntimes)
    if (!runtimes.has(name)) remove(path.join(local, name));
  let files = [];
  try {
    files = fs.readdirSync(local).filter((name) => /^dsh-model-action-.+\.tgz$/.test(name));
  } catch {
    /* Nothing to prune. */
  }
  for (const name of files) if (!archives.has(name)) remove(path.join(local, name));
  // Leftovers of earlier interrupted or partially cleaned installs.
  for (const name of directories(modules, /^(?:dsh-model-action\.previous-|\.model-action-next-)/))
    remove(path.join(modules, name));
  return { removed, pending };
}

export function backupProfile(profile, snapshot, current, backup) {
  for (const [name, value] of snapshot)
    if (value.content !== null)
      fs.writeFileSync(path.join(backup, name), value.content, { mode: 0o600 });
  if (!exists(current)) return;
  const stat = fs.lstatSync(current),
    archived = path.join(backup, "installed-entry");
  if (stat.isSymbolicLink()) {
    // An absolute target remains valid after moving the backup. The runtime is
    // immutable and retained, so this does not depend on the link's old parent.
    fs.symlinkSync(
      fs.realpathSync(current),
      archived,
      process.platform === "win32" ? "junction" : "dir",
    );
  } else
    fs.cpSync(current, archived, { recursive: true, verbatimSymlinks: true });
}

export async function commitProfile({
  profile,
  snapshot,
  updates,
  current,
  next,
  verify,
}) {
  const previous = current + ".previous-" + randomUUID();
  const written = new Map();
  let archived = false,
    activated = false;
  try {
    assertUnchanged(profile, snapshot);
    if (exists(current)) {
      fs.renameSync(current, previous);
      archived = true;
    }
    fs.renameSync(next, current);
    activated = true;
    for (const [name, content] of updates) {
      const file = path.join(profile, name),
        original = snapshot.get(name);
      if (!same(bytes(file), original.content))
        throw failure("profile_changed_during_install");
      // Track ownership before writing, including a failure after rename/fsync.
      written.set(name, content);
      writeAtomic(file, content, original.mode);
    }
    await verify(current);
    for (const [name, original] of snapshot) {
      if (
        !same(
          bytes(path.join(profile, name)),
          updates.get(name) ?? original.content,
        )
      )
        throw failure("profile_changed_during_install");
    }
  } catch (error) {
    let conflict = false;
    try {
      for (const [name, content] of written) {
        const file = path.join(profile, name),
          original = snapshot.get(name);
        if (same(bytes(file), original.content)) continue;
        if (!same(bytes(file), content)) {
          conflict = true;
          continue;
        }
        if (original.content === null) fs.unlinkSync(file);
        else writeAtomic(file, original.content, original.mode);
      }
      if (activated) fs.rmSync(current, { recursive: true, force: true });
      if (archived) fs.renameSync(previous, current);
    } catch {
      throw failure("profile_recovery_unverified");
    }
    if (conflict) throw failure("profile_recovery_conflict");
    throw error;
  }
  if (archived) {
    try {
      fs.rmSync(previous, { recursive: true, force: true });
    } catch {
      return { cleanupPending: previous };
    }
  }
  return { cleanupPending: null };
}
