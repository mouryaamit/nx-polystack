import * as path from 'path';

import { mergeEntryOptions, readBatchFile } from '../../../src/generators/migrate/batch';

import { put, putJson, tmpSource } from './helpers';

function batch(content: unknown): string {
  const dir = tmpSource('pstack-batch-');
  putJson(dir, 'conf/migrations.json', content);
  return path.join(dir, 'conf/migrations.json');
}

describe('readBatchFile', () => {
  it('reads entries, resolving relative sources from the file folder', () => {
    const file = batch({
      defaults: { forceAngular: true, maxFiles: 50 },
      migrations: [
        { source: '../legacy-portal', name: 'portal' },
        { source: '/abs/nx-repo', projects: ['admin'], prefix: 'legacy', noDeps: true },
        { source: 'field', adapter: 'flutter', projects: 'a, b', maxFiles: 10 },
      ],
    });
    const dir = path.dirname(file);
    const b = readBatchFile(file);
    expect(b.defaults).toEqual({ forceAngular: true, maxFiles: 50 });
    expect(b.entries).toEqual([
      {
        index: 1,
        given: '../legacy-portal',
        source: path.resolve(dir, '../legacy-portal'),
        name: 'portal',
      },
      {
        index: 2,
        given: '/abs/nx-repo',
        source: '/abs/nx-repo',
        projects: ['admin'],
        prefix: 'legacy',
        noDeps: true,
      },
      {
        index: 3,
        given: 'field',
        source: path.resolve(dir, 'field'),
        adapter: 'flutter',
        projects: ['a', 'b'],
        maxFiles: 10,
      },
    ]);
  });

  it.each([
    [[1], 'must be a JSON object'],
    [{}, '"migrations" must be a non-empty array'],
    [{ migrations: [] }, '"migrations" must be a non-empty array'],
    [{ migrations: [{ source: 'a' }], extra: 1 }, 'unknown key "extra"'],
    [{ defaults: { name: 'x' }, migrations: [{ source: 'a' }] }, '"defaults": unknown key "name"'],
    [
      { defaults: { maxFiles: 0 }, migrations: [{ source: 'a' }] },
      '"defaults": "maxFiles" must be a positive whole number',
    ],
    [{ migrations: [{ name: 'a' }] }, 'entry 1: "source" is required'],
    [{ migrations: [{ source: 'a', rollback: 'x' }] }, 'entry 1 (a): unknown key "rollback"'],
    [
      { migrations: [{ source: 'a', noDeps: 'yes' }] },
      'entry 1 (a): "noDeps" must be true or false',
    ],
    [
      { migrations: [{ source: 'a', adapter: 'react' }] },
      'entry 1 (a): "adapter" must be one of angular-cli, flutter, nx-workspace, angular-workspace, ionic',
    ],
    [
      { migrations: [{ source: 'a', projects: [1] }] },
      'entry 1 (a): "projects" must be a list of names or a comma-separated string',
    ],
    [{ migrations: ['a'] }, 'entry 1: must be an object'],
    [
      { migrations: [{ source: 'a', minConfidence: 0.3 }] },
      'entry 1 (a): "minConfidence" must be a number from 0.50 to 1.00',
    ],
    [
      { defaults: { minConfidence: 'x' }, migrations: [{ source: 'a' }] },
      '"defaults": "minConfidence" must be a number from 0.50 to 1.00',
    ],
    [
      { migrations: [{ source: 'a', projects: [] }] },
      'entry 1 (a): "projects" must name at least one project',
    ],
    [
      { migrations: [{ source: 'a', projects: ' , ' }] },
      'entry 1 (a): "projects" must name at least one project',
    ],
    [
      { migrations: [{ source: 'a', name: 'Portal App' }] },
      'entry 1 (a): "name" must be kebab-case',
    ],
    [{ migrations: [{ source: 'a', prefix: '' }] }, 'entry 1 (a): "prefix" must be kebab-case'],
    [
      {
        migrations: [
          { source: 'a', name: 'x' },
          { source: 'b', name: 'x' },
        ],
      },
      'entry 2 (b): name "x" is already used by entry 1',
    ],
  ])('refuses %j', (content, message) => {
    const file = batch(content);
    expect(() => readBatchFile(file)).toThrow(
      `migrate --config: ${file}`.length > 0 ? message : message,
    );
  });

  it('accepts a UTF-8 byte order mark', () => {
    const dir = tmpSource();
    put(dir, 'b.json', '\uFEFF' + JSON.stringify({ migrations: [{ source: 'x' }] }));
    expect(readBatchFile(path.join(dir, 'b.json')).entries).toHaveLength(1);
  });

  it('refuses a missing file and invalid JSON', () => {
    expect(() => readBatchFile('/no/such/batch.json')).toThrow(
      'migrate --config: /no/such/batch.json: cannot read the file',
    );
    const dir = tmpSource();
    put(dir, 'b.json', '{ // no comments\n}');
    expect(() => readBatchFile(path.join(dir, 'b.json'))).toThrow('is not valid JSON');
  });
});

describe('mergeEntryOptions', () => {
  it('command line < file defaults < entry', () => {
    expect(
      mergeEntryOptions(
        { index: 1, given: 'a', source: '/a', maxFiles: 5 },
        { forceAngular: true },
        { forceAngular: false, maxFiles: 100 },
      ),
    ).toEqual({ source: '/a', sourceLabel: 'a', forceAngular: true, maxFiles: 5 });
    expect(
      mergeEntryOptions(
        { index: 1, given: 'a', source: '/a', forceAngular: false },
        {},
        {
          forceAngular: true,
        },
      ),
    ).toEqual({ source: '/a', sourceLabel: 'a', forceAngular: false });
    expect(
      mergeEntryOptions({ index: 1, given: 'a', source: '/a' }, { maxFiles: 7 }, { maxFiles: 9 }),
    ).toEqual({ source: '/a', sourceLabel: 'a', maxFiles: 7 });
    expect(
      mergeEntryOptions(
        { index: 1, given: 'a', source: '/a' },
        { minConfidence: 0.6 },
        { minConfidence: 0.9 },
      ),
    ).toEqual({ source: '/a', sourceLabel: 'a', minConfidence: 0.6 });
    // An entry that names its adapter does not inherit a threshold.
    expect(
      mergeEntryOptions(
        { index: 1, given: 'a', source: '/a', adapter: 'flutter' },
        { minConfidence: 0.6 },
        { minConfidence: 0.9 },
      ),
    ).toEqual({ source: '/a', sourceLabel: 'a', adapter: 'flutter' });
  });
});
