import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { LINT_STAGED_ESLINT_JS, LINT_STAGED_ESLINT_SCRIPT } from '../../src/lib/utils/quality';
import lintStagedEslintResolve from '../../src/migrations/lint-staged-eslint-resolve/lint-staged-eslint-resolve';

const OLD = `#!/usr/bin/env node
// Written by nx-polystack. lint-staged runs it for staged *.ts files.
let eslint;
try {
  eslint = require.resolve('eslint/bin/eslint.js', { paths: [process.cwd()] });
} catch {}
`;

describe('lint-staged-eslint-resolve migration', () => {
  it('rewrites the plugin script that cannot find ESLint 8+', async () => {
    const t = createTreeWithEmptyWorkspace();
    t.write(LINT_STAGED_ESLINT_SCRIPT, OLD);
    await lintStagedEslintResolve(t);
    expect(t.read(LINT_STAGED_ESLINT_SCRIPT, 'utf8')).toBe(LINT_STAGED_ESLINT_JS);
    expect(LINT_STAGED_ESLINT_JS).toContain("require.resolve('eslint/package.json'");
  });

  it('leaves an edited script, the current one and workspaces without it alone', async () => {
    const t = createTreeWithEmptyWorkspace();
    await lintStagedEslintResolve(t);
    expect(t.exists(LINT_STAGED_ESLINT_SCRIPT)).toBe(false);
    const own = OLD.replace('Written by nx-polystack', 'Our own');
    t.write(LINT_STAGED_ESLINT_SCRIPT, own);
    await lintStagedEslintResolve(t);
    expect(t.read(LINT_STAGED_ESLINT_SCRIPT, 'utf8')).toBe(own);
    t.write(LINT_STAGED_ESLINT_SCRIPT, LINT_STAGED_ESLINT_JS);
    await lintStagedEslintResolve(t);
    expect(t.read(LINT_STAGED_ESLINT_SCRIPT, 'utf8')).toBe(LINT_STAGED_ESLINT_JS);
  });
});
