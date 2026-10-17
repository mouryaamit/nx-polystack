import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { applyInfra } from '../../src/generators/infra/generator';

/**
 * The rendered tools/scripts/check-cycles.js, written to a temp dir and required, so the tests
 * run exactly the file a workspace gets.
 */
function renderScript(): { file: string; dir: string } {
  const tree = createTreeWithEmptyWorkspace();
  applyInfra(tree, { with: 'ci' });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-cycles-')));
  const file = path.join(dir, 'tools/scripts/check-cycles.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, tree.read('tools/scripts/check-cycles.js', 'utf8') ?? '');
  return { file, dir };
}

const { file: SCRIPT, dir: WS } = renderScript();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cycles = require(SCRIPT) as {
  readProjectGraph(json: unknown): Record<string, string[]>;
  findCycles(edges: Record<string, string[]>): string[][];
  newCycles(found: string[][], allowed: string[][]): string[][];
  staleAllowed(found: string[][], allowed: string[][]): string[][];
};

type Dep = { source: string; target: string; type: string };

/** An Nx 17 `nx graph --file` document. */
function nxGraph(edges: Record<string, string[]>, extra: Record<string, Dep[]> = {}) {
  const names = new Set([...Object.keys(edges), ...Object.values(edges).flat()]);
  const nodes = Object.fromEntries(
    [...names].map((n) => [n, { name: n, type: 'lib', data: { root: `libs/${n}` } }]),
  );
  const dependencies: Record<string, Dep[]> = {};
  for (const n of names) {
    dependencies[n] = (edges[n] ?? []).map((t) => ({ source: n, target: t, type: 'static' }));
  }
  for (const [k, v] of Object.entries(extra)) dependencies[k] = [...(dependencies[k] ?? []), ...v];
  return { graph: { nodes, dependencies } };
}

const find = (edges: Record<string, string[]>) =>
  cycles.findCycles(cycles.readProjectGraph(nxGraph(edges)));

describe('check-cycles.js', () => {
  it('is plain CommonJS with no requires beyond Node built-ins', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const required = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(required.sort()).toEqual(['child_process', 'fs', 'os', 'path']);
    expect(src).not.toMatch(/^\s*(import|export)\s/m);
  });

  it('reads Nx 17 graph JSON and ignores npm: targets and unknown nodes', () => {
    const json = nxGraph(
      { a: ['b'], b: [] },
      { a: [{ source: 'a', target: 'npm:rxjs', type: 'static' }] },
    );
    expect(cycles.readProjectGraph(json)).toEqual({ a: ['b'], b: [] });
  });

  it('finds no cycle in a DAG', () => {
    expect(find({ app: ['ui', 'util'], ui: ['util'], util: [] })).toEqual([]);
  });

  it('finds a self-loop', () => {
    expect(find({ a: ['a'], b: ['a'] })).toEqual([['a']]);
  });

  it('finds a 2-cycle', () => {
    expect(find({ a: ['b'], b: ['a'], c: ['a'] })).toEqual([['a', 'b']]);
  });

  it('finds a 3-cycle, members sorted', () => {
    expect(find({ c: ['a'], a: ['b'], b: ['c'], d: [] })).toEqual([['a', 'b', 'c']]);
  });

  it('finds separate cycles, sorted', () => {
    expect(find({ z: ['y'], y: ['z'], a: ['b'], b: ['a'] })).toEqual([
      ['a', 'b'],
      ['y', 'z'],
    ]);
  });

  it('npm: edges never make a cycle', () => {
    const json = nxGraph({ a: [] }, { a: [{ source: 'a', target: 'npm:a', type: 'static' }] });
    expect(cycles.findCycles(cycles.readProjectGraph(json))).toEqual([]);
  });

  it('the allowlist is order-insensitive', () => {
    const found = [
      ['a', 'b', 'c'],
      ['x', 'y'],
    ];
    expect(cycles.newCycles(found, [['c', 'a', 'b']])).toEqual([['x', 'y']]);
    expect(
      cycles.newCycles(found, [
        ['c', 'a', 'b'],
        ['y', 'x'],
      ]),
    ).toEqual([]);
    // A subset is not the same cycle.
    expect(cycles.newCycles(found, [['a', 'b']])).toEqual(found);
  });

  it('reports allowlist entries that no longer exist', () => {
    expect(
      cycles.staleAllowed(
        [['a', 'b']],
        [
          ['b', 'a'],
          ['p', 'q'],
        ],
      ),
    ).toEqual([['p', 'q']]);
  });

  describe('as a command (--graph=<file>)', () => {
    const run = (graph: unknown, allowed?: unknown) => {
      const g = path.join(WS, 'graph.json');
      fs.writeFileSync(g, JSON.stringify(graph));
      const allowFile = path.join(WS, 'tools/config/allowed-cycles.json');
      fs.mkdirSync(path.dirname(allowFile), { recursive: true });
      if (allowed === undefined) fs.rmSync(allowFile, { force: true });
      else fs.writeFileSync(allowFile, JSON.stringify(allowed));
      return spawnSync(process.execPath, [SCRIPT, `--graph=${g}`], { cwd: WS, encoding: 'utf8' });
    };

    it('exits 0 on a DAG', () => {
      const r = run(nxGraph({ a: ['b'], b: [] }), []);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/No new dependency cycles/);
    });

    it('exits 1 and prints each new cycle', () => {
      const r = run(nxGraph({ a: ['b'], b: ['a'], c: ['c'] }), []);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('a -> b -> a');
      expect(r.stderr).toContain('c -> c');
    });

    it('exits 0 when every cycle is allowed (missing allowlist = empty)', () => {
      expect(run(nxGraph({ a: ['b'], b: ['a'] }), [['b', 'a']]).status).toBe(0);
      expect(run(nxGraph({ a: ['b'], b: ['a'] })).status).toBe(1);
    });

    it('rejects a malformed allowlist', () => {
      const r = run(nxGraph({ a: [] }), { a: 'b' });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/allowed-cycles\.json must be an array of arrays/);
    });
  });
});
