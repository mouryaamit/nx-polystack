import * as fs from 'fs';
import * as path from 'path';

import { COMMANDS } from '../../src/cli/commands';
import { runAssets } from '../../src/cli/commands/assets';
import { helpText } from '../../src/cli/help';
import { MIN_LOCAL_VERSION, WORKSPACE_COMMANDS } from '../../src/cli/launcher';
import { pubspecAssets } from '../../src/lib/assets/source-images';

import { makeCtx, tmpDir, writeJson } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const sharp = require('sharp') as any;

const base = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } });
const withExif = () =>
  base()
    .withExif({ IFD0: { Make: 'Cam' } })
    .jpeg()
    .toBuffer();
const plain = () => base().jpeg().toBuffer();

async function put(ws: string, rel: string, buf: Promise<Buffer> | Buffer): Promise<string> {
  const file = path.join(ws, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await buf);
  return file;
}

/** web (Angular, release → build-prod), mobile (Ionic), notes (Flutter), shared assets lib. */
async function workspace(): Promise<string> {
  const ws = tmpDir('pstack-assets-');
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), { name: 'ws' });
  writeJson(path.join(ws, 'apps/web/project.json'), {
    name: 'web',
    projectType: 'application',
    targets: {
      'build-prod': {
        executor: '@angular-devkit/build-angular:browser',
        options: {
          assets: [
            'apps/web/src/favicon.ico',
            'apps/web/src/assets',
            {
              glob: '**/*',
              input: 'libs/shared/assets',
              output: 'assets/shared',
              ignore: ['**/*.md'],
            },
          ],
        },
        configurations: { uat: { assets: [{ glob: '*.png', input: 'apps/web/src/uat' }] } },
      },
      release: {
        executor: '@mouryaamit/nx-polystack:build',
        options: { buildTarget: 'web:build-prod' },
      },
    },
  });
  writeJson(path.join(ws, 'apps/mobile/project.json'), {
    name: 'mobile',
    projectType: 'application',
    targets: {
      build: {
        executor: '@angular-devkit/build-angular:browser',
        options: {
          assets: [
            { glob: '**/*', input: 'apps/mobile/src/assets' },
            { glob: '**/*.svg', input: 'node_modules/ionicons/dist/ionicons/svg', output: './svg' },
          ],
        },
      },
    },
  });
  writeJson(path.join(ws, 'apps/notes/project.json'), {
    name: 'notes',
    projectType: 'application',
    targets: {
      'build-web': {
        executor: '@mouryaamit/nx-polystack:flutter-build',
        options: { target: 'web' },
      },
    },
  });
  fs.writeFileSync(
    path.join(ws, 'apps/notes/pubspec.yaml'),
    'name: notes\nflutter:\n  uses-material-design: true\n  assets:\n    - images/\n    - path: shots/\n      flavors: [dev]\n',
  );
  writeJson(path.join(ws, 'libs/shared/assets/project.json'), {
    name: 'shared-assets',
    projectType: 'library',
    sourceRoot: 'libs/shared/assets',
    tags: ['type:assets'],
  });
  await put(ws, 'apps/web/src/assets/a.jpg', withExif());
  await put(ws, 'apps/web/src/assets/b.jpg', plain());
  await put(
    ws,
    'apps/web/src/uat/u.png',
    base()
      .withExif({ IFD0: { Make: 'C' } })
      .png()
      .toBuffer(),
  );
  await put(ws, 'apps/web/src/other/o.jpg', withExif()); // not an asset folder
  await put(ws, 'apps/mobile/src/assets/m.jpg', withExif());
  await put(ws, 'apps/notes/assets/n.jpg', withExif());
  await put(ws, 'apps/notes/images/i.jpg', withExif());
  await put(ws, 'apps/notes/shots/s.jpg', withExif());
  await put(
    ws,
    'apps/notes/web/icons/w.png',
    base()
      .withExif({ IFD0: { Make: 'C' } })
      .png()
      .toBuffer(),
  );
  await put(ws, 'apps/notes/build/web/x.jpg', withExif()); // Flutter output: never walked
  await put(ws, 'libs/shared/assets/logo.jpg', withExif());
  await put(ws, 'node_modules/ionicons/dist/ionicons/svg/z.jpg', withExif());
  return ws;
}

const hasExif = async (ws: string, rel: string) =>
  ((await sharp(fs.readFileSync(path.join(ws, rel))).metadata()).exif?.length ?? 0) > 0;

describe('pstack assets strip-exif (NX-110)', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    jest.spyOn(console, 'log').mockImplementation((m) => out.push(String(m)));
  });
  afterEach(() => jest.restoreAllMocks());

  it('is a registered command, documented, not delegated from the root', () => {
    expect(COMMANDS['assets']).toBeDefined();
    expect(MIN_LOCAL_VERSION['assets']).toBe('1.12.0');
    expect(WORKSPACE_COMMANDS.has('assets')).toBe(false);
    expect(helpText('1.12.0')).toContain('pstack assets strip-exif [--app=a,b | --all]');
  });

  it('--check lists every app and assets lib image with metadata (no selector = --all), exit 1', async () => {
    const ws = await workspace();
    const code = await runAssets(
      makeCtx({ cwd: ws, positionals: ['strip-exif'], flags: { check: true } }),
    );
    expect(code).toBe(1);
    const listed = out.filter((l) => l.startsWith('  ')).map((l) => l.trim().split(' ')[0]);
    expect(listed).toEqual([
      'apps/mobile/src/assets/m.jpg',
      'apps/notes/assets/n.jpg',
      'apps/notes/images/i.jpg',
      'apps/notes/shots/s.jpg',
      'apps/notes/web/icons/w.png',
      'apps/web/src/assets/a.jpg',
      'apps/web/src/uat/u.png',
      'libs/shared/assets/logo.jpg',
    ]);
    expect(out.some((l) => l.includes('8 image(s) with EXIF/XMP/IPTC'))).toBe(true);
    expect(await hasExif(ws, 'apps/web/src/assets/a.jpg')).toBe(true);
  });

  it('--app strips only that app (its shared assets included), plain images untouched', async () => {
    const ws = await workspace();
    const plainBefore = fs.readFileSync(path.join(ws, 'apps/web/src/assets/b.jpg'));
    const code = await runAssets(
      makeCtx({ cwd: ws, positionals: ['strip-exif'], flags: { app: 'web' } }),
    );
    expect(code).toBe(0);
    expect(out[0]).toBe('Folders: apps/web/src/assets, libs/shared/assets, apps/web/src/uat');
    expect(await hasExif(ws, 'apps/web/src/assets/a.jpg')).toBe(false);
    expect(await hasExif(ws, 'libs/shared/assets/logo.jpg')).toBe(false);
    expect(await hasExif(ws, 'apps/web/src/uat/u.png')).toBe(false);
    expect(await hasExif(ws, 'apps/web/src/other/o.jpg')).toBe(true);
    expect(await hasExif(ws, 'apps/mobile/src/assets/m.jpg')).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'apps/web/src/assets/b.jpg')).equals(plainBefore)).toBe(
      true,
    );
    expect(out).toContain('strip-exif: 4 scanned, 3 stripped, 1 unchanged, 0 skipped (source)');
    // Clean now.
    out = [];
    expect(
      await runAssets(
        makeCtx({ cwd: ws, positionals: ['strip-exif'], flags: { app: 'web', check: true } }),
      ),
    ).toBe(0);
    expect(out).toContain('No EXIF, XMP or IPTC in 4 image(s).');
  });

  it('files (lint-staged) and --dir; --dry-run lists with exit 0', async () => {
    const ws = await workspace();
    const sub = path.join(ws, 'apps/web/src');
    expect(
      await runAssets(
        makeCtx({ cwd: sub, positionals: ['strip-exif', 'other/o.jpg', 'assets/b.jpg'] }),
      ),
    ).toBe(0);
    expect(await hasExif(ws, 'apps/web/src/other/o.jpg')).toBe(false);
    out = [];
    expect(
      await runAssets(
        makeCtx({
          cwd: ws,
          positionals: ['strip-exif'],
          flags: { dir: 'apps/notes' },
          dryRun: true,
        }),
      ),
    ).toBe(0);
    // build/ is never walked.
    expect(out.filter((l) => l.startsWith('  '))).toHaveLength(4);
    expect(await hasExif(ws, 'apps/notes/images/i.jpg')).toBe(true);
  });

  it('refuses unknown apps, missing folders, files with a selector, other subcommands', async () => {
    const ws = await workspace();
    const run = (positionals: string[], flags = {}) =>
      runAssets(makeCtx({ cwd: ws, positionals, flags }));
    await expect(run(['strip-exif'], { app: 'nope' })).rejects.toThrow('no project named "nope"');
    await expect(run(['strip-exif'], { dir: 'apps/missing' })).rejects.toThrow(
      'apps/missing does not exist',
    );
    await expect(run(['strip-exif', 'a.jpg'], { all: true })).rejects.toThrow('not both');
    await expect(run(['compress'])).rejects.toThrow('usage: pstack assets strip-exif');
  });

  it('a broken image is reported and fails the run', async () => {
    const ws = await workspace();
    await put(ws, 'apps/web/src/assets/broken.png', Buffer.from('nope'));
    expect(
      await runAssets(makeCtx({ cwd: ws, positionals: ['strip-exif'], flags: { app: 'web' } })),
    ).toBe(1);
    expect(out.some((l) => l.startsWith('skipped (error): apps/web/src/assets/broken.png'))).toBe(
      true,
    );
  });

  it('reads pubspec asset entries', () => {
    expect(
      pubspecAssets(
        'name: x\ndependencies:\n  assets:\n    - nope/\nflutter:\n  assets:\n    - a/ # c\n    - "b/c.png"\n    - path: d/\n  fonts:\n    - family: F\n',
      ),
    ).toEqual(['a/', 'b/c.png', 'd/']);
  });
});
