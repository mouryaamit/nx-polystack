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

  it('finds the plugin under another name through the workspace dependencies (v1.23.0)', () => {
    const ws = tmpDir();
    const template = 'git+https://git.example.com/acme/tool.git#dist-v{version}';
    writeJson(path.join(ws, 'package.json'), {
      devDependencies: { nx: '^22.0.0', '@acme/tool': template.replace('{version}', '1.23.0') },
    });
    const root = path.join(ws, 'node_modules', '@acme', 'tool');
    writeJson(path.join(ws, 'node_modules', 'nx', 'package.json'), {
      name: 'nx',
      version: '22.0.0',
    });
    writeJson(path.join(root, 'package.json'), {
      name: '@acme/tool',
      version: '1.23.0',
      bin: { pstack: 'dist/bin/cli.js' },
      pstack: { installSource: template },
    });
    fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'bin', 'cli.js'), '');
    expect(resolveLocalPlugin(ws)).toEqual({
      root,
      version: '1.23.0',
      cliPath: path.join(root, 'dist', 'bin', 'cli.js'),
      other: { name: '@acme/tool', source: { kind: 'git', template } },
    });
    // Its own name wins when both are installed.
    const own = fakeLocalPlugin(ws, '1.22.0');
    expect(resolveLocalPlugin(ws)?.root).toBe(own);
  });

  it('ignores dependencies that are not the plugin', () => {
    const ws = tmpDir();
    writeJson(path.join(ws, 'package.json'), { devDependencies: { a: '1.0.0', b: '1.0.0' } });
    // a: a pstack bin but no install source; b: an install source this build cannot read.
    for (const [name, extra] of [
      ['a', {}],
      ['b', { pstack: { installSource: 'svn:nope' } }],
    ] as const) {
      const root = path.join(ws, 'node_modules', name);
      writeJson(path.join(root, 'package.json'), {
        name,
        version: '1.0.0',
        bin: { pstack: 'dist/bin/cli.js' },
        ...extra,
      });
      fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'dist', 'bin', 'cli.js'), '');
    }
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
