import * as fs from 'fs';
import * as path from 'path';

import {
  findWorkspaceRoot,
  manifestRoot,
  readPackageVersion,
  resolveLocalPlugin,
  selfPackageRoot,
} from '../../src/cli/context';

import { fakeLocalPlugin, REPO_ROOT, tmpDir, writeJson } from './helpers';

describe('findWorkspaceRoot', () => {
  it('finds nx.json in a parent directory', () => {
    const ws = tmpDir();
    fs.writeFileSync(path.join(ws, 'nx.json'), '{}');
    const nested = path.join(ws, 'apps', 'portal', 'src');
    fs.mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(ws);
  });

  it('returns null outside a workspace', () => {
    expect(findWorkspaceRoot(tmpDir())).toBeNull();
  });
});

describe('resolveLocalPlugin', () => {
  it('returns root, version and cli path when installed and built', () => {
    const ws = tmpDir();
    const root = fakeLocalPlugin(ws, '0.2.2');
    expect(resolveLocalPlugin(ws)).toEqual({
      root,
      version: '0.2.2',
      cliPath: path.join(root, 'dist', 'bin', 'cli.js'),
    });
  });

  it('returns null when not installed', () => {
    expect(resolveLocalPlugin(tmpDir())).toBeNull();
  });

  it('returns null when the local package.json has no version', () => {
    const ws = tmpDir();
    const root = fakeLocalPlugin(ws, '0.2.2');
    writeJson(path.join(root, 'package.json'), { name: '@mouryaamit/nx-polystack' });
    expect(resolveLocalPlugin(ws)).toBeNull();
  });

  it('returns null when installed but dist/bin/cli.js is missing', () => {
    const ws = tmpDir();
    writeJson(path.join(ws, 'node_modules', '@mouryaamit', 'nx-polystack', 'package.json'), {
      name: '@mouryaamit/nx-polystack',
      version: '0.2.2',
    });
    expect(resolveLocalPlugin(ws)).toBeNull();
  });
});

describe('selfPackageRoot / readPackageVersion', () => {
  it('locates this repo from source', () => {
    expect(selfPackageRoot()).toBe(REPO_ROOT);
  });

  it('reads the version from package.json', () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ).version;
    expect(readPackageVersion(path.join(REPO_ROOT, 'package.json'))).toBe(expected);
  });
});

describe('manifestRoot', () => {
  it('uses dist/ when running from compiled output', () => {
    const pkg = path.join(path.sep, 'pkg');
    expect(manifestRoot(pkg, path.join(pkg, 'dist', 'src', 'cli'))).toBe(path.join(pkg, 'dist'));
  });

  it('uses the package root when running from source', () => {
    const pkg = path.join(path.sep, 'pkg');
    expect(manifestRoot(pkg, path.join(pkg, 'src', 'cli'))).toBe(pkg);
  });
});
