import fs from 'node:fs';
import path from 'node:path';

// A real package directory must carry the isolated peers alongside its code.
// Copy the dependency tree inside the package so Node resolves bare imports.
export function placeDshBundle({ runtime, staged, current, copy = process.platform === 'win32' }) {
  if (!copy) {
    fs.symlinkSync(path.relative(path.dirname(current), staged), current, 'dir');
    return;
  }
  fs.cpSync(staged, current, { recursive: true });
  fs.cpSync(path.join(runtime, 'node_modules'), path.join(current, 'node_modules'), {
    recursive: true,
    filter: source => source !== staged,
  });
}
