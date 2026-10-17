import { Tree, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import llmGenerator from '../../src/generators/llm/generator';
import { LLM_END, LLM_START } from '../../src/lib/utils/llm-block';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PLUGIN_VERSION: string = require('../../package.json').version;

describe('llm generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    writeJson(tree, 'package.json', {
      name: '@acme/workspace',
      devDependencies: { nx: '~17.0.6' },
    });
    writeJson(tree, 'libs/shared/util/project.json', { name: 'shared-util', tags: ['type:ts'] });
  });

  it('writes CLAUDE.md, AGENTS.md and the Copilot instructions by default', async () => {
    await llmGenerator(tree, {});
    expect(tree.read('CLAUDE.md', 'utf8')).toMatch(/^# CLAUDE\.md\n\n<!-- nx-polystack:start -->/);
    expect(tree.read('AGENTS.md', 'utf8')).toMatch(/^# AGENTS\.md\n/);
    expect(tree.read('.github/copilot-instructions.md', 'utf8')).toMatch(
      /^# GitHub Copilot instructions\n/,
    );
    const claude = tree.read('CLAUDE.md', 'utf8') ?? '';
    expect(claude).toContain(`nx-polystack v${PLUGIN_VERSION}`);
    expect(claude).toContain('`@acme`');
    expect(claude).toContain('`shared-util`');
    expect(tree.read('AGENTS.md', 'utf8')?.split(LLM_START)[1]).toBe(claude.split(LLM_START)[1]);
  });

  it('writes only the requested providers, accepting the old aliases', async () => {
    await llmGenerator(tree, { providers: 'codex' });
    expect(tree.exists('AGENTS.md')).toBe(true);
    expect(tree.exists('CLAUDE.md')).toBe(false);
    expect(tree.exists('.github/copilot-instructions.md')).toBe(false);
    expect(tree.exists('.codex/instructions.md')).toBe(false);
  });

  it('rejects unknown providers', async () => {
    await expect(llmGenerator(tree, { providers: 'claude,gemini' })).rejects.toThrow(
      /unknown provider "gemini"/,
    );
    expect(tree.exists('CLAUDE.md')).toBe(false);
  });

  it('appends to an existing file and keeps its content', async () => {
    tree.write('CLAUDE.md', '# Team notes\n\nKeep PRs small.\n');
    await llmGenerator(tree, { providers: 'claude' });
    const claude = tree.read('CLAUDE.md', 'utf8') ?? '';
    expect(claude.startsWith(`# Team notes\n\nKeep PRs small.\n\n${LLM_START}\n`)).toBe(true);
    expect(claude.endsWith(`${LLM_END}\n`)).toBe(true);
  });

  it('a second run changes nothing', async () => {
    await llmGenerator(tree, {});
    const before = tree.listChanges().map((c) => [c.path, c.content?.toString()]);
    const files = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'];
    const snapshot = files.map((f) => tree.read(f, 'utf8'));
    await llmGenerator(tree, {});
    expect(files.map((f) => tree.read(f, 'utf8'))).toEqual(snapshot);
    expect(tree.listChanges().map((c) => [c.path, c.content?.toString()])).toEqual(before);
  });

  it('updates the block when the workspace changes', async () => {
    await llmGenerator(tree, { providers: 'claude' });
    writeJson(tree, 'libs/shared/ui/project.json', { name: 'shared-ui', tags: ['type:angular'] });
    await llmGenerator(tree, { providers: 'claude' });
    expect(tree.read('CLAUDE.md', 'utf8')).toContain('`shared-ui`');
  });

  it('writes nothing when any requested file has malformed markers', async () => {
    tree.write('AGENTS.md', `${LLM_START}\nno end\n`);
    await expect(llmGenerator(tree, {})).rejects.toThrow(/AGENTS\.md has malformed/);
    expect(tree.exists('CLAUDE.md')).toBe(false);
    expect(tree.read('AGENTS.md', 'utf8')).toBe(`${LLM_START}\nno end\n`);
  });
});
