#!/usr/bin/env node
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createModelActionBridge, VERSION } from '../server.js';

const help = `Model行动 MCP ${VERSION}
Usage: model-action-mcp [--server-url URL] [--session NAME] [--state-dir DIRECTORY]
  --server-url  HTTPS game origin (default https://xingying.dev)
  --session     Stable client identity; use a different name for each simultaneous client
  --state-dir   Private state directory (default ~/.model-action/mcp)
  --help        Show this help
  --version     Show version
Environment: MODEL_ACTION_SERVER_URL, MODEL_ACTION_SESSION, MODEL_ACTION_STATE_DIR
Credentials are obtained by browser pairing and are never CLI arguments.
`;
function parse(argv) {
  const options = { serverUrl: process.env.MODEL_ACTION_SERVER_URL, session: process.env.MODEL_ACTION_SESSION, stateDir: process.env.MODEL_ACTION_STATE_DIR };
  const keys = { '--server-url': 'serverUrl', '--session': 'session', '--state-dir': 'stateDir' };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--help' && argv.length === 1) return { output: help };
    if (argument === '--version' && argv.length === 1) return { output: VERSION + '\n' };
    if (!Object.hasOwn(keys, argument) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_arguments');
    options[keys[argument]] = argv[++i];
  }
  if (options.stateDir !== undefined) options.stateDir = path.resolve(options.stateDir);
  return options;
}
let bridge;
try {
  const options = parse(process.argv.slice(2));
  if (options.output !== undefined) process.stdout.write(options.output);
  else {
    bridge = createModelActionBridge(options);
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return; shuttingDown = true;
      try { await bridge.close(); await bridge.server.close(); } catch { process.exitCode = 1; }
    };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown); process.stdin.once('end', shutdown);
    await bridge.server.connect(new StdioServerTransport());
  }
} catch (cause) {
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(cause?.code ?? '') ? cause.code : 'startup_failed';
  process.stderr.write('model-action-mcp: ' + code + '\n');
  await bridge?.close().catch(() => {}); process.exitCode = 1;
}
