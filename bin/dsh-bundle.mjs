import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { failure } from "./dsh-profile.mjs";

export const sha256 = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function packageManifest(root, files) {
  if (!Array.isArray(files) || !files.length)
    throw failure("package_manifest_missing");
  return new Map(
    files.map(({ path: name }) => {
      if (
        typeof name !== "string" ||
        path.isAbsolute(name) ||
        name.split(/[\\/]/).includes("..")
      )
        throw failure("invalid_package_manifest");
      return [name, sha256(path.join(root, name))];
    }),
  );
}

export function verifyContents(directory, manifest) {
  for (const [name, expected] of manifest) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file) || sha256(file) !== expected)
      throw failure("installed_file_mismatch");
  }
}

export function verifyBundle(directory, manifest, log) {
  verifyContents(directory, manifest);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./verify-dsh-bundle.mjs", import.meta.url)),
      directory,
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  fs.appendFileSync(
    log,
    "\nBundle verification\n" + (result.stdout ?? "") + (result.stderr ?? ""),
    { mode: 0o600 },
  );
  if (result.status !== 0)
    throw failure(
      result.error?.code === "ETIMEDOUT"
        ? "bundle_verification_timeout"
        : "bundle_load_failed",
    );
  return JSON.parse(result.stdout);
}

export function treeManifest(directory, excluded) {
  const files = new Map();
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (file === excluded) continue;
      const stat = fs.statSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile())
        files.set(path.relative(directory, file), sha256(file));
    }
  }
  visit(directory);
  return files;
}
