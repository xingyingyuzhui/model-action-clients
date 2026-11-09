#!/usr/bin/env node
// Clears session locks left behind when DSH or an MCP host was force-quit.
// Run it yourself after closing every DSH window and MCP host; the model is not
// allowed to touch these directories. Only *.json.lock files are inspected or
// removed; identity files are never read.
import os from 'node:os';
import path from 'node:path';
import { unlockSessions } from '../lib/lock-inspect.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('model-action-unlock [--dry-run] [--force]\n  --dry-run  只列出会删除的锁\n  --force    也删除无法确认归属的锁（内容不完整或来自另一台机器）\n');
  process.exit(0);
}
const unknown = args.filter(arg => !['--dry-run', '--force'].includes(arg));
if (unknown.length) { process.stderr.write('未知参数 ' + unknown.join(' ') + '\n'); process.exit(2); }
const dshHome = path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
const roots = [path.join(dshHome, 'plugins', 'dsh-model-action'), path.join(os.homedir(), '.model-action', 'mcp')];
const results = unlockSessions({ roots, force: args.includes('--force'), dryRun: args.includes('--dry-run') });
const label = { running: '仍在使用，未处理', stale: '进程已不存在', unknown: '无法确认归属', released: '已释放' };
for (const r of results) {
  const action = r.removed ? '已删除' : r.would_remove ? '将删除' : r.state === 'unknown' ? '需要 --force' : '保留';
  process.stdout.write(`${action}  ${label[r.state] ?? r.state}${r.pid ? '（进程 ' + r.pid + '）' : ''}  ${r.file}\n`);
}
if (!results.length) process.stdout.write('没有找到会话锁。\n');
const running = results.filter(r => r.state === 'running').length;
if (running) process.stdout.write(`有 ${running} 个锁仍被运行中的进程持有，请先关闭所有 DSH 窗口和 MCP 宿主。\n`);
