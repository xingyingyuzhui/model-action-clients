#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { placeDshBundle } from "./place-dsh-bundle.mjs";
import {
  sha256,
  packageManifest,
  verifyBundle,
  treeManifest,
  verifyContents,
} from "./dsh-bundle.mjs";
import {
  exists,
  failure,
  readProfile,
  planProfile,
  assertUnchanged,
  lockProfile,
  backupProfile,
  commitProfile,
  writeAtomic,
} from "./dsh-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const args = process.argv.slice(2),
  profiles = [];
const dryRun = args.includes("--dry-run"),
  replaceLegacy = args.includes("--replace-legacy");
let diagnosticLog;
const progress = (message) =>
  process.stderr.write("Model行动 " + message + "\n");

function npmCommand() {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  const cli = candidates.find(
    (file) =>
      file &&
      path.isAbsolute(file) &&
      path.basename(file) === "npm-cli.js" &&
      fs.existsSync(file),
  );
  if (cli) return [process.execPath, cli];
  if (process.platform === "win32")
    throw failure("windows_install_requires_npx");
  return ["npm"];
}

function runNpm(command, arguments_, cwd, timeout) {
  const result = spawnSync(command[0], [...command.slice(1), ...arguments_, "--prefix", cwd, "--workspaces=false", "--global=false"], {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: "" },
  });
  fs.appendFileSync(
    diagnosticLog,
    "\n" + arguments_[0] + "\n" + (result.stdout ?? "") + (result.stderr ?? ""),
    { mode: 0o600 },
  );
  if (result.status !== 0)
    throw failure(
      result.error?.code === "ETIMEDOUT"
        ? "npm_timeout"
        : arguments_[0] === "pack"
          ? "native_package_pack_failed"
          : "profile_install_failed",
    );
  return result.stdout;
}

async function releaseLock(lock) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await lock.close();
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function installProfile(profileName, home, packed, command) {
  const profile = path.join(home, "profiles", profileName);
  if (!fs.existsSync(path.join(profile, "package.json")))
    throw failure("profile_missing");
  const lock = lockProfile(profile);
  let report, next;
  try {
    const snapshot = readProfile(profile);
    const archive = `dsh-model-action-${pkg.version}-${packed.hash.slice(0, 16)}.tgz`;
    const plan = planProfile(snapshot, {
      version: pkg.version,
      archive,
      replaceLegacy,
    });
    const local = path.join(profile, ".dsh-local-plugins");
    const backups = path.join(local, "backups");
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    const backup = fs.mkdtempSync(
      path.join(backups, "model-action-" + Date.now() + "-"),
    );
    diagnosticLog = path.join(backup, "install.private.log");
    fs.writeFileSync(diagnosticLog, "", { mode: 0o600 });
    const current = path.join(profile, "node_modules", "dsh-model-action");
    backupProfile(profile, snapshot, current, backup);
    if (exists(current) && !fs.lstatSync(current).isSymbolicLink())
      verifyContents(
        path.join(backup, "installed-entry"),
        treeManifest(current),
      );
    const archivePath = path.join(local, archive);
    if (exists(archivePath)) {
      if (sha256(archivePath) !== packed.hash)
        throw failure("cached_archive_mismatch");
    } else writeAtomic(archivePath, fs.readFileSync(packed.source));
    if (sha256(archivePath) !== packed.hash)
      throw failure("cached_archive_mismatch");
    // Each attempt owns an immutable runtime. Reinstalling cannot modify the
    // active package or a prior backup through a shared content-addressed path.
    const runtime = fs.mkdtempSync(
      path.join(local, "runtime-" + packed.hash.slice(0, 16) + "-"),
    );
    fs.writeFileSync(
      path.join(runtime, "package.json"),
      JSON.stringify({
        name: "model-action-local-runtime",
        private: true,
        dependencies: { "dsh-model-action": "file:" + archivePath },
      }),
    );
    progress(`${profileName} 正在安装隔离依赖`);
    runNpm(
      command,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      runtime,
      180000,
    );
    const staged = path.join(runtime, "node_modules", "dsh-model-action");
    progress(`${profileName} 正在校验文件和实际加载`);
    verifyContents(staged, packed.manifest);
    assertUnchanged(profile, snapshot);
    fs.mkdirSync(path.dirname(current), { recursive: true });
    next = fs.mkdtempSync(
      path.join(path.dirname(current), ".model-action-next-"),
    );
    fs.rmdirSync(next);
    placeDshBundle({ runtime, staged, current: next });
    verifyBundle(next, packed.manifest, diagnosticLog);
    const committed = await commitProfile({
      profile,
      snapshot,
      updates: plan.updates,
      current,
      next,
      verify: (directory) =>
        verifyBundle(directory, packed.manifest, diagnosticLog),
    });
    report = {
      profile: profileName,
      version: pkg.version,
      exact_pin: pkg.version,
      runtime,
      backup,
      verified: true,
      registered_tools: 8,
      isolated_bundle_runtime: true,
      host_app_unchanged: true,
      ...(committed.cleanupPending
        ? { cleanup_pending: committed.cleanupPending }
        : {}),
    };
  } finally {
    try {
      if (next && exists(next))
        fs.rmSync(next, { recursive: true, force: true });
    } finally {
      await releaseLock(lock);
    }
  }
  process.stdout.write(JSON.stringify(report) + "\n");
}

async function main() {
  if (args.includes("--help")) {
    process.stdout.write(
      "model-action-install-dsh --profile <existing-profile> [--dry-run] [--replace-legacy]\n",
    );
    return;
  }
  for (let index = 0; index < args.length; index++) {
    if (["--dry-run", "--replace-legacy"].includes(args[index])) continue;
    if (
      args[index] !== "--profile" ||
      !/^[a-zA-Z0-9_-]{1,60}$/.test(args[index + 1] ?? "")
    )
      throw failure("invalid_profile_argument");
    profiles.push(args[++index]);
  }
  if (!profiles.length) throw failure("profile_required");
  const home = path.resolve(
    process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"),
  );
  for (const profileName of [...new Set(profiles)]) {
    const profile = path.join(home, "profiles", profileName);
    const plan = planProfile(readProfile(profile), {
      version: pkg.version,
      archive: "preview.tgz",
      replaceLegacy,
    });
    if (dryRun)
      process.stdout.write(
        JSON.stringify({
          profile: profileName,
          package: pkg.name,
          version: pkg.version,
          replaceLegacy: plan.legacy,
          changes_applied: false,
        }) + "\n",
      );
  }
  if (dryRun) return;
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "model-action-pack-"),
  );
  diagnosticLog = path.join(temporary, "pack.private.log");
  fs.writeFileSync(diagnosticLog, "", { mode: 0o600 });
  let completed = false;
  try {
    const command = npmCommand();
    progress("正在读取安装包");
    const [packed] = JSON.parse(
      runNpm(
        command,
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
        root,
        60000,
      ),
    );
    const source = path.join(temporary, packed.filename);
    const bundle = {
      source,
      hash: sha256(source),
      manifest: packageManifest(root, packed.files),
    };
    for (const profile of [...new Set(profiles)])
      await installProfile(profile, home, bundle, command);
    completed = true;
  } finally {
    if (completed) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const messages = {
    profile_changed_during_install:
      "安装期间配置发生变化，已中止提交，请关闭其他配置编辑或安装操作后重试。",
    profile_install_locked: "该 profile 正在被安装器占用，请等待已有安装结束。",
    installed_file_mismatch: "文件内容校验失败，请检查文件转换或安全软件策略。",
    bundle_load_failed: "插件或依赖未能通过真实加载验证，请查看排障日志。",
    profile_recovery_conflict:
      "回滚时发现外部配置修改，已保留外部内容，请结合备份检查配置。",
    profile_recovery_unverified: "自动回滚未完成，请保留备份和排障日志。",
    npm_timeout: "依赖操作超时，请检查网络连接后重试。",
    legacy_plugin_present: "检测到旧插件，请使用 --replace-legacy 备份并替换。",
    invalid_profile_json:
      "profile 的 package.json 不是有效 JSON，请先修复配置。",
  };
  const code = error.code ?? "installation_failed";
  process.stderr.write(
    "Model行动安装失败 " +
      code +
      "\n" +
      (messages[code] ?? "请查看排障日志并核对当前账户权限与安装环境。") +
      "\n",
  );
  if (diagnosticLog) process.stderr.write("排障日志 " + diagnosticLog + "\n");
  process.exitCode = 1;
}
