import { readJson, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { isRecursiveLintCommand } from '../../src/generators/preset/generator';
import fixLintScript from '../../src/migrations/fix-lint-script/fix-lint-script';

function tree(scripts: Record<string, string>) {
  const t = createTreeWithEmptyWorkspace();
  updateJson(t, 'package.json', (j) => ({ ...j, scripts }));
  return t;
}

describe('isRecursiveLintCommand', () => {
  it.each([
    'npm run lint',
    'npm run lint --fix',
    'npm run-script lint',
    'yarn lint',
    'pnpm lint',
    'pnpm run lint',
    '  npm run lint  ',
    'npm run lint -- --quiet',
  ])('flags %s', (cmd) => expect(isRecursiveLintCommand(cmd)).toBe(true));
  it.each([
    'nx run-many -t lint',
    'npm run lint:all',
    'npx nx affected -t lint',
    'npm run lint && npm test',
    'npm run lint; echo done',
    'npm run linter',
    'yarn lint --max-warnings=0',
  ])('accepts %s', (cmd) => expect(isRecursiveLintCommand(cmd)).toBe(false));
});

describe('fix-lint-script migration', () => {
  it('replaces the self-calling lint and lint:fix scripts', async () => {
    const t = tree({ lint: 'npm run lint', 'lint:fix': 'npm run lint --fix', build: 'nx build' });
    await fixLintScript(t);
    expect(readJson(t, 'package.json').scripts).toEqual({
      lint: 'nx run-many -t lint',
      'lint:fix': 'nx run-many -t lint --fix',
      build: 'nx build',
    });
  });

  it('rewrites lint:fix only when lint itself is recursive', async () => {
    const t = tree({ lint: 'nx affected -t lint', 'lint:fix': 'npm run lint --fix' });
    await fixLintScript(t);
    expect(readJson(t, 'package.json').scripts).toEqual({
      lint: 'nx affected -t lint',
      'lint:fix': 'npm run lint --fix',
    });
  });

  it('leaves a lint script that calls lint and more alone', async () => {
    const scripts = { lint: 'npm run lint && npm test', 'lint:fix': 'npm run lint --fix' };
    const t = tree(scripts);
    await fixLintScript(t);
    expect(readJson(t, 'package.json').scripts).toEqual(scripts);
  });

  it('leaves custom lint scripts alone', async () => {
    const scripts = { lint: 'nx affected -t lint', 'lint:fix': 'eslint . --fix' };
    const t = tree(scripts);
    await fixLintScript(t);
    expect(readJson(t, 'package.json').scripts).toEqual(scripts);
  });
});
