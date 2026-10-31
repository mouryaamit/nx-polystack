import * as fs from 'fs';
import * as path from 'path';

import * as devkit from '@nx/devkit';
import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import presetGenerator from '../../src/generators/preset/generator';

describe('preset generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  });

  afterEach(() => jest.restoreAllMocks());

  it('default run generates workspace root config files', async () => {
    await presetGenerator(tree, {});
    expect(tree.exists('nx.json')).toBe(true);
    expect(tree.exists('package.json')).toBe(true);
    expect(tree.exists('tsconfig.base.json')).toBe(true);
    expect(tree.exists('.gitignore')).toBe(true);
    expect(tree.exists('.prettierrc')).toBe(true);
    expect(tree.exists('.eslintrc.json')).toBe(true);
    expect(tree.exists('tools/config/encrypt-keys.json')).toBe(false);
    const nx = JSON.parse(tree.read('nx.json')!.toString());
    expect(nx.pstack.envEncryption).toMatchObject({
      mode: 'listed',
      cipher: 'cryptojs',
      keySources: ['commit'],
      keys: { default: [] },
      format: 'enc',
      profileFiles: [],
    });
    expect(tree.read('.gitignore', 'utf8')).toContain('.env.local');
    expect(tree.exists('tools/config/sri-cdn-allowlist.json')).toBe(true);
    // Nx 22 does not stop to ask about usage data.
    expect(nx.analytics).toBe(false);
  });

  it('npmScope propagates into nx.json', async () => {
    await presetGenerator(tree, { npmScope: 'my-org' });
    const nx = JSON.parse(tree.read('nx.json')!.toString());
    expect(nx.npmScope).toBe('my-org');
  });

  it('baseBranch propagates into nx.json affected.defaultBase', async () => {
    await presetGenerator(tree, { baseBranch: 'main' });
    const nx = JSON.parse(tree.read('nx.json')!.toString());
    expect(nx.affected.defaultBase).toBe('main');
  });

  it('--ci=jenkins generates Jenkinsfile', async () => {
    await presetGenerator(tree, { ci: 'jenkins' });
    expect(tree.exists('Jenkinsfile')).toBe(true);
  });

  it('--ci=github-actions generates the infra workflows, not the old build.yml', async () => {
    await presetGenerator(tree, { ci: 'github-actions' });
    expect(tree.exists('.github/workflows/ci.yml')).toBe(true);
    expect(tree.exists('.github/workflows/build.yml')).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../../src/generators/preset/files/ci'))).toBe(false);
  });

  describe(':infra', () => {
    const INFRA = [
      'CONTRIBUTING.md',
      '.github/workflows/ci.yml',
      '.github/workflows/pr-title.yml',
      '.github/workflows/dependency-upgrade.yml',
      'tools/scripts/check-cycles.js',
      'knip.json',
      '.husky/pre-push',
    ];

    it('runs every part by default, with GitHub Actions and the preset base branch', async () => {
      await presetGenerator(tree, { baseBranch: 'main' });
      for (const f of INFRA) expect(tree.exists(f)).toBe(true);
      expect(tree.exists('Jenkinsfile')).toBe(false);
      expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain('main-branch-name: main');
      const pkg = readJson(tree, 'package.json');
      expect(pkg.scripts['check:cycles']).toBe('node tools/scripts/check-cycles.js');
      expect(pkg.devDependencies['knip']).toBe('^5.0.0');
    });

    it('--infra=none writes none of it', async () => {
      await presetGenerator(tree, { infra: 'none' });
      for (const f of INFRA) expect(tree.exists(f)).toBe(false);
      expect(readJson(tree, 'package.json').scripts['check:cycles']).toBeUndefined();
    });

    it('--infra=<subset> writes only those parts', async () => {
      await presetGenerator(tree, { infra: 'docs,quality' });
      expect(tree.exists('CONTRIBUTING.md')).toBe(true);
      expect(tree.exists('knip.json')).toBe(true);
      expect(tree.exists('.github/workflows/ci.yml')).toBe(false);
      expect(tree.exists('.github/workflows/dependency-upgrade.yml')).toBe(false);
    });

    it('rejects an unknown --infra part or --ci provider before writing anything', async () => {
      await expect(presetGenerator(tree, { infra: 'docs,bogus' })).rejects.toThrow(
        /unknown part "bogus" in --infra/,
      );
      await expect(presetGenerator(tree, { ci: 'gitlab' })).rejects.toThrow(
        /unknown CI provider "gitlab"/,
      );
      expect(tree.exists('.editorconfig')).toBe(false);
    });

    it('forwards --ci-cache, --flutter and the upgrade options', async () => {
      await presetGenerator(tree, {
        ciCache: true,
        flutter: 'on',
        upgradeSchedule: 'monthly',
        upgradeScope: 'nx-minor',
      });
      expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain('actions/cache@v5');
      expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain('subosito/flutter-action@v2');
      const up = tree.read('.github/workflows/dependency-upgrade.yml', 'utf8') ?? '';
      expect(up).toContain("'17 3 1 * *'");
      expect(up).toContain('nx migrate');
    });
  });

  describe('--llm runs the :llm generator', () => {
    const FILES = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'];
    const written = () => FILES.filter((f) => tree.exists(f));

    it('--llm=claude writes only CLAUDE.md, with the managed block', async () => {
      await presetGenerator(tree, { llm: 'claude', npmScope: 'my-org' });
      expect(written()).toEqual(['CLAUDE.md']);
      const claude = tree.read('CLAUDE.md', 'utf8') ?? '';
      expect(claude).toMatch(/^# CLAUDE\.md\n\n<!-- nx-polystack:start -->\n/);
      expect(claude).toContain('<!-- nx-polystack:end -->');
      expect(claude).toContain('`@my-org`');
      expect(claude).toContain('No apps yet');
    });

    it.each([
      ['codex', ['AGENTS.md']],
      ['openai-gpt', ['AGENTS.md']],
      ['copilot', ['.github/copilot-instructions.md']],
      ['claude,codex,copilot', FILES],
    ])('--llm=%s writes %j', async (llm, files) => {
      await presetGenerator(tree, { llm });
      expect(written()).toEqual(files);
    });

    it('no longer writes .codex/instructions.md or the old static templates', async () => {
      await presetGenerator(tree, { llm: 'claude,codex,copilot' });
      expect(tree.exists('.codex/instructions.md')).toBe(false);
      expect(tree.read('AGENTS.md', 'utf8')).not.toContain('AI Agent Instructions');
      expect(fs.existsSync(path.join(__dirname, '../../src/generators/preset/files/llm'))).toBe(
        false,
      );
    });

    it('without --llm writes none of the files', async () => {
      await presetGenerator(tree, {});
      expect(written()).toEqual([]);
    });

    it('rejects unknown --llm values', async () => {
      await expect(presetGenerator(tree, { llm: 'claude,gemini' })).rejects.toThrow(
        /unknown provider "gemini"/,
      );
    });

    it('writes the block after formatting, so Prettier never sees it', async () => {
      const calls: string[] = [];
      const spy = jest.spyOn(devkit, 'formatFiles').mockImplementation(async (t) => {
        calls.push(t.exists('CLAUDE.md') ? 'format-after-llm' : 'format');
      });
      await presetGenerator(tree, { llm: 'claude' });
      expect(calls).toEqual(['format']);
      expect(tree.exists('CLAUDE.md')).toBe(true);
      spy.mockRestore();
    });
  });

  it('--infra=none generates no CI files', async () => {
    await presetGenerator(tree, { infra: 'none', ci: 'jenkins' });
    expect(tree.exists('Jenkinsfile')).toBe(false);
    expect(tree.exists('.github/workflows/ci.yml')).toBe(false);
  });

  it('skipFormat: true skips formatFiles', async () => {
    const spy = jest.spyOn(devkit, 'formatFiles').mockResolvedValue(undefined);
    await presetGenerator(tree, { skipFormat: true });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('pins @mouryaamit/nx-polystack to the given pluginVersion', async () => {
    await presetGenerator(tree, { pluginVersion: '9.9.9' });
    const pkg = JSON.parse(tree.read('package.json')?.toString() ?? '{}');
    expect(pkg.devDependencies['@mouryaamit/nx-polystack']).toBe(
      'github:example-org/private-plugin#v9.9.9',
    );
  });

  it('pins PSTACK_PLUGIN_SPEC instead when it is set (dev-only, for untagged builds)', async () => {
    process.env['PSTACK_PLUGIN_SPEC'] = 'file:/tmp/mouryaamit-nx-polystack-v9.9.9.tgz';
    try {
      await presetGenerator(tree, { pluginVersion: '9.9.9' });
    } finally {
      delete process.env['PSTACK_PLUGIN_SPEC'];
    }
    const pkg = JSON.parse(tree.read('package.json')?.toString() ?? '{}');
    expect(pkg.devDependencies['@mouryaamit/nx-polystack']).toBe(
      'file:/tmp/mouryaamit-nx-polystack-v9.9.9.tgz',
    );
  });

  it('pins to its own package version by default', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const own = require('../../package.json').version;
    await presetGenerator(tree, {});
    const pkg = JSON.parse(tree.read('package.json')?.toString() ?? '{}');
    expect(pkg.devDependencies['@mouryaamit/nx-polystack']).toBe(
      `github:example-org/private-plugin#v${own}`,
    );
  });

  it('adds executor peer dependencies sharp and crypto-js', async () => {
    await presetGenerator(tree, {});
    const pkg = JSON.parse(tree.read('package.json')?.toString() ?? '{}');
    expect(pkg.devDependencies['sharp']).toBe('^0.35.5');
    expect(pkg.devDependencies['crypto-js']).toBe('^4.2.0');
  });
  it('generates husky v9 hooks without the deprecated husky.sh header', async () => {
    await presetGenerator(tree, {});
    for (const hook of ['.husky/pre-commit', '.husky/commit-msg']) {
      const content = tree.read(hook)?.toString() ?? '';
      expect(content).not.toMatch(/husky\.sh/);
      expect(content).not.toMatch(/^#!/);
    }
    expect(tree.read('.husky/pre-commit')?.toString().trim()).toBe('npx lint-staged');
    // The hook needs a config, or every commit fails with "No valid configuration found".
    expect(readJson(tree, 'package.json')['lint-staged']).toEqual({
      '*.{ts,html,scss,json,md}': ['prettier --write'],
      '*.ts': ['node tools/scripts/lint-staged-eslint.js --fix'],
      // NX-110: staged images lose EXIF/XMP/IPTC on commit.
      '*.{jpg,jpeg,png,webp}': ['pstack assets strip-exif'],
    });
    // NX-45: non-blocking ESLint on commit, import rules as warnings, cached typecheck.
    expect(tree.read('tools/scripts/lint-staged-eslint.js', 'utf8')).toContain('not blocked');
    const eslintrc = readJson(tree, '.eslintrc.json');
    expect(JSON.stringify(eslintrc)).toContain('"unused-imports/no-unused-imports":"warn"');
    expect(readJson(tree, 'nx.json').targetDefaults.typecheck.cache).toBe(true);
    expect(readJson(tree, 'package.json').devDependencies['eslint-plugin-import']).toBe('^2.29.1');
    expect(tree.read('.husky/commit-msg')?.toString().trim()).toBe(
      'npx --no-install commitlint --edit "$1"',
    );
  });

  it('wires husky v9 in package.json', async () => {
    await presetGenerator(tree, {});
    const pkg = JSON.parse(tree.read('package.json')?.toString() ?? '{}');
    expect(pkg.scripts.prepare).toBe('husky');
    expect(pkg.devDependencies.husky).toBe('^9.0.0');
  });
  it('writes a lint script that does not call itself, and keeps lintCommand for CI', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await presetGenerator(tree, { ci: 'github-actions', skipFormat: true });
    const scripts = readJson(tree, 'package.json').scripts;
    expect(scripts.lint).toBe('nx run-many -t lint');
    expect(scripts['lint:fix']).toBe('nx run-many -t lint --fix');
    expect(scripts.typecheck).toBe('nx run-many -t typecheck');
    expect(scripts['assets:strip-exif']).toBe('pstack assets strip-exif --all');
    expect(scripts['assets:check-exif']).toBe('pstack assets strip-exif --all --check');
    expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain(
      '      - run: npx nx affected -t lint typecheck test build --parallel=3\n      - run: npm run assets:check-exif\n',
    );
    expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain(
      'nx affected -t lint typecheck test build',
    );
  });

  it('never writes a lint script that starts by running itself', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await presetGenerator(tree, { lintCommand: 'npm run lint && npm test', skipFormat: true });
    expect(readJson(tree, 'package.json').scripts.lint).toBe('nx run-many -t lint');
  });

  it('uses a custom lintCommand for the lint script', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await presetGenerator(tree, { lintCommand: 'nx affected -t lint', skipFormat: true });
    expect(readJson(tree, 'package.json').scripts.lint).toBe('nx affected -t lint');
  });

  it('lists the ESLint stack the root .eslintrc.json needs', async () => {
    await presetGenerator(tree, {});
    const dev = JSON.parse(tree.read('package.json')?.toString() ?? '{}').devDependencies;
    expect(dev).toMatchObject({
      eslint: '^8.57.0',
      nx: '~17.0.6',
      '@nx/devkit': '~17.0.6',
      '@nx/eslint': '~17.0.6',
      '@nx/eslint-plugin': '~17.0.6',
      '@typescript-eslint/eslint-plugin': '^5.62.0',
      '@typescript-eslint/parser': '^5.62.0',
      'eslint-config-prettier': '^9.1.0',
    });
  });
});
