import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { helpText } from '../../src/cli/help';
import { assertLocalSupports } from '../../src/cli/launcher';
import infraGenerator, { eslintNote } from '../../src/generators/infra/generator';
import {
  addQualityEslintRules,
  addTypecheckNxDefaults,
  addTypecheckTargets,
  addTypecheckToCi,
  LINT_STAGED_ESLINT_JS,
  LINT_STAGED_ESLINT_SCRIPT,
  setLintStagedMode,
  unusedImportsVersion,
} from '../../src/lib/utils/quality';
import qualityChecks from '../../src/migrations/quality-checks/quality-checks';

describe('quality (NX-45)', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write('package.json', JSON.stringify({ devDependencies: { nx: '17.0.6' } }));
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const project = (root: string, json: object, tsconfig?: string) => {
    tree.write(`${root}/project.json`, JSON.stringify(json));
    if (tsconfig) tree.write(`${root}/${tsconfig}`, '{}');
  };

  describe('typecheck', () => {
    it('adds tsc --noEmit for app and lib tsconfigs, keeps existing targets, skips the rest', () => {
      project('apps/portal', { name: 'portal', targets: {} }, 'tsconfig.app.json');
      project('libs/ui', { name: 'ui' }, 'tsconfig.lib.json');
      project('apps/mobile', { name: 'mobile', targets: {} });
      project(
        'libs/core',
        { name: 'core', targets: { typecheck: { executor: 'nx:noop' } } },
        'tsconfig.lib.json',
      );
      tree.write('tools/tpl/project.json', '{ "name": <%= name %> }');

      expect(addTypecheckTargets(tree).sort()).toEqual(['portal', 'ui']);
      expect(readJson(tree, 'apps/portal/project.json').targets.typecheck).toEqual({
        executor: 'nx:run-commands',
        options: { command: 'tsc --noEmit -p apps/portal/tsconfig.app.json' },
      });
      expect(readJson(tree, 'libs/ui/project.json').targets.typecheck.options.command).toBe(
        'tsc --noEmit -p libs/ui/tsconfig.lib.json',
      );
      expect(readJson(tree, 'apps/mobile/project.json').targets.typecheck).toBeUndefined();
      expect(readJson(tree, 'libs/core/project.json').targets.typecheck.executor).toBe('nx:noop');
      expect(addTypecheckTargets(tree)).toEqual([]);
    });

    it('caches typecheck in nx.json, also in cacheableOperations', () => {
      tree.write(
        'nx.json',
        JSON.stringify({
          tasksRunnerOptions: {
            default: {
              runner: 'nx/tasks-runners/default',
              options: { cacheableOperations: ['build'] },
            },
          },
        }),
      );
      expect(addTypecheckNxDefaults(tree)).toBe(true);
      const nx = readJson(tree, 'nx.json');
      expect(nx.targetDefaults.typecheck.cache).toBe(true);
      expect(nx.tasksRunnerOptions.default.options.cacheableOperations).toEqual([
        'build',
        'typecheck',
      ]);
      expect(addTypecheckNxDefaults(tree)).toBe(false);
    });
  });

  describe('CI', () => {
    it('adds typecheck to the affected step once, and lists files without that step', () => {
      tree.write(
        '.github/workflows/ci.yml',
        'run: npx nx affected -t lint test build --parallel=3\n',
      );
      tree.write('Jenkinsfile', "sh 'npx nx run-many -t build'\n");
      expect(addTypecheckToCi(tree)).toEqual({
        changed: ['.github/workflows/ci.yml'],
        unknown: ['Jenkinsfile'],
      });
      expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain(
        'nx affected -t lint typecheck test build --parallel=3',
      );
      expect(addTypecheckToCi(tree).changed).toEqual([]);
    });
  });

  describe('ESLint rules', () => {
    it('adds the override as warnings once and keeps configured rules', () => {
      tree.write(
        '.eslintrc.json',
        JSON.stringify({ root: true, overrides: [{ files: ['*.js'] }] }),
      );
      expect(addQualityEslintRules(tree)).toBe('added');
      const config = readJson(tree, '.eslintrc.json');
      expect(config.overrides[1]).toMatchObject({
        files: ['*.ts', '*.tsx'],
        plugins: ['import', 'unused-imports'],
        rules: { 'import/no-unresolved': 'warn', 'unused-imports/no-unused-imports': 'warn' },
      });
      expect(config.overrides[1].settings['import/resolver'].typescript.project).toBe(
        'tsconfig.base.json',
      );
      expect(addQualityEslintRules(tree)).toBe('present');
      expect(readJson(tree, '.eslintrc.json').overrides).toHaveLength(2);

      tree.write('.eslintrc.json', JSON.stringify({ rules: { 'import/no-unresolved': 'off' } }));
      expect(addQualityEslintRules(tree)).toBe('present');
      expect(readJson(tree, '.eslintrc.json').rules['import/no-unresolved']).toBe('off');
    });

    it('reports a config that is not .eslintrc.json', () => {
      tree.delete('.eslintrc.json');
      tree.write('.eslintrc.js', 'module.exports = {};');
      expect(addQualityEslintRules(tree)).toBe('no-json-config');
    });

    it('picks eslint-plugin-unused-imports for the @typescript-eslint major', () => {
      const pick = (v?: string) => {
        tree.write(
          'package.json',
          JSON.stringify({ devDependencies: v ? { '@typescript-eslint/eslint-plugin': v } : {} }),
        );
        return unusedImportsVersion(tree);
      };
      expect(pick('^5.62.0')).toBe('^2.0.0');
      expect(pick('~6.21.0')).toBe('^3.2.0');
      expect(pick('^7.0.0')).toBe('^3.2.0');
      expect(pick('^8.1.0')).toBe('^4.1.4');
      expect(pick()).toBe('^2.0.0');
    });
  });

  describe('lint-staged mode', () => {
    const config = () => readJson(tree, 'package.json')['lint-staged'];
    const WARN = 'node tools/scripts/lint-staged-eslint.js --fix';

    it('switches the ESLint step between warn and block, keeping other commands', () => {
      tree.write(
        'package.json',
        JSON.stringify({
          'lint-staged': {
            '*.{ts,html}': ['prettier --write'],
            '*.ts': ['prettier --write', 'eslint --fix'],
          },
        }),
      );
      expect(setLintStagedMode(tree, 'warn')).toBe('set');
      expect(config()['*.ts']).toEqual(['prettier --write', WARN]);
      expect(config()['*.{ts,html}']).toEqual(['prettier --write']);
      expect(tree.read(LINT_STAGED_ESLINT_SCRIPT, 'utf8')).toBe(LINT_STAGED_ESLINT_JS);
      expect(setLintStagedMode(tree, 'warn')).toBe('unchanged');
      expect(setLintStagedMode(tree, 'block')).toBe('set');
      expect(config()['*.ts']).toEqual(['prettier --write', 'eslint --fix']);
    });

    it('recognises npx eslint, keeps extra flags and string values', () => {
      tree.write(
        'package.json',
        JSON.stringify({
          'lint-staged': {
            '*.{ts,js}': 'npx eslint --fix --max-warnings=0 --cache',
            '*.md': 'prettier --write',
          },
        }),
      );
      expect(setLintStagedMode(tree, 'warn')).toBe('set');
      expect(config()['*.{ts,js}']).toBe(`${WARN} --max-warnings=0 --cache`);
      expect(config()['*.ts']).toBeUndefined();
      expect(setLintStagedMode(tree, 'block')).toBe('set');
      expect(config()['*.{ts,js}']).toBe('eslint --fix --max-warnings=0 --cache');
    });

    it('changes nothing without an ESLint step and reports other configs', () => {
      const pkg = { 'lint-staged': { '*.ts': ['nx affected:lint --fix --uncommitted'] } };
      tree.write('package.json', JSON.stringify(pkg));
      expect(setLintStagedMode(tree, 'block')).toBe('no-eslint-step');
      expect(config()).toEqual(pkg['lint-staged']);

      tree.write('package.json', JSON.stringify({}));
      expect(setLintStagedMode(tree, 'warn')).toBe('no-config');
      tree.write('.lintstagedrc.json', '{}');
      expect(setLintStagedMode(tree, 'warn')).toBe('other-config');
    });

    it('pstack infra --lint-staged switches it and rejects other values', async () => {
      tree.write('package.json', JSON.stringify({ 'lint-staged': { '*.ts': ['eslint --fix'] } }));
      await infraGenerator(tree, { with: 'none', lintStaged: 'warn', skipFormat: true });
      expect(config()['*.ts']).toEqual([WARN]);
      await expect(
        infraGenerator(tree, { with: 'none', lintStaged: 'loud', skipFormat: true }),
      ).rejects.toThrow('--lint-staged must be warn or block');
    });

    describe('the warn script', () => {
      let ws: string;
      beforeEach(() => {
        ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack lse '));
        fs.writeFileSync(path.join(ws, 'lint.js'), LINT_STAGED_ESLINT_JS);
      });
      afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

      /** A fake eslint that records its arguments and exits with ESLINT_EXIT. */
      const fakeEslint = () => {
        const bin = path.join(ws, 'node_modules', 'eslint', 'bin');
        fs.mkdirSync(bin, { recursive: true });
        // Like ESLint 8+: bin/eslint.js is not exported, only "." and package.json.
        fs.writeFileSync(
          path.join(ws, 'node_modules', 'eslint', 'package.json'),
          JSON.stringify({
            name: 'eslint',
            bin: { eslint: './bin/eslint.js' },
            exports: { './package.json': './package.json', '.': './api.js' },
          }),
        );
        fs.writeFileSync(
          path.join(bin, 'eslint.js'),
          "require('fs').writeFileSync(__dirname + '/args.json', JSON.stringify(process.argv.slice(2)));\n" +
            'process.exit(Number(process.env.ESLINT_EXIT || 0));\n',
        );
        return path.join(bin, 'args.json');
      };
      const run = (exit: number, args: string[]) =>
        spawnSync(process.execPath, [path.join(ws, 'lint.js'), ...args], {
          cwd: ws,
          encoding: 'utf8',
          env: { ...process.env, ESLINT_EXIT: String(exit) },
        });

      it('passes paths with spaces as single arguments and never blocks on lint problems', () => {
        const argsFile = fakeEslint();
        const file = path.join(ws, 'apps', 'my app', 'main (copy).ts');
        const problems = run(1, ['--fix', file]);
        expect(problems.status).toBe(0);
        expect(problems.stderr).toContain('the commit is not blocked');
        expect(problems.stderr).toContain('pstack infra --lint-staged=block');
        expect(JSON.parse(fs.readFileSync(argsFile, 'utf8'))).toEqual(['--fix', file]);
        expect(run(0, ['--fix', file]).status).toBe(0);
        expect(run(2, ['--fix', file]).status).toBe(2);
        expect(run(1, ['--fix']).status).toBe(0);
      });

      it('blocks when ESLint is not installed', () => {
        const r = run(0, ['--fix', 'a.ts']);
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('ESLint is not installed');
      });
    });
  });

  describe('review cases', () => {
    it('uses inputs the workspace defines', () => {
      tree.write('nx.json', JSON.stringify({ namedInputs: { default: ['{projectRoot}/**/*'] } }));
      addTypecheckNxDefaults(tree);
      expect(readJson(tree, 'nx.json').targetDefaults.typecheck.inputs).toEqual([
        'default',
        '^default',
        '{workspaceRoot}/tsconfig.base.json',
        '{workspaceRoot}/environments/**/*',
      ]);
      tree.write('nx.json', JSON.stringify({}));
      addTypecheckNxDefaults(tree);
      expect(readJson(tree, 'nx.json').targetDefaults.typecheck.inputs).toEqual([
        '{projectRoot}/**/*',
        '{workspaceRoot}/tsconfig.base.json',
        '{workspaceRoot}/environments/**/*',
      ]);
    });

    it('reads project.json and nx.json with comments', () => {
      tree.write('apps/portal/project.json', '// app\n{ "name": "portal", "targets": {} }\n');
      tree.write('apps/portal/tsconfig.app.json', '{}');
      tree.write('nx.json', '// nx\n{ "namedInputs": { "production": ["default"] } }\n');
      expect(addTypecheckTargets(tree)).toEqual(['portal']);
      expect(addTypecheckNxDefaults(tree)).toBe(true);
    });

    it('leaves an .eslintrc.json with comments alone and says so', () => {
      const text = '{\n  // shared\n  "root": true\n}\n';
      tree.write('.eslintrc.json', text);
      expect(addQualityEslintRules(tree)).toBe('has-comments');
      expect(tree.read('.eslintrc.json', 'utf8')).toBe(text);
      expect(eslintNote('has-comments')[0]).toContain('has comments');
    });

    it('resolves through tsconfig.json when there is no tsconfig.base.json', () => {
      tree.delete('tsconfig.base.json');
      tree.write('tsconfig.json', '{}');
      tree.write('.eslintrc.json', JSON.stringify({ root: true }));
      addQualityEslintRules(tree);
      const override = readJson(tree, '.eslintrc.json').overrides[0];
      expect(override.settings['import/resolver'].typescript.project).toBe('tsconfig.json');
    });

    it('reads the @typescript-eslint major from the parser or the meta package too', () => {
      tree.write(
        'package.json',
        JSON.stringify({ devDependencies: { 'typescript-eslint': '^8.0.0' } }),
      );
      expect(unusedImportsVersion(tree)).toBe('^4.1.4');
      tree.write(
        'package.json',
        JSON.stringify({ devDependencies: { '@typescript-eslint/parser': '^6.4.0' } }),
      );
      expect(unusedImportsVersion(tree)).toBe('^3.2.0');
    });

    it('pstack infra --with=quality also adds typecheck to a kept CI file', async () => {
      tree.write('.github/workflows/ci.yml', 'run: npx nx affected -t lint test build\n');
      tree.write(
        'package.json',
        JSON.stringify({
          devDependencies: {
            knip: '^5.0.0',
            secretlint: '^8.0.0',
            '@secretlint/secretlint-rule-preset-recommend': '^8.0.0',
            husky: '^9.0.0',
          },
        }),
      );
      await infraGenerator(tree, { with: 'quality', skipFormat: true });
      expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain('lint typecheck test build');
    });

    it('needs plugin 0.36.0 for pstack infra --lint-staged and documents it', () => {
      expect(() => assertLocalSupports('infra', '0.35.1', { lintStaged: 'block' })).toThrow(
        'pstack infra --lint-staged needs nx-polystack >= 0.36.0',
      );
      expect(helpText('0.36.0')).toContain('--lint-staged=warn|block');
    });
  });

  describe('quality-checks migration', () => {
    it('adds targets, nx defaults, CI step, warn rules and their packages', async () => {
      project('apps/portal', { name: 'portal', targets: {} }, 'tsconfig.app.json');
      tree.write('.github/workflows/ci.yml', 'run: npx nx affected -t lint test build\n');
      tree.write('.eslintrc.json', JSON.stringify({ root: true }));
      tree.write(
        'package.json',
        JSON.stringify({
          'lint-staged': { '*.ts': ['eslint --fix'] },
          devDependencies: { '@typescript-eslint/eslint-plugin': '^6.0.0' },
        }),
      );
      const task = await qualityChecks(tree);
      expect(task).toBeDefined();
      expect(readJson(tree, 'apps/portal/project.json').targets.typecheck).toBeDefined();
      expect(readJson(tree, 'nx.json').targetDefaults.typecheck.cache).toBe(true);
      expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain('lint typecheck test build');
      expect(readJson(tree, '.eslintrc.json').overrides[0].rules['import/no-unresolved']).toBe(
        'warn',
      );
      const pkg = readJson(tree, 'package.json');
      expect(pkg.devDependencies['eslint-plugin-unused-imports']).toBe('^3.2.0');
      expect(pkg.devDependencies['eslint-plugin-import']).toBe('^2.29.1');
      expect(pkg['lint-staged']['*.ts']).toEqual(['eslint --fix']);

      expect(await qualityChecks(tree)).toBeUndefined();
    });

    it('is listed for 0.36.0', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const manifest = require('../../migrations.json');
      expect(manifest.generators['quality-checks'].version).toBe('0.36.0');
    });
  });
});
