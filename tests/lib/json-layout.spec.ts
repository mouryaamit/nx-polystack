import * as fs from 'fs';
import * as path from 'path';

import {
  keepJsonLayout,
  loadJsonc,
  restoreJsonLayouts,
  snapshotJsonConfigs,
} from '../../src/lib/utils/json-layout';
import { tmpDir } from '../cli/helpers';

const jsonc = loadJsonc(process.cwd());

const PKG = [
  '{',
  '  "name": "acme",',
  '  "scripts": { "build": "nx build", "lint": "nx lint" },',
  '  "devDependencies": {',
  '    "@nx/js": "17.0.6",',
  '    "nx": "17.0.6"',
  '  },',
  '  "overrides": {',
  '    "a": { "x": "1" },',
  '    "b": { "y": "2" }',
  '  }',
  '}',
].join('\n');

describe('keepJsonLayout', () => {
  it('loads jsonc-parser from the nx install', () => {
    expect(jsonc).not.toBeNull();
  });

  it('keeps one-line objects and moves only the changed values', () => {
    const value = JSON.parse(PKG);
    value.devDependencies['@nx/devkit'] = '17.0.6';
    value.devDependencies.nx = '17.0.7';
    value.scripts.test = 'jest';
    delete value.overrides.b;
    const out = keepJsonLayout(jsonc!, PKG, JSON.stringify(value, null, 2));
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toEqual(value);
    expect(out).toContain('    "a": { "x": "1" }');
    expect(out).toContain('"lint": "nx lint"');
    expect(out).toContain('    "nx": "17.0.7"');
    expect(out).toContain('"scripts": { "build": "nx build", "lint": "nx lint", "test": "jest" },');
    expect(out).toContain('    "nx": "17.0.7",\n    "@nx/devkit": "17.0.6"\n');
    expect(out).toContain('    "a": { "x": "1" }\n  }');
  });

  it('puts a new key after the key it follows', () => {
    const value = JSON.parse(PKG);
    value.devDependencies = { '@nx/devkit': '17.0.6', '@nx/js': '17.0.6', nx: '17.0.6' };
    value.overrides = { a: { x: '1' }, ab: ['p', 'q'], b: { y: '2' } };
    const out = keepJsonLayout(jsonc!, PKG, JSON.stringify(value, null, 2))!;
    expect(out).toContain('  "devDependencies": {\n    "@nx/devkit": "17.0.6",\n    "@nx/js"');
    expect(out).toContain(
      '    "a": { "x": "1" },\n    "ab": [\n      "p",\n      "q"\n    ],\n    "b": { "y": "2" }',
    );
  });

  it('takes entries out of an array and edits elements in place', () => {
    const pj = [
      '{',
      '  // apps/web/project.json',
      '  "assets": [',
      '    "apps/web/src/favicon.ico",',
      '    { "glob": "**/*", "input": "apps/web/src/assets", "output": "assets/" },',
      '    { "glob": ".htaccess", "input": "apps/web/src/", "output": "./" }',
      '  ],',
      '  "budgets": [{ "type": "initial", "maximumWarning": "2mb" }]',
      '}',
    ].join('\n');
    const value = {
      assets: [
        'apps/web/src/favicon.ico',
        { glob: '**/*', input: 'apps/web/src/assets', output: 'assets/' },
      ],
      budgets: [{ type: 'initial', maximumWarning: '3mb' }],
    };
    expect(keepJsonLayout(jsonc!, pj, JSON.stringify(value, null, 2))).toBe(
      pj
        .replace(',\n    { "glob": ".htaccess", "input": "apps/web/src/", "output": "./" }', '')
        .replace('"2mb"', '"3mb"'),
    );
  });

  it('returns the original text when only the layout changed', () => {
    expect(keepJsonLayout(jsonc!, PKG, JSON.stringify(JSON.parse(PKG), null, 2))).toBe(PKG);
  });

  it('gives up on text that does not parse', () => {
    expect(keepJsonLayout(jsonc!, PKG, '{ "name": ')).toBeNull();
  });
});

describe('restoreJsonLayouts', () => {
  it('rewrites the changed config files in their old layout', () => {
    const root = tmpDir();
    const pkg = path.join(root, 'package.json');
    const pj = path.join(root, 'apps/web/project.json');
    fs.writeFileSync(pkg, PKG);
    fs.mkdirSync(path.dirname(pj), { recursive: true });
    fs.writeFileSync(pj, '{ "name": "web", "targets": { "build": { "executor": "x" } } }\n');
    const snapshot = snapshotJsonConfigs(root);
    expect([...snapshot.keys()].map((f) => path.relative(root, f)).sort()).toEqual([
      'apps/web/project.json',
      'package.json',
    ]);

    const value = JSON.parse(PKG);
    value.devDependencies.nx = '17.0.7';
    fs.writeFileSync(pkg, JSON.stringify(value, null, 2) + '\n');
    expect(restoreJsonLayouts(root, snapshot, jsonc!)).toEqual(['package.json']);
    expect(fs.readFileSync(pkg, 'utf8')).toBe(PKG.replace('"nx": "17.0.6"', '"nx": "17.0.7"'));
  });
});
