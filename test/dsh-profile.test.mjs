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
} from "../bin/dsh-profile.mjs";

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
