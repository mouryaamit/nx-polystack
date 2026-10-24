import * as fs from 'fs';
import * as path from 'path';

import { runInternalMigrate } from '../../src/cli/commands/internal-migrate';

import { makeCtx, tmpDir, writeJson } from './helpers';

function setup(generators: Record<string, unknown>, files: Record<string, string>) {
  const selfRoot = tmpDir();
  writeJson(path.join(selfRoot, 'migrations.json'), { generators });
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(selfRoot, name), body);
  const ws = tmpDir();
  fs.writeFileSync(path.join(ws, 'nx.json'), '{}');
  return { selfRoot, ws };
}

const ctxFor = (ws: string, selfRoot: string) =>
  makeCtx({ cwd: ws, selfRoot, flags: { from: '0.2.2', to: '0.3.0' } });

describe('runInternalMigrate', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs default and #named migrations', async () => {
    const { selfRoot, ws } = setup(
      {
        a: { version: '0.3.0', implementation: './a.js' },
        b: { version: '0.3.0', implementation: './b.js#migrateB' },
      },
      {
        'a.js': "exports.default = (tree) => tree.write('a.txt', 'a');",
        'b.js': "exports.migrateB = (tree) => tree.write('b.txt', 'b');",
      },
    );
    expect(await runInternalMigrate(ctxFor(ws, selfRoot))).toBe(0);
    expect(fs.existsSync(path.join(ws, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'b.txt'))).toBe(true);
  });

  it('runs only the named migrations with --only, whatever their version, and lists them', async () => {
    const { selfRoot, ws } = setup(
      {
        old: { version: '0.1.0', implementation: './old.js', description: 'Old one' },
        a: { version: '0.3.0', implementation: './a.js' },
      },
      {
        'old.js': "exports.default = (tree) => tree.write('old.txt', 'o');",
        'a.js': "exports.default = (tree) => tree.write('a.txt', 'a');",
      },
    );
    expect(await runInternalMigrate(makeCtx({ cwd: ws, selfRoot, flags: { only: 'old' } }))).toBe(
      0,
    );
    expect(fs.existsSync(path.join(ws, 'old.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'a.txt'))).toBe(false);
    await expect(
      runInternalMigrate(makeCtx({ cwd: ws, selfRoot, flags: { only: 'nope' } })),
    ).rejects.toThrow(/no migration named "nope"\. Known: old, a/);
    (console.log as jest.Mock).mockClear();
    expect(await runInternalMigrate(makeCtx({ cwd: ws, selfRoot, flags: { list: true } }))).toBe(0);
    const out = (console.log as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(out[0]).toMatch(/^old\s+0\.1\.0\s+Old one$/);
    expect(out[1]).toMatch(/^a\s+0\.3\.0$/);
  });

  it('says when a migration had nothing to change', async () => {
    const { selfRoot, ws } = setup(
      {
        a: { version: '0.3.0', implementation: './a.js', description: 'Add a' },
        b: { version: '0.3.0', implementation: './b.js' },
      },
      {
        'a.js': "exports.default = (tree) => tree.write('a.txt', 'a');",
        'b.js': 'exports.default = () => undefined;',
      },
    );
    expect(await runInternalMigrate(ctxFor(ws, selfRoot))).toBe(0);
    const out = (console.log as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(out).toContain('✔ a (0.3.0) — Add a');
    expect(out).toContain('· b (0.3.0): nothing to change in this workspace');
    expect(out).toContain('\n2 migration(s) ran, 1 made changes. Review with "git diff".');
  });

  it('reports a run where no migration changed anything', async () => {
    const { selfRoot, ws } = setup(
      { b: { version: '0.3.0', implementation: './b.js' } },
      { 'b.js': 'exports.default = () => undefined;' },
    );
    expect(await runInternalMigrate(ctxFor(ws, selfRoot))).toBe(0);
    const out = (console.log as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(out).toContain('\n1 migration(s) ran; none needed changes in this workspace.');
  });

  it('says nothing was written in a dry run', async () => {
    const { selfRoot, ws } = setup(
      { a: { version: '0.3.0', implementation: './a.js' } },
      { 'a.js': "exports.default = (tree) => tree.write('a.txt', 'a');" },
    );
    const ctx = { ...ctxFor(ws, selfRoot), dryRun: true };
    expect(await runInternalMigrate(ctx)).toBe(0);
    expect(fs.existsSync(path.join(ws, 'a.txt'))).toBe(false);
    const out = (console.log as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(out).toContain('\n1 migration(s) checked (dry run, nothing written).');
  });

  it('returns 1 when a migration fails', async () => {
    const { selfRoot, ws } = setup(
      { a: { version: '0.3.0', implementation: './a.js' } },
      { 'a.js': "exports.default = () => { throw new Error('boom'); };" },
    );
    expect(await runInternalMigrate(ctxFor(ws, selfRoot))).toBe(1);
  });

  it('fails when the export is not a function', async () => {
    const { selfRoot, ws } = setup(
      { a: { version: '0.3.0', implementation: './a.js#nope' } },
      { 'a.js': 'module.exports = { default: 1 };' },
    );
    expect(await runInternalMigrate(ctxFor(ws, selfRoot))).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('does not export a function'),
    );
  });
});
