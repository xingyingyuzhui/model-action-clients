#!/usr/bin/env node
// Real npm tarball installation and the official headless DSH. All profiles,
// user messages, game responses and model responses are disposable fixtures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
const archive = path.resolve(
  process.argv[2] ??
    path.join(root, "dist", `dsh-model-action-${pkg.version}.tgz`),
);
const npm = process.env.npm_execpath;
assert.ok(npm && fs.existsSync(npm), "Run through npm run test:install");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "model-installed-dsh-"));
const profile = path.join(home, "profiles", "audit"),
  workspace = path.join(home, "workspace");
const checks = [];
let server, model, child;
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_MODE: "DISABLED" };
const check = (name) => {
  checks.push(name);
  console.log(JSON.stringify({ check: name, pass: true }));
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function runNpm(args, cwd = root, expected = 0) {
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 6 * 1024 * 1024,
  });
  assert.equal(result.status, expected, result.stderr);
  return result;
}
function install(file = archive, expected = 0) {
  return runNpm(
    [
      "exec",
      "--yes",
      "--package=" + file,
      "--",
      "model-action-install-dsh",
      "--profile",
      "audit",
    ],
    root,
    expected,
  );
}
try {
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(profile, "package.json"),
    JSON.stringify({
      name: "model-install-fixture",
      private: true,
      dependencies: {},
      model: { provider: "preserve-this-setting" },
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(profile, "cordis.patch.yml"),
    "- insert:\n    - id: model-action-native\n      name: dsh-model-action\n      config:\n        serverUrl: http://127.0.0.1:9\n        maxToolCalls: 20\n        maxSeconds: 60\n",
  );
  const first = JSON.parse(install().stdout.trim());
  const installed = path.join(profile, "node_modules", "dsh-model-action"),
    previousTarget = fs.realpathSync(installed);
  assert.equal(first.verified, true);
  assert.equal(first.registered_tools, 8);
  let manifest = JSON.parse(
    fs.readFileSync(path.join(profile, "package.json")),
  );
  assert.equal(manifest.dependencies["dsh-model-action"], pkg.version);
  assert.equal(manifest.model.provider, "preserve-this-setting");
  const patches = parse(
    fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"),
  );
  assert.equal(
    patches.some((item) => item.insert),
    false,
  );
  assert.equal(patches[0].config.maxToolCalls, 20);
  assert.equal(patches[0].config.maxSeconds, 60);
  check(
    "fresh release-tarball installation verifies loading and preserves config",
  );
  const second = JSON.parse(install().stdout.trim());
  assert.notEqual(fs.realpathSync(installed), previousTarget);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(second.backup, "installed-entry", "package.json"),
      ),
    ).version,
    pkg.version,
  );
  assert.equal(
    manifest.dsh.profile.bundles.filter((name) => name === "dsh-model-action")
      .length,
    1,
  );
  check(
    "repeat upgrade uses a new runtime and preserves a readable prior bundle",
  );

  const damaged = path.join(home, "damaged-source");
  fs.mkdirSync(damaged);
  for (const file of ["package.json", ...pkg.files])
    fs.cpSync(path.join(root, file), path.join(damaged, file), {
      recursive: true,
    });
  fs.writeFileSync(
    path.join(damaged, "host.js"),
    'throw new Error("fixture_corrupted_entry");\n',
  );
  const [packed] = JSON.parse(
    runNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", home],
      damaged,
    ).stdout,
  );
  const before = fs.readFileSync(path.join(profile, "package.json")),
    activeTarget = fs.realpathSync(installed);
  const failed = install(path.join(home, packed.filename), 1);
  assert.match(failed.stderr, /bundle_load_failed/);
  assert.deepEqual(fs.readFileSync(path.join(profile, "package.json")), before);
  assert.equal(fs.realpathSync(installed), activeTarget);
  check(
    "a corrupted npm bundle fails verification without replacing the active installation",
  );

  // Install the official CLI separately. It supplies the genuine host runtime,
  // while the plugin and all its dependencies stay in the installed profile.
  const tools = path.join(home, "official-host");
  fs.mkdirSync(tools);
  fs.writeFileSync(
    path.join(tools, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "@deepseek-ai/dsh": "0.2.2-rc.1" },
    }),
  );
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], tools);
  const cli = path.join(
    tools,
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );
  const progress = path.join(home, "progress.json"),
    projection = path.join(home, "session.json");
  let state = "preparing",
    publicAgent = null,
    attempt = null,
    sequence = 0,
    gameSteps = 0,
    abandoned = 0,
    base;
  const session = () => ({
    state,
    public_agent_id: publicAgent,
    connection: { state: "connected" },
    ...(attempt ? { attempt } : {}),
    ...(state === "offered" ? { offer: { id: "offer_fixture" } } : {}),
    ...(state === "ended"
      ? {
          result: {
            outcome: "abandoned",
            attempt_id: attempt.id,
            public_agent_id: "agent_fixture",
          },
        }
      : {}),
  });
  server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      let value;
      switch (req.url) {
        case "/lobby/v2/access":
          value = {
            enabled: true,
            admission_mode: "open",
            invite_required: false,
          };
          break;
        case "/lobby/v2/catalog":
          value = {
            catalog_revision: "fixture",
            appearance: {
              character: [{ id: "qwen", name: "Qwen", enabled: true }],
            },
            loadouts: [{ id: "rifle", name: "rifle", enabled: true }],
            mode_ids: ["extraction"],
          };
          break;
        case "/client/v2/access/connect":
          value = {
            access_token: "model_beta_" + "a".repeat(43),
            control_token: "control_" + "c".repeat(32),
            grant: {
              id: "beta_fixture",
              state: "active",
              kind: "open",
              expires_at_ms: Date.now() + 3600000,
              max_concurrent_agents: 1,
            },
            session: session(),
          };
          break;
        case "/client/v2/session":
        case "/client/v2/heartbeat":
          value = session();
          break;
        case "/client/v2/prepare":
          state = "ready";
          publicAgent = "agent_fixture";
          attempt = null;
          value = session();
          break;
        case "/client/v2/profile/claim":
          value = body.receipt
            ? { state: "acknowledged", public_agent_id: "agent_fixture" }
            : {
                public_agent_id: "agent_fixture",
                recovery_secret: "recovery_" + "r".repeat(32),
                receipt: "profile_" + "p".repeat(32),
              };
          break;
        case "/client/v2/queue":
          state = "offered";
          attempt = {
            id: "attempt_" + ++sequence,
            mode_id: "extraction",
            room_id: "public-1",
          };
          value = session();
          break;
        case "/client/v2/offer/accept":
          state = "in_world";
          value = session();
          break;
        case "/client/v2/attempt/claim":
          value = body.receipt
            ? { state: "acknowledged", attempt_id: attempt.id }
            : {
                attempt_id: attempt.id,
                credential_scope: "current_attempt",
                game_token: "game_" + "g".repeat(32),
                receipt: "attempt_" + "p".repeat(32),
                expires_at_ms: Date.now() + 60000,
                mcp_url: base + "/agent-game/mcp",
              };
          break;
        case "/client/v2/result":
          value = { result: session().result };
          break;
        case "/agent-game/mcp": {
          const descriptors = ["step", "abandon"].map((name) => ({
            name,
            description: "Local fixture",
            inputSchema: { type: "object", properties: {} },
          }));
          let result;
          if (body.method === "tools/list") result = { tools: descriptors };
          else {
            if (body.params.name === "step") gameSteps++;
            if (body.params.name === "abandon") {
              abandoned++;
              state = "ended";
            }
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    body.params.name === "abandon"
                      ? { ok: true, outcome: "abandoned" }
                      : { ok: true, self: { hp: 85 } },
                  ),
                },
              ],
            };
          }
          value = { jsonrpc: "2.0", id: body.id, result };
          break;
        }
        default:
          throw new Error("unexpected_fixture_route");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/agent-game/mcp"
            ? value
            : { schema_version: 2, ...value },
        ),
      );
    } catch {
      res.writeHead(500);
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  const phaseCalls = new Map(),
    steps = new Set(),
    modelActions = [],
    toolErrors = [];
  let confirmation,
    calls = 0;
  model = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const request = JSON.parse(raw),
        phase = JSON.parse(fs.readFileSync(progress)).phase,
        count = phaseCalls.get(phase) ?? 0;
      phaseCalls.set(phase, count + 1);
      calls++;
      const history = JSON.stringify(request.messages),
        match = history.match(/confirmation_id["\\\s:]+([0-9a-f]{64})/);
      if (match) confirmation = match[1];
      for (const message of request.messages ?? [])
        if (
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.startsWith("Error:")
        )
          toolErrors.push(message.content.slice(0, 150));
      const names = (request.tools ?? []).map((tool) => tool.function.name);
      let action,
        args = {},
        message = "Fixture complete";
      if (count === 0 && [1, 4].includes(phase)) action = "arena_start";
      else if (count === 0 && phase === 2) {
        action = "arena_prepare";
        args = {
          name: "安装回归",
          character_id: "qwen",
          loadout_id: "rifle",
          mode_id: "extraction",
          room_id: "public-1",
        };
      } else if (count === 0 && phase === 3) {
        action = "arena_confirm";
        args = { confirmation_id: confirmation };
      } else if (
        [3, 4].includes(phase) &&
        names.includes("mcp__model_action__step") &&
        !steps.has(phase)
      ) {
        steps.add(phase);
        action = "mcp__model_action__step";
      } else if (
        phase === 3 &&
        state === "in_world" &&
        names.includes("mcp__model_action__abandon")
      )
        action = "mcp__model_action__abandon";
      modelActions.push({
        phase,
        count,
        action: action ?? "final",
        has_confirmation: !!confirmation,
        game_tools: names.filter((name) => name.startsWith("mcp__")),
      });
      const chunk = (delta, finish) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 0,
          model: request.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        "\n\n";
      const respond = () => {
        const delta = action
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: "fixture-" + calls,
                  type: "function",
                  function: { name: action, arguments: JSON.stringify(args) },
                },
              ],
            }
          : { role: "assistant", content: message };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          chunk(delta, null) +
            chunk({}, action ? "tool_calls" : "stop") +
            "data: [DONE]\n\n",
        );
      };
      if (phase === 4 && steps.has(4) && !action) {
        fs.writeFileSync(progress, JSON.stringify({ phase, stop: true }));
        setTimeout(respond, 500);
      } else respond();
    });
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const require = createRequire(
    path.join(fs.realpathSync(installed), "host.js"),
  );
  const llm = pathToFileURL(require.resolve("@deepseek-ai/dsh-llm")).href;
  const human = path.join(
    profile,
    "node_modules",
    "model-install-human-fixture",
  );
  fs.mkdirSync(human);
  fs.writeFileSync(
    path.join(human, "package.json"),
    JSON.stringify({
      name: "model-install-human-fixture",
      type: "module",
      main: "index.js",
    }),
  );
  fs.writeFileSync(
    path.join(human, "index.js"),
    `
import fs from 'node:fs';
import { createUserMessage } from ${JSON.stringify(llm)};
let active;
export const name = 'model-install-human-fixture';
export const inject = ['agents', 'agentLoop', 'agentDefaultModel', 'sessions', 'appExit'];
export function apply(ctx) {
  run(ctx).catch(error => {
    if (active) fs.writeFileSync(${JSON.stringify(projection)}, JSON.stringify(active.session.log));
    process.stderr.write(String(error.code ?? error.message));
    ctx.appExit(1);
  });
}
async function run(ctx) {
  const { agent } = await ctx.agents.create({
    sessionId: 'installation-fixture', meta: { cwd: process.cwd() },
    agentOptions: { ...ctx.agentDefaultModel.currentSelection() },
  });
  active = agent;
  const humans = ['开启 Model行动', '昵称安装回归，Qwen，步枪，持久房', '确认，开始吧', '再来一局'];
  for (let phase = 1; phase <= 4; phase++) {
    await agent.whenIdle();
    fs.writeFileSync(${JSON.stringify(progress)}, JSON.stringify({ phase }));
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: humans[phase - 1] }] }));
    if (phase === 4) {
      let injected = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (JSON.parse(fs.readFileSync(${JSON.stringify(progress)})).stop) {
          agent.inject(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '退出这局' }] }));
          injected = true;
          break;
        }
      }
      if (!injected) throw new Error('stop_fixture_timeout');
    }
    await agent.whenIdle();
    if (phase === 3) {
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        await agent.whenIdle();
      }
    }
  }
  await ctx.sessions.flush(agent.session);
  fs.writeFileSync(${JSON.stringify(projection)}, JSON.stringify(agent.session.log));
  ctx.appExit(0);
}
`,
  );
  manifest = JSON.parse(fs.readFileSync(path.join(profile, "package.json")));
  manifest.dependencies["model-install-human-fixture"] = "0.0.0";
  fs.writeFileSync(
    path.join(profile, "package.json"),
    JSON.stringify(manifest),
  );
  fs.appendFileSync(
    path.join(profile, "cordis.patch.yml"),
    `\n- id: headless-runner\n  disabled: true\n- id: model-action-native\n  config:\n    serverUrl: ${base}\n- id: llm-pi-ai\n  config:\n    providers:\n      fixture:\n        displayName: Local fixture\n        api: openai-completions\n        baseURL: http://127.0.0.1:${model.address().port}/v1\n        apiKeyEnv: INSTALL_FIXTURE_KEY\n        models:\n          - id: installation-fixture\n            name: Local fixture\n            contextWindow: 200000\n            maxTokens: 1000\n            input: [text]\n- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: fixture\n    model: installation-fixture\n- insert:\n    - id: installation-human-fixture\n      name: model-install-human-fixture\n`,
  );
  const guard = path.join(home, "network-guard.mjs");
  fs.writeFileSync(
    guard,
    `const fetch=globalThis.fetch;globalThis.fetch=(url,...args)=>{if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('fixture_remote_network_forbidden');return fetch(url,...args);};`,
  );
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv))
    if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|MODEL_ACTION|AEA_/.test(key))
      delete childEnv[key];
  childEnv.MODEL_ACTION_SERVER_URL = base;
  childEnv.INSTALL_FIXTURE_KEY = "explicit-local-fixture";
  let diagnostics = "";
  child = spawn(
    process.execPath,
    [
      "--import",
      guard,
      cli,
      "--profile",
      "audit",
      "--approval-policy",
      "never",
      "installation-fixture-driver",
    ],
    { cwd: workspace, env: childEnv },
  );
  child.stdout.on("data", () => {});
  child.stderr.on("data", (data) => (diagnostics += data));
  const timeout = setTimeout(() => child.kill(), 60000);
  const exit = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timeout);
  if (exit !== 0)
    console.error(
      JSON.stringify({
        state,
        sequence,
        gameSteps,
        abandoned,
        modelActions,
        toolErrors: [...new Set(toolErrors)],
      }),
    );
  assert.equal(exit, 0, diagnostics);
  assert.equal(sequence, 2);
  assert.equal(gameSteps, 2);
  assert.equal(abandoned, 2);
  assert.equal(state, "ended");
  const log = JSON.parse(fs.readFileSync(projection));
  const stop = log.findIndex(
    (event) =>
      event.type === "agent/inbox/spliced" &&
      event.data.inserted?.some(
        (message) =>
          message.source?.kind === "user" &&
          JSON.stringify(message.content).includes("退出这局"),
      ),
  );
  assert.ok(stop >= 0);
  assert.equal(
    log.slice(stop + 1).some((event) => event.type === "tool/call"),
    false,
  );
  check(
    "official DSH loads the installed bundle, enters, plays, repeats and processes a human exit",
  );
  console.log(
    JSON.stringify({
      passed: true,
      platform: process.platform,
      checks: checks.length,
      paid_model_calls: 0,
    }),
  );
} finally {
  child?.kill();
  server?.closeAllConnections();
  server?.close();
  model?.closeAllConnections();
  model?.close();
  fs.rmSync(home, { recursive: true, force: true });
}
