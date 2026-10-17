import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CommandContext } from '../../src/cli/types';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export function tmpDir(prefix = 'pstack-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function writeJson(file: string, value: unknown, indent = 2): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, indent) + '\n');
}

/** Create a fake installed plugin under <ws>/node_modules/@mouryaamit/nx-polystack; returns its root. */
export function fakeLocalPlugin(ws: string, version: string): string {
  const root = path.join(ws, 'node_modules', '@mouryaamit', 'nx-polystack');
  writeJson(path.join(root, 'package.json'), { name: '@mouryaamit/nx-polystack', version });
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'cli.js'), '');
  return root;
}

export function makeCtx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: process.cwd(),
    positionals: [],
    flags: {},
    dryRun: false,
    verbose: false,
    selfVersion: '0.3.0',
    selfRoot: REPO_ROOT,
    ...over,
  };
}
