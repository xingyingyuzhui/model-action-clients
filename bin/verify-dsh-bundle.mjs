import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// This process loads code and registers tools only. No session or model is
// created, and network access through the plugin's transport is disabled.
globalThis.fetch = async () => {
  throw new Error("verification_network_forbidden");
};
const directory = fs.realpathSync(process.argv[2]);
const require = createRequire(path.join(directory, "host.js"));
const manifest = JSON.parse(
  fs.readFileSync(path.join(directory, "package.json")),
);
for (const [name, expected] of Object.entries({
  ...manifest.dependencies,
  ...manifest.peerDependencies,
})) {
  const entry = require.resolve(name);
  await import(pathToFileURL(entry));
  let location = path.dirname(entry);
  while (location !== path.dirname(location)) {
    const file = path.join(location, "package.json");
    if (fs.existsSync(file)) {
      const dependency = JSON.parse(fs.readFileSync(file));
      if (dependency.name === name) {
        if (dependency.version !== expected)
          throw new Error("dependency_version_mismatch");
        break;
      }
    }
    location = path.dirname(location);
  }
  if (location === path.dirname(location))
    throw new Error("dependency_manifest_missing");
}
const official = createRequire(require.resolve("@deepseek-ai/dsh-tools"));
const { Context } = await import(
  pathToFileURL(official.resolve("@deepseek-ai/cordis"))
);
const host = await import(pathToFileURL(path.join(directory, "host.js")));
const context = new Context(),
  names = new Set();
context.provide("agents", {
  get() {},
  roots() {
    return [];
  },
});
context.provide("tools", {
  register(definition) {
    if (names.has(definition.name)) throw new Error("duplicate_tool");
    names.add(definition.name);
    return () => names.delete(definition.name);
  },
  guard() {
    return () => {};
  },
});
const fiber = context.plugin({
  name: "model-action-install-verification",
  inject: host.inject,
  apply: (ctx) => host.apply(ctx, { serverUrl: "http://127.0.0.1:9" }),
});
try {
  await fiber;
  const expected = [
    "arena_start",
    "arena_connect",
    "arena_submit_invite",
    "arena_prepare",
    "arena_confirm",
    "arena_status",
    "arena_repair_pairing",
    "arena_stop",
  ];
  if (
    names.size !== expected.length ||
    expected.some((name) => !names.has(name))
  )
    throw new Error("tools_missing");
} finally {
  await fiber.dispose();
  await context.fiber.dispose();
}
if (names.size) throw new Error("tools_not_disposed");
process.stdout.write(
  JSON.stringify({
    verified: true,
    version: manifest.version,
    registered_tools: 8,
  }) + "\n",
);
