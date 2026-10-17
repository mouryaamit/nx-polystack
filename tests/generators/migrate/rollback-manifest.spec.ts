import { createHash } from 'crypto';

import { createTree } from '@nx/devkit/testing';

import {
  buildManifest,
  contentHash,
  deepEqual,
  diffJson,
  manifestPath,
  readManifest,
  writeManifest,
} from '../../../src/generators/migrate/rollback/manifest';
import { recordingTree } from '../../../src/generators/migrate/rollback/recording-tree';
import { LLM_END, LLM_START } from '../../../src/lib/utils/llm-block';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const claude = (outside: string, inside: string) =>
  `# CLAUDE.md\n\n${outside}\n\n${LLM_START}\n\n${inside}\n\n${LLM_END}\n`;

describe('migrate manifest', () => {
  it('deepEqual compares objects by keys, arrays in order', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });

  it('diffJson records added, changed and removed keys; scalar-array elements; other values whole', () => {
    expect(
      diffJson(
        { a: 1, o: { x: 1, y: [1, 3] }, gone: true, objs: [{ a: 1 }] },
        { a: 2, o: { x: 1, y: [1, 2], z: { k: 'v' } }, n: null, objs: [] },
      ),
    ).toEqual([
      { key: ['a'], from: 1, to: 2 },
      { key: ['gone'], removed: true },
      { key: ['n'], added: null },
      { key: ['o', 'y'], arrayAdded: [2], arrayRemoved: [3] },
      { key: ['o', 'z'], added: { k: 'v' } },
      { key: ['objs'], from: [{ a: 1 }], to: [] },
    ]);
    expect(diffJson([1], { a: 1 })).toEqual([{ key: [], from: [1], to: { a: 1 } }]);
  });

  it('hashes files with nx-polystack markers without the managed block', () => {
    const a = contentHash(Buffer.from(claude('notes', 'one')));
    expect(contentHash(Buffer.from(claude('notes', 'two')))).toBe(a);
    expect(contentHash(Buffer.from(claude('other', 'one')))).not.toBe(a);
    expect(contentHash(Buffer.from('plain'))).toBe(sha('plain'));
  });

  it('builds created, json and text entries, sorted, skipping unchanged files', () => {
    const base = createTree();
    base.write('package.json', JSON.stringify({ dependencies: { a: '1' } }));
    base.write('README.md', 'old');
    base.write('bad.json', '{');
    base.write('same.txt', 'same');
    base.write('drop.txt', 'drop');
    base.write('bin.dat', Buffer.from([0xff, 0xfe, 0x00]));
    const { tree, originals } = recordingTree(base);
    tree.write('apps/x/main.ts', 'code');
    tree.write('package.json', JSON.stringify({ dependencies: { a: '1', b: '2' } }));
    tree.write('README.md', 'new');
    tree.write('bad.json', '{"ok":1}');
    tree.write('same.txt', 'same');
    tree.delete('drop.txt');
    tree.write('bin.dat', 'text now');
    tree.write('tmp.txt', 'gone again');
    tree.delete('tmp.txt');

    const m = buildManifest(tree, originals, {
      name: 'x',
      adapter: 'angular-cli',
      source: '../x',
      plugin: '0.13.0',
      ionicApps: [],
    });
    expect(m).toEqual({
      version: 1,
      name: 'x',
      adapter: 'angular-cli',
      source: '../x',
      plugin: '0.13.0',
      created: [{ path: 'apps/x/main.ts', sha256: sha('code') }],
      json: [
        {
          path: 'package.json',
          previous: JSON.stringify({ dependencies: { a: '1' } }),
          sha256: sha(JSON.stringify({ dependencies: { a: '1', b: '2' } })),
          changes: [{ key: ['dependencies', 'b'], added: '2' }],
        },
      ],
      text: [
        { path: 'README.md', previous: 'old', sha256: sha('new') },
        { path: 'bad.json', previous: '{', sha256: sha('{"ok":1}') },
        {
          path: 'bin.dat',
          previous: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'),
          encoding: 'base64',
          sha256: sha('text now'),
        },
        { path: 'drop.txt', previous: 'drop', deleted: true },
      ],
    });
  });

  it('writes and reads the manifest; ionicApps only when there are some', () => {
    const tree = createTree();
    const m = buildManifest(tree, new Map(), {
      name: 'f',
      adapter: 'ionic',
      source: 's',
      plugin: '0.13.0',
      ionicApps: ['apps/f'],
    });
    writeManifest(tree, m);
    const text = tree.read(manifestPath('f'), 'utf-8') as string;
    expect(text).toBe(JSON.stringify(m, null, 2) + '\n');
    expect(m.ionicApps).toEqual(['apps/f']);
    expect(readManifest(tree, 'f')).toEqual(m);
    expect(readManifest(tree, 'nope')).toBeNull();
    tree.write(manifestPath('bad'), '{"version":2}');
    expect(() => readManifest(tree, 'bad')).toThrow(
      'migrate: docs/migrations/bad.manifest.json is not a version 1 migrate manifest.',
    );
  });
});
