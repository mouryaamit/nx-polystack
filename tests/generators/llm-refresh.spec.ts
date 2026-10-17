import * as fs from 'fs';
import * as path from 'path';

import { Tree } from '@nx/devkit';
import { flushChanges, FsTree } from 'nx/src/generators/tree';

import appGenerator from '../../src/generators/app/generator';
import envGenerator from '../../src/generators/env/generator';
import libGenerator from '../../src/generators/lib/generator';
import llmGenerator from '../../src/generators/llm/generator';
import { LLM_END, LLM_START } from '../../src/lib/utils/llm-block';
import { tmpDir, writeJson } from '../cli/helpers';

/** Text Prettier would rewrite (`*` bullets, `__bold__`, padding): proves refresh runs after it. */
const HAND_WRITTEN = '# Team notes\n\n*   keep PRs small\n\n__Bold__   text\n';

/**
 * On-disk workspaces: in a virtual tree every file counts as changed, so formatFiles would
 * format CLAUDE.md whatever the order. Here only files a generator touches are formatted.
 */
describe('the block is refreshed by app, lib and env', () => {
  let ws: string;
  let tree: Tree;

  /** Writes the pending changes to disk and starts a fresh tree, like a new pstack run. */
  function commit(): void {
    flushChanges(ws, tree.listChanges());
    tree = new FsTree(ws, false);
  }

  beforeEach(() => {
    ws = tmpDir();
    writeJson(path.join(ws, 'nx.json'), {});
    writeJson(path.join(ws, 'package.json'), {
      name: '@acme/workspace',
      scripts: {},
      devDependencies: { nx: '17.0.6' },
    });
    writeJson(path.join(ws, 'tsconfig.base.json'), { compilerOptions: { paths: {} } });
    tree = new FsTree(ws, false);
  });

  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  async function managedClaude(): Promise<void> {
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), HAND_WRITTEN);
    await llmGenerator(tree, { providers: 'claude' });
    commit();
  }

  const claude = () => tree.read('CLAUDE.md', 'utf8') ?? '';
  const block = () => claude().slice(claude().indexOf(LLM_START));

  it('app adds the new app and keeps the hand-written text byte-for-byte', async () => {
    await managedClaude();
    await appGenerator(tree, { name: 'portal', type: 'angular' });
    expect(claude().startsWith(`${HAND_WRITTEN}\n${LLM_START}`)).toBe(true);
    expect(block()).toMatch(/\| `portal` +\| angular +\| `apps\/portal` +\|/);
    expect(claude().endsWith(`${LLM_END}\n`)).toBe(true);
  });

  it('lib adds the new lib with its import alias', async () => {
    await managedClaude();
    await libGenerator(tree, { name: 'util', type: 'ts' });
    expect(claude().startsWith(HAND_WRITTEN)).toBe(true);
    expect(block()).toMatch(
      /\| `shared-util` +\| ts +\| `libs\/shared\/util` +\| `@acme\/shared-util` +\|/,
    );
  });

  it('lib refreshes after the design-tokens afterFormat step', async () => {
    await managedClaude();
    await libGenerator(tree, { name: 'brand', type: 'design-tokens' });
    expect(block()).toContain('`shared-brand`');
  });

  it('env adds the new environment', async () => {
    await appGenerator(tree, { name: 'portal', type: 'angular' });
    commit();
    await managedClaude();
    expect(block()).not.toContain('`qa`');
    await envGenerator(tree, { all: true, name: 'qa' });
    expect(block()).toContain('`dev`, `prod`, `qa`, `uat`');
    expect(claude().startsWith(HAND_WRITTEN)).toBe(true);
  });

  it('does not create or touch files without the markers', async () => {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), HAND_WRITTEN);
    await appGenerator(tree, { name: 'portal', type: 'flutter' });
    commit();
    await libGenerator(tree, { name: 'util', type: 'ts' });
    expect(tree.read('AGENTS.md', 'utf8')).toBe(HAND_WRITTEN);
    expect(tree.exists('CLAUDE.md')).toBe(false);
    expect(tree.exists('.github/copilot-instructions.md')).toBe(false);
  });
});
