// One source for the reported client version: the package.json shipped next to
// this file (the plugin root for lib/, the MCP package for its lib/).
import { readFileSync } from 'node:fs';
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
