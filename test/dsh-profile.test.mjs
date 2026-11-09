import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  readProfile,
  planProfile,
  commitProfile,
  backupProfile,
  lockProfile,
  lockFile,
  inspectLock,
  pruneInstallations,
} from "../bin/dsh-profile.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fixture(t, overlay) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "model-profile-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(profile, "package.json"),
    JSON.stringify({
      dependencies: {},
      model: { provider: "original" },
      dsh: { profile: { bundles: ["unrelated"] } },
    }),
  );
  if (overlay)
    fs.writeFileSync(path.join(profile, "cordis.patch.yml"), overlay);
  const current = path.join(profile, "node_modules", "dsh-model-action"),
    next = current + ".next";
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(next);
  fs.writeFileSync(path.join(current, "version"), "old");
  fs.writeFileSync(path.join(next, "version"), "new");
  const snapshot = readProfile(profile);
  const { updates } = planProfile(snapshot, {
    version: "fixture-version",
    archive: "fixture.tgz",
  });
  return { profile, current, next, snapshot, updates };
}

test("manual inserts become patches, retaining server, budgets, unrelated insertions and order", (t) => {
  const f = fixture(
    t,
    "- insert:\n    - id: other\n      name: another-plugin\n    - id: model-action-native\n      name: dsh-model-action\n      config:\n        serverUrl: http://127.0.0.1:9\n        maxToolCalls: 20\n        maxSeconds: 60\n- id: model-action-native\n  config:\n    maxContinuations: 4\n",
  );
  const overlay = parse(f.updates.get("cordis.patch.yml").toString());
  assert.deepEqual(
    overlay[0].insert.map((node) => node.id),
    ["other"],
  );
  assert.deepEqual(overlay[1], {
    id: "model-action-native",
    config: {
      serverUrl: "http://127.0.0.1:9",
      maxToolCalls: 20,
      maxSeconds: 60,
    },
  });
  assert.equal(overlay[2].config.maxContinuations, 4);
  const manifest = JSON.parse(f.updates.get("package.json"));
  assert.equal(manifest.model.provider, "original");
  assert.deepEqual(manifest.dsh.profile.bundles, [
    "unrelated",
    "dsh-model-action",
  ]);
});

test("concurrent changes abort before activating or overwriting a profile", async (t) => {
  const f = fixture(t),
    file = path.join(f.profile, "package.json");
  const external = JSON.parse(fs.readFileSync(file));
  external.model.provider = "new-user-selection";
  fs.writeFileSync(file, JSON.stringify(external));
  await assert.rejects(
    commitProfile({
      ...f,
      verify() {
        assert.fail("must not activate");
      },
    }),
    { code: "profile_changed_during_install" },
  );
  assert.equal(
    JSON.parse(fs.readFileSync(file)).model.provider,
    "new-user-selection",
  );
  assert.equal(fs.readFileSync(path.join(f.current, "version"), "utf8"), "old");
});

test("post-activation verification failure restores the original bundle and exact configuration", async (t) => {
  const f = fixture(t, "- id: unrelated\n  config: {}\n");
  await assert.rejects(
    commitProfile({
      ...f,
      verify() {
        throw Object.assign(new Error("fixture"), {
          code: "bundle_load_failed",
        });
      },
    }),
    { code: "bundle_load_failed" },
  );
  assert.equal(fs.readFileSync(path.join(f.current, "version"), "utf8"), "old");
  for (const [name, original] of f.snapshot) {
    const file = path.join(f.profile, name);
    if (original.content === null) assert.equal(fs.existsSync(file), false);
    else assert.deepEqual(fs.readFileSync(file), original.content);
  }
  assert.equal(
    fs
      .readdirSync(path.dirname(f.current))
      .some((name) => name.includes(".previous-")),
    false,
  );
});

test("rollback preserves externally edited files and reports recovery conflict", async (t) => {
  const f = fixture(t),
    file = path.join(f.profile, "package.json");
  await assert.rejects(
    commitProfile({
      ...f,
      verify() {
        fs.writeFileSync(file, '{"external":"preserve"}');
        throw new Error("fixture");
      },
    }),
    { code: "profile_recovery_conflict" },
  );
  assert.equal(fs.readFileSync(file, "utf8"), '{"external":"preserve"}');
  assert.equal(fs.readFileSync(path.join(f.current, "version"), "utf8"), "old");
});

test("an installer lock excludes a second installer and releases for retry", async (t) => {
  const f = fixture(t),
    first = lockProfile(f.profile);
  assert.throws(() => lockProfile(f.profile), {
    code: "profile_install_locked",
  });
  await first.close();
  const second = lockProfile(f.profile);
  await second.close();
});

test("an archived relative bundle symlink resolves after moving into the backup directory", (t) => {
  const f = fixture(t),
    runtime = path.join(f.profile, "isolated-runtime"),
    backup = path.join(f.profile, "backup");
  fs.renameSync(f.current, runtime);
  fs.mkdirSync(backup);
  fs.symlinkSync(
    process.platform === "win32"
      ? runtime
      : path.relative(path.dirname(f.current), runtime),
    f.current,
    process.platform === "win32" ? "junction" : "dir",
  );
  backupProfile(f.profile, f.snapshot, f.current, backup);
  const archived = path.join(backup, "installed-entry");
  assert.equal(fs.readFileSync(path.join(archived, "version"), "utf8"), "old");
  assert.equal(fs.realpathSync(archived), fs.realpathSync(runtime));
});

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const writeLock = (profile, body) => {
  const file = lockFile(profile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  return file;
};

test("lock inspection distinguishes running, stale, foreign and unreadable holders", (t) => {
  const f = fixture(t), file = lockFile(f.profile), host = os.hostname();
  assert.equal(inspectLock(file).state, "released");
  writeLock(f.profile, { pid: process.pid, host, nonce: "n" });
  assert.deepEqual(inspectLock(file), { state: "running", pid: process.pid });
  const dead = deadPid();
  writeLock(f.profile, { pid: dead, host, nonce: "n" });
  assert.deepEqual(inspectLock(file), { state: "stale", pid: dead });
  writeLock(f.profile, { pid: dead, nonce: "n" });
  assert.equal(inspectLock(file).state, "stale", "locks from older versions carry no host");
  writeLock(f.profile, { pid: dead, host: host + "-other", nonce: "n" });
  assert.equal(inspectLock(file).state, "unknown", "another machine's pid says nothing here");
  writeLock(f.profile, '{"pid":');
  assert.equal(inspectLock(file).state, "unknown");
});

test("a stale installer lock needs --force-unlock; a live installer is never unlocked", async (t) => {
  const f = fixture(t);
  const file = writeLock(f.profile, { pid: deadPid(), host: os.hostname(), nonce: "n" });
  assert.throws(() => lockProfile(f.profile), (error) =>
    error.code === "profile_install_locked" && error.holder === "stale" && error.lock_file === file);
  const recovered = lockProfile(f.profile, { forceUnlock: true });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  assert.throws(() => lockProfile(f.profile, { forceUnlock: true }), (error) =>
    error.code === "profile_install_locked" && error.holder === "running");
  await recovered.close();
  assert.ok(!fs.existsSync(file));
  writeLock(f.profile, "");
  assert.throws(() => lockProfile(f.profile), (error) => error.holder === "unknown");
  await lockProfile(f.profile, { forceUnlock: true }).close();
});

test("force unlock leaves a lock that was taken over between inspection and removal", (t) => {
  const f = fixture(t);
  const file = writeLock(f.profile, { pid: deadPid(), host: os.hostname(), nonce: "old" });
  let calls = 0;
  const inspect = (target) => {
    if (++calls === 2) {
      // Another installer replaces the stale lock right before removal.
      fs.unlinkSync(target);
      fs.writeFileSync(target, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: "new" }));
    }
    return inspectLock(target);
  };
  assert.throws(() => lockProfile(f.profile, { forceUnlock: true, inspect }), { code: "profile_install_locked" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nonce, "new");
});

test("pruning keeps the newest backups and everything they or the active bundle reference", (t) => {
  const f = fixture(t), local = path.join(f.profile, ".dsh-local-plugins"), modules = path.join(f.profile, "node_modules");
  const link = (target, at) => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
  const runtime = (name) => {
    const dir = path.join(local, "runtime-" + name, "node_modules", "dsh-model-action");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  for (const name of ["a", "b", "c", "d"]) {
    runtime(name);
    fs.writeFileSync(path.join(local, `dsh-model-action-0.0.${name}.tgz`), name);
  }
  fs.mkdirSync(path.join(local, "runtime-orphan"));
  const backup = (stamp, name) => {
    const dir = path.join(local, "backups", `model-action-${stamp}-x${name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), `overrides:\n  dsh-model-action: file:./.dsh-local-plugins/dsh-model-action-0.0.${name}.tgz\n`);
    link(path.join(local, "runtime-" + name, "node_modules", "dsh-model-action"), path.join(dir, "installed-entry"));
  };
  backup(1000, "a"); backup(2000, "b"); backup(3000, "c");
  fs.rmSync(f.current, { recursive: true, force: true });
  fs.rmSync(f.next, { recursive: true, force: true });
  link(path.join(local, "runtime-d", "node_modules", "dsh-model-action"), f.current);
  fs.writeFileSync(path.join(f.profile, "pnpm-workspace.yaml"), "overrides:\n  dsh-model-action: file:./.dsh-local-plugins/dsh-model-action-0.0.d.tgz\n");
  fs.mkdirSync(path.join(modules, "dsh-model-action.previous-1"));
  fs.mkdirSync(path.join(modules, ".model-action-next-1"));
  fs.mkdirSync(path.join(modules, "unrelated"));
  const result = pruneInstallations({ profile: f.profile, keep: [path.join(local, "runtime-d")] });
  const left = (dir) => fs.readdirSync(dir).sort();
  assert.deepEqual(left(path.join(local, "backups")), ["model-action-2000-xb", "model-action-3000-xc"]);
  assert.deepEqual(left(local).filter((n) => n.startsWith("runtime-")), ["runtime-b", "runtime-c", "runtime-d"]);
  assert.deepEqual(left(local).filter((n) => n.endsWith(".tgz")), ["dsh-model-action-0.0.b.tgz", "dsh-model-action-0.0.c.tgz", "dsh-model-action-0.0.d.tgz"]);
  assert.deepEqual(left(modules).filter((n) => n !== ".bin"), ["dsh-model-action", "unrelated"]);
  assert.equal(fs.realpathSync(f.current), fs.realpathSync(path.join(local, "runtime-d", "node_modules", "dsh-model-action")));
  assert.deepEqual(result.pending, []);
  assert.ok(result.removed.length >= 5);
  // Running again on a clean layout removes nothing.
  assert.deepEqual(pruneInstallations({ profile: f.profile, keep: [] }).removed, []);
});

test("installer explains a stale lock and how to recover", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "model-action-lock-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, "profiles", "desktop");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  const file = writeLock(profile, { pid: deadPid(), host: os.hostname(), nonce: "n" });
  const installer = fileURLToPath(new URL("../bin/install-dsh.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [installer, "--profile", "desktop"], {
    env: { ...process.env, DSH_HOME: home }, encoding: "utf8", timeout: 120000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /profile_install_locked/);
  assert.match(result.stderr, /--force-unlock/);
  assert.ok(result.stderr.includes(file));
  assert.equal(fs.readFileSync(path.join(profile, "package.json"), "utf8"), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
});
