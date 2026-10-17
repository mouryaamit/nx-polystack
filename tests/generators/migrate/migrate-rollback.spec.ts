import { logger, parseJson, readJson, Tree, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrateGenerator from '../../../src/generators/migrate/generator';
import { LLM_END, LLM_START, refreshLlmBlocks } from '../../../src/lib/utils/llm-block';

import { fixtureCopy } from './helpers';

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({
      name: '@acme/workspace',
      scripts: { lint: 'nx run-many -t lint' },
      dependencies: { '@angular/core': '~15.2.0' },
      devDependencies: { nx: '~17.0.6', '@nx/eslint': '~17.0.6' },
    }),
  );
  tree.write(
    'tsconfig.base.json',
    JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@acme/kit': ['libs/kit/src/index.ts'] } },
    }),
  );
  tree.write('CLAUDE.md', `# CLAUDE.md\n\nOwn notes.\n\n${LLM_START}\n\nold\n\n${LLM_END}\n`);
  refreshLlmBlocks(tree);
  return tree;
}

/** Every file; JSON parsed (a rollback writes JSON with its own formatting). */
function treeState(tree: Tree, dir = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of tree.children(dir)) {
    const p = dir ? `${dir}/${child}` : child;
    if (tree.isFile(p)) {
      const text = tree.read(p, 'utf-8') as string;
      out[p] = p.endsWith('.json') ? parseJson(text) : text;
    } else {
      Object.assign(out, treeState(tree, p));
    }
  }
  return out;
}

describe('migrate --rollback', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = workspace();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['angular15-app', 'portal'],
    ['ionic7-app', 'field-notes'],
    ['nx16-workspace', 'legacy'],
    ['angular15-workspace', 'field'],
    ['flutter-app', 'notes'],
  ] as const)('round-trips %s', async (fixture, name) => {
    const before = treeState(tree);
    await migrateGenerator(tree, { source: fixtureCopy(fixture), name });
    expect(tree.exists(`docs/migrations/${name}.manifest.json`)).toBe(true);
    expect(tree.read(`docs/migrations/${name}.md`, 'utf-8')).toContain(
      `Undo this migration: \`pstack migrate --rollback=${name}\``,
    );
    await migrateGenerator(tree, { rollback: name });
    expect(treeState(tree)).toEqual(before);
  });

  it('records the Ionic app folders', async () => {
    await migrateGenerator(tree, { source: fixtureCopy('ionic7-app'), name: 'field-notes' });
    expect(readJson(tree, 'docs/migrations/field-notes.manifest.json').ionicApps).toEqual([
      'apps/field-notes',
    ]);
  });

  it('keeps an edited file and an edited dependency; --force removes them', async () => {
    await migrateGenerator(tree, { source: fixtureCopy('angular15-app'), name: 'portal' });
    const changes = readJson(tree, 'docs/migrations/portal.manifest.json').json.find(
      (j: { path: string }) => j.path === 'package.json',
    ).changes;
    expect(changes).toContainEqual({ key: ['dependencies', 'rxjs'], added: '~7.8.0' });
    tree.write('apps/portal/src/main.ts', '// mine\n');
    updateJson(tree, 'package.json', (p) => ({
      ...p,
      dependencies: { ...p.dependencies, rxjs: 'edited' },
    }));

    await migrateGenerator(tree, { rollback: 'portal' });
    expect(tree.read('apps/portal/src/main.ts', 'utf-8')).toBe('// mine\n');
    expect(tree.exists('apps/portal/project.json')).toBe(false);
    expect(readJson(tree, 'package.json').dependencies).toEqual({
      '@angular/core': '~15.2.0',
      rxjs: 'edited',
    });
    const notes = tree.read('docs/migrations/portal.rollback.md', 'utf-8') as string;
    expect(notes).toContain('`apps/portal/src/main.ts`');
    expect(notes).toContain('`dependencies.rxjs`');
    expect(tree.exists('docs/migrations/portal.md')).toBe(false);

    await migrateGenerator(tree, { rollback: 'portal', force: true });
    expect(tree.exists('apps/portal/src/main.ts')).toBe(false);
    expect(readJson(tree, 'package.json').dependencies).toEqual({ '@angular/core': '~15.2.0' });
    expect(tree.exists('docs/migrations/portal.manifest.json')).toBe(false);
    expect(tree.exists('docs/migrations/portal.rollback.md')).toBe(false);
  });

  it('rolls back the first of two migrations, keeping the second', async () => {
    const before = treeState(tree);
    await migrateGenerator(tree, { source: fixtureCopy('angular15-app'), name: 'portal' });
    await migrateGenerator(tree, { source: fixtureCopy('flutter-app'), name: 'notes' });

    await migrateGenerator(tree, { rollback: 'portal' });
    expect(tree.exists('apps/portal/project.json')).toBe(false);
    expect(tree.exists('apps/notes/pubspec.yaml')).toBe(true);
    expect(tree.exists('docs/migrations/notes.md')).toBe(true);
    expect(tree.exists('docs/migrations/portal.rollback.md')).toBe(false);
    const claude = tree.read('CLAUDE.md', 'utf-8') as string;
    expect(claude).toContain('`notes`');
    expect(claude).not.toContain('`portal`');
    expect(claude).toContain('Own notes.');

    await migrateGenerator(tree, { rollback: 'notes' });
    expect(treeState(tree)).toEqual(before);
  });

  it("never reuses another migration's report or manifest name", async () => {
    await migrateGenerator(tree, { source: fixtureCopy('nx16-workspace'), name: 'legacy' });
    await expect(
      migrateGenerator(tree, { source: fixtureCopy('angular15-app'), name: 'legacy' }),
    ).rejects.toThrow(
      'migrate: "docs/migrations/legacy.md" already exists (another migration uses the name "legacy").',
    );
    tree.delete('docs/migrations/legacy.md');
    await expect(
      migrateGenerator(tree, { source: fixtureCopy('angular15-workspace'), name: 'legacy' }),
    ).rejects.toThrow('migrate: "docs/migrations/legacy.manifest.json" already exists');
  });

  it('checks the options', async () => {
    const src = fixtureCopy('angular15-app');
    await expect(migrateGenerator(tree, { source: src, rollback: 'portal' })).rejects.toThrow(
      'migrate: pass either --source (to migrate) or --rollback=<name> (to undo a migration), not both.',
    );
    await expect(migrateGenerator(tree, { rollback: 'Not Kebab' })).rejects.toThrow(
      'migrate: --rollback="Not Kebab" must be a migration name (kebab-case), as in docs/migrations/<name>.md.',
    );
    await expect(migrateGenerator(tree, { rollback: 'portal', prefix: 'x' })).rejects.toThrow(
      'migrate: --rollback takes only --force (and --dry-run).',
    );
    await expect(migrateGenerator(tree, { source: src, force: true })).rejects.toThrow(
      'migrate: --force is only for --rollback (--force-angular is the migrate option).',
    );
    await expect(migrateGenerator(tree, { rollback: 'portal' })).rejects.toThrow(
      'migrate: no manifest for "portal"',
    );
  });
});
