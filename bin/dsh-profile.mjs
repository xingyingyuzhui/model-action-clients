import fs from "node:fs";
import path from "node:path";
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

export function lockProfile(profile) {
  const file = path.join(
    profile,
    ".dsh-local-plugins",
    "install",
    "profile.json",
  );
  try {
    return new AtomicStore(file);
  } catch (error) {
    throw failure(
      error.code === "store_locked" ? "profile_install_locked" : error.code,
    );
  }
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
