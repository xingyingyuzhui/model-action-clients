import fs from "node:fs";
import path from "node:path";
import { treeManifest, verifyContents } from "./dsh-bundle.mjs";

// A real package directory must carry the isolated peers alongside its code.
// Copy the dependency tree inside the package so Node resolves bare imports.
export function placeDshBundle({
  runtime,
  staged,
  current,
  copy = process.platform === "win32",
}) {
  if (!copy) {
    fs.symlinkSync(
      path.relative(path.dirname(current), staged),
      current,
      "dir",
    );
    return;
  }
  const packageFiles = treeManifest(staged);
  const dependencies = treeManifest(path.join(runtime, "node_modules"), staged);
  fs.cpSync(staged, current, { recursive: true });
  fs.cpSync(
    path.join(runtime, "node_modules"),
    path.join(current, "node_modules"),
    {
      recursive: true,
      filter: (source) => source !== staged,
    },
  );
  // The source and copied files must agree after any filesystem/DLP transforms.
  for (const [name, hash] of dependencies)
    packageFiles.set(path.join("node_modules", name), hash);
  verifyContents(current, packageFiles);
}
