#!/usr/bin/env node
// Same command as the DSH package's model-action-unlock, shipped with the MCP package.
import os from 'node:os';
import path from 'node:path';
import { unlockSessions } from '../lib/lock-inspect.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('model-action-unlock [--dry-run] [--force]\n  --dry-run  只列出会删除的锁\n  --force    也删除无法确认归属的锁\n');
  process.exit(0);
}
const unknown = args.filter(arg => !['--dry-run', '--force'].includes(arg));
if (unknown.length) { process.stderr.write('未知参数 ' + unknown.join(' ') + '\n'); process.exit(2); }
const roots = [path.join(os.homedir(), '.model-action', 'mcp')];
const results = unlockSessions({ roots, force: args.includes('--force'), dryRun: args.includes('--dry-run') });
for (const r of results) process.stdout.write(`${r.removed ? '已删除' : r.would_remove ? '将删除' : '保留'}  ${r.state}${r.pid ? ' pid=' + r.pid : ''}  ${r.file}\n`);
if (!results.length) process.stdout.write('没有找到会话锁。\n');
