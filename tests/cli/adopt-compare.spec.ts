import * as fs from 'fs';
import * as path from 'path';

import { CompareDeps, runAdoptCompare } from '../../src/cli/commands/adopt-compare';
import { compareBuilds } from '../../src/lib/adopt/compare';

import { makeCtx, tmpDir, writeJson } from './helpers';

const NONCE = "<!--#echo var='UNIQUE_ID' -->";
const meta = (o: object) =>
  `<meta name="x-build" content="${Buffer.from(JSON.stringify(o)).toString('base64')}">`;
const html = (m: string) =>
  `<html><head>${m}<link nonce="${NONCE}" rel="stylesheet" href="styles.a19836500aa91ad0.css">` +
  `</head><body><script nonce="${NONCE}">x</script><script src="main.0123456789abcdef.js"></script></body></html>`;

/** One build output: same shape both ways, differing where every build differs. */
function build(
  dir: string,
  o: { hash: string; names: number; exif: boolean; ht?: string; meta: object },
) {
  const w = (rel: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  };
  w('index.html', html(meta(o.meta)));
  // The release target prefixes the obfuscator's names per file (_p1a2b3c_0x…).
  const name = o.hash.startsWith('f') ? '_p1a2b3c_0x1a2b;' : '_0x1a2b;';
  w(`main.${o.hash}.js`, `var a="ENC(x)",b="ENC(y)";${name.repeat(o.names)}`);
  w('runtime.ac46facdb4e163db.js', 'runtime');
  w('styles.a19836500aa91ad0.css', 'body{}');
  if (o.ht !== undefined) w('.htaccess', o.ht);
  w(
    'assets/a.jpg',
    Buffer.concat([Buffer.from([0xff, 0xd8]), o.exif ? Buffer.from('Exif\0\0') : Buffer.alloc(0)]),
  );
}

describe('compareBuilds', () => {
  it('passes builds that differ only where every build does', () => {
    const old = tmpDir();
    const neu = tmpDir();
    build(old, {
      hash: '0123456789abcdef',
      names: 100,
      exif: true,
      ht: 'rules',
      meta: { env: 'uat', commit: 'a' },
    });
    build(neu, {
      hash: 'fedcba9876543210',
      names: 103,
      exif: false,
      ht: 'rules',
      meta: { env: 'UAT', commit: 'b', gen: 'x' },
    });
    const checks = Object.fromEntries(compareBuilds(old, neu).map((c) => [c.name, c]));
    expect(checks['Files'].status).toBe('same');
    expect(checks['.htaccess'].detail).toBe('identical');
    expect(checks['CSP nonce (index.html)'].status).toBe('same');
    expect(checks['Build meta (x-build)'].status).toBe('same');
    expect(checks['Encrypted env values'].detail).toContain('old 2, new 2');
    expect(checks['Obfuscation'].status).toBe('same');
    expect(checks['Image metadata']).toMatchObject({
      status: 'info',
      detail: 'images with EXIF: old 1, new 0',
    });
    expect(checks['Other files'].detail).toContain('3 byte-identical');
  });

  it('flags a missing .htaccess, weaker obfuscation and lost encryption', () => {
    const old = tmpDir();
    const neu = tmpDir();
    build(old, {
      hash: '0123456789abcdef',
      names: 100,
      exif: false,
      ht: 'rules',
      meta: { commit: 'a' },
    });
    build(neu, { hash: 'fedcba9876543210', names: 60, exif: false, meta: { commit: 'b' } });
    fs.writeFileSync(path.join(neu, 'main.fedcba9876543210.js'), 'plain');
    const differs = compareBuilds(old, neu)
      .filter((c) => c.status === 'differs')
      .map((c) => c.name);
    expect(differs).toEqual(['Files', '.htaccess', 'Encrypted env values', 'Obfuscation']);
  });
});

describe('pstack adopt --compare', () => {
  function workspace(): string {
    const ws = tmpDir();
    writeJson(path.join(ws, 'nx.json'), {});
    writeJson(path.join(ws, 'package.json'), {
      scripts: { 'build:web:uat': 'nx run web:release:uat' },
    });
    writeJson(path.join(ws, 'apps/web/project.json'), {
      name: 'web',
      targets: {
        build: {
          executor: '@angular-devkit/build-angular:browser',
          options: { outputPath: 'dist/apps/web' },
        },
        release: {
          executor: '@mouryaamit/nx-polystack:build',
          configurations: { uat: {}, prod: {} },
        },
      },
    });
    fs.mkdirSync(path.join(ws, 'node_modules'));
    return ws;
  }

  function fake(ws: string, over: Partial<CompareDeps> = {}) {
    const calls: string[] = [];
    const out: string[] = [];
    const deps: CompareDeps = {
      exec(cmd, args, cwd) {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'git' && args[1] === 'add') {
          const wt = args[3];
          writeJson(path.join(wt, 'package.json'), {
            scripts: { 'build:web:uat': 'node tools/scripts/build.js --project=web --env=uat' },
          });
          writeJson(path.join(wt, 'apps/web/project.json'), {
            name: 'web',
            targets: { build: { options: { outputPath: 'dist/apps/web' } } },
          });
        } else if (cmd === 'npm') {
          build(path.join(cwd, 'dist/apps/web'), {
            hash: '0123456789abcdef',
            names: 50,
            exif: true,
            ht: 'r',
            meta: { commit: 'a' },
          });
        } else if (cmd === 'npx') {
          build(path.join(cwd, 'dist/apps/web'), {
            hash: 'fedcba9876543210',
            names: 50,
            exif: false,
            ht: 'r',
            meta: { commit: 'b' },
          });
        } else if (cmd === 'git' && args[1] === 'remove') {
          fs.rmSync(args[3], { recursive: true, force: true });
        }
      },
      capture: (cmd, args) => (args[0] === 'status' ? ' M apps/web/project.json\n' : 'abc\n'),
      log: (l) => void out.push(l),
      ...over,
    };
    return { deps, calls, out };
  }

  it('builds the app both ways in a worktree of HEAD and writes the report', async () => {
    const ws = workspace();
    const { deps, calls, out } = fake(ws);
    const code = await runAdoptCompare(
      makeCtx({ cwd: ws, flags: { compare: true, app: 'web', env: 'uat' } }),
      deps,
    );
    expect(code).toBe(0);
    expect(calls[0]).toMatch(/^git worktree add --detach \S+pstack-compare-web-\S+ HEAD$/);
    expect(calls.slice(1, 3)).toEqual(['npm run build:web:uat', 'npx nx run web:release:uat']);
    expect(calls[3]).toMatch(/^git worktree remove --force /);
    const report = fs.readFileSync(path.join(ws, 'dist/pstack-compare/web/report.md'), 'utf8');
    expect(report).toContain('| .htaccess | same | identical |');
    expect(out.join('\n')).toContain('No differences that matter.');
  });

  it('compares a build made elsewhere with --old-dir (one env, no worktree)', async () => {
    const ws = workspace();
    const elsewhere = tmpDir();
    build(elsewhere, {
      hash: '0123456789abcdef',
      names: 50,
      exif: true,
      ht: 'r',
      meta: { commit: 'a' },
    });
    const { deps, calls } = fake(ws);
    const code = await runAdoptCompare(
      makeCtx({ cwd: ws, flags: { compare: true, app: 'web', env: 'uat', oldDir: elsewhere } }),
      deps,
    );
    expect(code).toBe(0);
    expect(calls).toEqual(['npx nx run web:release:uat']);
    const report = fs.readFileSync(path.join(ws, 'dist/pstack-compare/web/report.md'), 'utf8');
    expect(report).toContain(`Old build: \`${elsewhere}\``);
    await expect(
      runAdoptCompare(
        makeCtx({ cwd: ws, flags: { compare: true, app: 'web', oldDir: elsewhere } }),
        fake(ws).deps,
      ),
    ).rejects.toThrow(/--env=<env>/);
  });

  it('needs --base once adopt is committed, and one app with a release target', async () => {
    const ws = workspace();
    const clean = fake(ws, { capture: (_c, args) => (args[0] === 'status' ? '' : 'abc') });
    await expect(
      runAdoptCompare(makeCtx({ cwd: ws, flags: { compare: true, app: 'web' } }), clean.deps),
    ).rejects.toThrow(/--base=<commit before adopt>/);
    await expect(
      runAdoptCompare(
        makeCtx({ cwd: ws, flags: { compare: true, app: 'web,admin' } }),
        fake(ws).deps,
      ),
    ).rejects.toThrow(/one app/);
    await expect(
      runAdoptCompare(
        makeCtx({ cwd: ws, flags: { compare: true, app: 'web', env: 'qa' } }),
        fake(ws).deps,
      ),
    ).rejects.toThrow(/no qa configuration/);
  });
});
