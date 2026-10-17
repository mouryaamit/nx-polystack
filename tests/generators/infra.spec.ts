import * as devkit from '@nx/devkit';
import { logger, readJson, Tree, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { DEV_GITHUB_REPO, setInstallSourceForTests } from '../../src/cli/install-source';
import infraGenerator, { applyInfra, INFRA_SCRIPTS } from '../../src/generators/infra/generator';
import {
  INFRA_PARTS,
  parseCiProviders,
  parseFlutterMode,
  parseParts,
  parseUpgradeSchedule,
  parseUpgradeScope,
  PREPUSH_MARKER,
} from '../../src/generators/infra/options';
import { hasFlutterProject, LLM_END, LLM_START } from '../../src/lib/utils/llm-block';

const DEV = { kind: 'github', repo: DEV_GITHUB_REPO } as const;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prettier: { format(s: string, o: object): string } = require('prettier');
// js-yaml is already installed (an eslint dependency); no types needed for one call.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml: { load(s: string): unknown } = require('js-yaml');

const DOCS = [
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
];
const CI_GITHUB = ['.github/workflows/ci.yml', '.github/workflows/pr-title.yml'];
const CI_COMMON = ['tools/scripts/check-cycles.js', 'tools/config/allowed-cycles.json'];
const QUALITY = ['knip.json', '.secretlintrc.json', '.secretlintignore', '.husky/pre-push'];
const UPGRADES = ['.github/workflows/dependency-upgrade.yml'];

const read = (tree: Tree, file: string): string => tree.read(file, 'utf8') ?? '';
const scripts = (tree: Tree): Record<string, string> =>
  readJson(tree, 'package.json').scripts ?? {};
const devDeps = (tree: Tree): Record<string, string> =>
  readJson(tree, 'package.json').devDependencies ?? {};

function workspace(base = 'master'): Tree {
  const tree = createTreeWithEmptyWorkspace();
  updateJson(tree, 'nx.json', (j) => ({ ...j, affected: { defaultBase: base } }));
  return tree;
}

/** A parsed workflow, loosely typed for property access in assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Steps of the only job in a workflow. */
function steps(doc: unknown): Array<Record<string, unknown>> {
  const jobs = (doc as { jobs: Record<string, { steps: Array<Record<string, unknown>> }> }).jobs;
  return Object.values(jobs)[0].steps;
}

describe('infra options', () => {
  it('--with defaults to all four parts; "all" and "none" are accepted', () => {
    expect(INFRA_PARTS).toEqual(['docs', 'ci', 'quality', 'upgrades']);
    expect(parseParts(undefined)).toEqual(['docs', 'ci', 'quality', 'upgrades']);
    expect(parseParts('')).toEqual(['docs', 'ci', 'quality', 'upgrades']);
    expect(parseParts('all')).toEqual(['docs', 'ci', 'quality', 'upgrades']);
    expect(parseParts('none')).toEqual([]);
  });

  it('--with keeps the canonical order, trims and de-duplicates', () => {
    expect(parseParts(' upgrades, docs ,docs')).toEqual(['docs', 'upgrades']);
  });

  it('--with rejects unknown parts with the supported list', () => {
    expect(() => parseParts('docs,lint')).toThrow(
      'unknown part "lint" in --with. Supported: docs, ci, quality, upgrades (or all, none).',
    );
    expect(() => parseParts('docs,none')).toThrow(/"none" cannot be combined/);
  });

  it('--ci defaults to github-actions and accepts both providers', () => {
    expect(parseCiProviders(undefined)).toEqual(['github-actions']);
    expect(parseCiProviders('')).toEqual(['github-actions']);
    expect(parseCiProviders('jenkins')).toEqual(['jenkins']);
    expect(parseCiProviders('jenkins, github-actions')).toEqual(['github-actions', 'jenkins']);
    expect(() => parseCiProviders('gitlab')).toThrow(
      'unknown CI provider "gitlab" in --ci. Supported: github-actions, jenkins.',
    );
  });

  it('--upgrade-schedule and --upgrade-scope are validated', () => {
    expect(parseUpgradeSchedule(undefined)).toBe('weekly');
    expect(parseUpgradeSchedule('monthly')).toBe('monthly');
    expect(() => parseUpgradeSchedule('daily')).toThrow(
      '--upgrade-schedule must be weekly or monthly (got "daily").',
    );
    expect(parseUpgradeScope(undefined)).toBe('polystack');
    expect(parseUpgradeScope('nx-minor')).toBe('nx-minor');
    expect(() => parseUpgradeScope('all')).toThrow(
      '--upgrade-scope must be polystack or nx-minor (got "all").',
    );
  });
});

describe('infra generator', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('writes every part by default (GitHub Actions)', async () => {
    const tree = workspace();
    await infraGenerator(tree, { skipFormat: true });
    for (const f of [...DOCS, ...CI_GITHUB, ...CI_COMMON, ...QUALITY, ...UPGRADES]) {
      expect(tree.exists(f)).toBe(true);
    }
    expect(tree.exists('Jenkinsfile')).toBe(false);
  });

  it('writes only the parts in --with', async () => {
    const tree = workspace();
    await infraGenerator(tree, { with: 'docs', skipFormat: true });
    for (const f of DOCS) expect(tree.exists(f)).toBe(true);
    for (const f of [...CI_GITHUB, ...CI_COMMON, ...QUALITY, ...UPGRADES]) {
      expect(tree.exists(f)).toBe(false);
    }
    expect(scripts(tree)['check:cycles']).toBeUndefined();
  });

  it('fails on an unknown part before writing anything', async () => {
    const tree = workspace();
    await expect(infraGenerator(tree, { with: 'docs,release' })).rejects.toThrow(
      /unknown part "release"/,
    );
    expect(tree.exists('CONTRIBUTING.md')).toBe(false);
  });

  describe('docs', () => {
    it('documents the branch flow, commits, pstack commands and checks', () => {
      const tree = workspace('main');
      applyInfra(tree, { with: 'docs' });
      const c = read(tree, 'CONTRIBUTING.md');
      expect(c).toContain('feature-<ticket>');
      expect(c).toContain('`main`');
      expect(c).toMatch(/feat\(<ticket>\): /);
      for (const cmd of ['pstack app', 'pstack lib', 'pstack env', 'npm run lint']) {
        expect(c).toContain(cmd);
      }
      expect(c).toContain('npx nx affected -t lint typecheck test build');
      expect(c).toMatch(
        /secret scan that blocks the push, then a\s+dependency audit that only warns/,
      );
      expect(c).toContain('npm run check:audit');
    });

    it('adopts the Contributor Covenant by reference, with a literal contact placeholder', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'docs' });
      const coc = read(tree, 'CODE_OF_CONDUCT.md');
      expect(coc).toContain('https://www.contributor-covenant.org/version/2/1/code_of_conduct/');
      expect(coc).toContain('<conduct-contact>');
      expect(coc.length).toBeLessThan(2500);
      const sec = read(tree, 'SECURITY.md');
      expect(sec).toContain('<security-contact>');
      expect(sec).toMatch(/encrypted at build/);
      expect(sec).toContain('.env');
    });

    it('lists the placeholders to fill in', () => {
      const tree = workspace();
      const report = applyInfra(tree, { with: 'docs' });
      expect(report.placeholders).toEqual([
        { file: 'CODE_OF_CONDUCT.md', placeholder: '<conduct-contact>' },
        { file: 'SECURITY.md', placeholder: '<security-contact>' },
      ]);
    });

    it('PR template has the checklist; issue forms are valid YAML', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'docs' });
      const pr = read(tree, '.github/PULL_REQUEST_TEMPLATE.md');
      for (const s of ['Ticket', 'Conventional', 'lint', 'secrets', 'Screenshots', '- [ ]']) {
        expect(pr).toContain(s);
      }
      const bug = yaml.load(read(tree, '.github/ISSUE_TEMPLATE/bug.yml')) as Record<
        string,
        unknown
      >;
      expect(bug['name']).toBeTruthy();
      expect(Array.isArray(bug['body'])).toBe(true);
      const feature = yaml.load(read(tree, '.github/ISSUE_TEMPLATE/feature.yml')) as Record<
        string,
        unknown
      >;
      expect(Array.isArray(feature['body'])).toBe(true);
      expect(yaml.load(read(tree, '.github/ISSUE_TEMPLATE/config.yml'))).toEqual({
        blank_issues_enabled: false,
      });
    });
  });

  describe('ci — GitHub Actions', () => {
    it('ci.yml: base branch from nx.json, pinned actions, affected + cycles', () => {
      const tree = workspace('develop');
      applyInfra(tree, { with: 'ci' });
      const text = read(tree, '.github/workflows/ci.yml');
      const doc = yaml.load(text) as Doc;
      expect(doc.on.push.branches).toEqual(['develop']);
      expect(doc.on).toHaveProperty('pull_request');
      const s = steps(doc);
      const uses = s.map((x) => x['uses']).filter(Boolean);
      expect(uses).toEqual(['actions/checkout@v5', 'actions/setup-node@v5', 'nrwl/nx-set-shas@v5']);
      expect(s[0]['with']).toEqual({ 'fetch-depth': 0 });
      expect(s[1]['with']).toEqual({ 'node-version-file': '.nvmrc', cache: 'npm' });
      const shas = s.find((x) => x['uses'] === 'nrwl/nx-set-shas@v5');
      expect(shas?.['with']).toEqual({ 'main-branch-name': 'develop' });
      const runs = s.map((x) => x['run']).filter(Boolean);
      expect(runs).toContain('npm ci');
      expect(runs).toContain('npx nx affected -t lint typecheck test build --parallel=3');
      expect(runs).toContain('npm run check:cycles');
      expect(text).not.toContain('actions/cache');
    });

    it('falls back to master when nx.json has no affected.defaultBase', () => {
      const tree = createTreeWithEmptyWorkspace();
      updateJson(tree, 'nx.json', (j) => {
        delete j.affected;
        return j;
      });
      applyInfra(tree, { with: 'ci' });
      const doc = yaml.load(read(tree, '.github/workflows/ci.yml')) as Doc;
      expect(doc.on.push.branches).toEqual(['master']);
    });

    it('--ci-cache adds an actions/cache step for the Nx cache after npm ci', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'ci', ciCache: true });
      const s = steps(yaml.load(read(tree, '.github/workflows/ci.yml')));
      const idx = s.findIndex((x) => x['uses'] === 'actions/cache@v5');
      expect(idx).toBeGreaterThan(s.findIndex((x) => x['run'] === 'npm ci'));
      expect((s[idx]['with'] as Record<string, string>)['path']).toBe('.nx/cache');
    });

    it('--ci-cache uses nx.json cacheDirectory when set', () => {
      const tree = workspace();
      updateJson(tree, 'nx.json', (j) => ({ ...j, cacheDirectory: 'tmp/nx-cache' }));
      applyInfra(tree, { with: 'ci', ciCache: true });
      const s = steps(yaml.load(read(tree, '.github/workflows/ci.yml')));
      const cache = s.find((x) => x['uses'] === 'actions/cache@v5');
      expect((cache?.['with'] as Record<string, string>)['path']).toBe('tmp/nx-cache');
    });

    it('pr-title.yml checks the title with the workspace commitlint, no third-party action', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'ci' });
      const doc = yaml.load(read(tree, '.github/workflows/pr-title.yml')) as Doc;
      expect(doc.on.pull_request.types).toEqual(['opened', 'edited', 'synchronize']);
      const s = steps(doc);
      const uses = s.map((x) => x['uses']).filter(Boolean) as string[];
      expect(uses.every((u) => u.startsWith('actions/'))).toBe(true);
      const check = s.find((x) => String(x['run'] ?? '').includes('commitlint'));
      expect(check?.['run']).toBe('echo "$TITLE" | npx --no-install commitlint');
      expect(check?.['env']).toEqual({ TITLE: '${{ github.event.pull_request.title }}' });
    });

    it('lets npm ci fetch the private plugin with PSTACK_REPO_TOKEN', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'ci' });
      for (const f of CI_GITHUB) {
        const s = steps(yaml.load(read(tree, f)));
        const auth = s.findIndex((x) => String(x['run'] ?? '').includes('insteadOf'));
        expect(auth).toBeGreaterThan(-1);
        expect(auth).toBeLessThan(s.findIndex((x) => x['run'] === 'npm ci'));
        expect(s[auth]['env']).toEqual({ PSTACK_REPO_TOKEN: '${{ secrets.PSTACK_REPO_TOKEN }}' });
      }
    });

    it('adds commitlint (deps + config) only when the workspace has none', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'ci' });
      expect(devDeps(tree)).toMatchObject({
        '@commitlint/cli': '^18.0.0',
        '@commitlint/config-conventional': '^18.0.0',
      });
      expect(read(tree, 'commitlint.config.js')).toContain('@commitlint/config-conventional');

      const other = workspace();
      updateJson(other, 'package.json', (j) => ({
        ...j,
        devDependencies: { '@commitlint/cli': '^19.0.0' },
      }));
      other.write('.commitlintrc.json', '{"extends":["@commitlint/config-conventional"]}');
      applyInfra(other, { with: 'ci' });
      expect(devDeps(other)['@commitlint/cli']).toBe('^19.0.0');
      expect(other.exists('commitlint.config.js')).toBe(false);
    });

    it('adds the check:cycles script and an empty allowlist', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'ci' });
      expect(scripts(tree)['check:cycles']).toBe('node tools/scripts/check-cycles.js');
      expect(JSON.parse(read(tree, 'tools/config/allowed-cycles.json'))).toEqual([]);
    });
  });

  describe('ci — Flutter', () => {
    const FLUTTER_STEP = {
      uses: 'subosito/flutter-action@v2',
      with: { channel: 'stable', cache: true },
    };
    const withFlutter = (where = 'apps/mobile') => {
      const tree = workspace();
      tree.write(`${where}/project.json`, JSON.stringify({ name: 'mobile' }));
      tree.write(`${where}/pubspec.yaml`, 'name: mobile\n');
      return tree;
    };
    const ciSteps = (tree: Tree) => steps(yaml.load(read(tree, '.github/workflows/ci.yml')));

    it('detects Flutter projects under apps/ and libs/ only', () => {
      expect(hasFlutterProject(workspace())).toBe(false);
      expect(hasFlutterProject(withFlutter())).toBe(true);
      expect(hasFlutterProject(withFlutter('libs/flutter/core'))).toBe(true);
      const elsewhere = workspace();
      elsewhere.write('tools/sample/pubspec.yaml', 'name: x\n');
      elsewhere.write('apps/web/node_modules/pkg/pubspec.yaml', 'name: x\n');
      expect(hasFlutterProject(elsewhere)).toBe(false);
    });

    it('ci.yml sets up Flutter after setup-node when the workspace has Flutter', () => {
      const tree = withFlutter();
      applyInfra(tree, { with: 'ci' });
      expect(read(tree, '.github/workflows/ci.yml')).toContain('has Flutter projects');
      const s = ciSteps(tree);
      const node = s.findIndex((x) => x['uses'] === 'actions/setup-node@v5');
      const idx = s.findIndex((x) => x['uses'] === 'subosito/flutter-action@v2');
      expect(idx).toBe(node + 1);
      expect(s[idx]).toEqual(FLUTTER_STEP);
    });

    it('ci.yml has no Flutter step without Flutter projects', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'ci' });
      const text = read(tree, '.github/workflows/ci.yml');
      expect(text).not.toContain('flutter-action');
      expect(text).toContain('pstack infra --with=ci --force');
    });

    it('--flutter=on forces it, --flutter=off removes it', () => {
      const on = workspace();
      applyInfra(on, { with: 'ci', flutter: 'on' });
      expect(ciSteps(on)).toContainEqual(FLUTTER_STEP);
      const off = withFlutter();
      applyInfra(off, { with: 'ci', flutter: 'off' });
      expect(read(off, '.github/workflows/ci.yml')).not.toContain('flutter-action');
    });

    it('rejects an unknown --flutter value', () => {
      expect(() => applyInfra(workspace(), { flutter: 'maybe' })).toThrow(
        '--flutter must be auto, on or off (got "maybe").',
      );
      expect(parseFlutterMode(undefined)).toBe('auto');
    });

    it('Jenkinsfile checks Flutter in Install before the Nx steps when present', () => {
      const tree = withFlutter();
      applyInfra(tree, { with: 'ci', ci: 'jenkins' });
      const j = read(tree, 'Jenkinsfile');
      expect(j).toMatch(/Flutter must be on the agent's PATH/);
      const flutter = j.indexOf("sh 'flutter --version'");
      expect(flutter).toBeGreaterThan(j.indexOf("stage('Install')"));
      expect(flutter).toBeLessThan(j.indexOf('npx nx affected'));
    });

    it('Jenkinsfile has no Flutter lines without Flutter projects', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'ci', ci: 'jenkins' });
      expect(read(tree, 'Jenkinsfile')).not.toMatch(/flutter/i);
    });
  });

  describe('ci — Jenkins', () => {
    it('Jenkinsfile: install, affected lint/test/build against CHANGE_TARGET or the base, cycles', () => {
      const tree = workspace('main');
      applyInfra(tree, { with: 'ci', ci: 'jenkins' });
      const j = read(tree, 'Jenkinsfile');
      expect(j).toContain("sh 'npm ci'");
      expect(j).toContain('env.CHANGE_TARGET');
      expect(j).toContain("'main'");
      expect(j).toContain('npx nx affected -t lint typecheck test build');
      expect(j).toContain('npm run check:cycles');
      expect(j).not.toContain('TARGET_ENV');
      expect(tree.exists('.github/workflows/ci.yml')).toBe(false);
      expect(tree.exists('tools/scripts/check-cycles.js')).toBe(true);
    });

    it('Jenkins only does not add commitlint (no PR-title workflow)', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'ci', ci: 'jenkins' });
      expect(tree.exists('.github/workflows/pr-title.yml')).toBe(false);
      expect(devDeps(tree)['@commitlint/cli']).toBeUndefined();
    });

    it('both providers write both', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'ci', ci: 'github-actions,jenkins' });
      expect(tree.exists('Jenkinsfile')).toBe(true);
      expect(tree.exists('.github/workflows/ci.yml')).toBe(true);
    });

    it('Jenkins only with upgrades: no workflow, and a note says the bot is GitHub-only', () => {
      const tree = workspace();
      const report = applyInfra(tree, { ci: 'jenkins' });
      expect(tree.exists('.github/workflows/dependency-upgrade.yml')).toBe(false);
      expect(report.notes.join('\n')).toMatch(/upgrade.*GitHub Actions only/i);
    });
  });

  describe('quality', () => {
    it('knip.json is conservative, valid JSON and has no entries that only produce hints', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'quality' });
      const knip = JSON.parse(read(tree, 'knip.json'));
      expect(knip).toEqual({
        $schema: 'https://unpkg.com/knip@5/schema.json',
        entry: ['apps/**/src/main.ts', 'libs/**/src/index.ts', 'tools/**/*.js'],
        project: ['apps/**/*.{js,ts}', 'libs/**/*.{js,ts}', 'tools/**/*.js'],
        ignoreDependencies: ['@mouryaamit/nx-polystack'],
      });
      expect(scripts(tree)['stale-code']).toBe('knip --no-exit-code');
      expect(devDeps(tree)['knip']).toBe('^5.0.0');
    });

    it('knip.json ignores the flutter and dart binaries only when the workspace has Flutter', () => {
      const tree = workspace();
      tree.write('apps/mobile/project.json', '{"name":"mobile"}');
      tree.write('apps/mobile/pubspec.yaml', 'name: mobile\n');
      applyInfra(tree, { with: 'quality' });
      expect(JSON.parse(read(tree, 'knip.json')).ignoreBinaries).toEqual(['flutter', 'dart']);
      const off = workspace();
      applyInfra(off, { with: 'quality', flutter: 'off' });
      expect(JSON.parse(read(off, 'knip.json')).ignoreBinaries).toBeUndefined();
    });

    it('knip.json is in the shape Prettier prints', () => {
      for (const flutter of ['on', 'off']) {
        const tree = workspace();
        applyInfra(tree, { with: 'quality', flutter });
        const text = read(tree, 'knip.json');
        expect(prettier.format(text, { parser: 'json', printWidth: 100 })).toBe(text);
      }
    });

    it('secretlint: config, ignore file, deps; check:prepush scans first and only warns on audit', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'quality' });
      expect(JSON.parse(read(tree, '.secretlintrc.json'))).toEqual({
        rules: [{ id: '@secretlint/secretlint-rule-preset-recommend' }],
      });
      const ignore = read(tree, '.secretlintignore').split('\n');
      expect(ignore).toEqual(expect.arrayContaining(['node_modules', 'dist', '.nx']));
      expect(devDeps(tree)).toMatchObject({
        secretlint: '^8.0.0',
        '@secretlint/secretlint-rule-preset-recommend': '^8.0.0',
      });
      const prepush = scripts(tree)['check:prepush'];
      expect(prepush).toBe(INFRA_SCRIPTS['check:prepush']);
      expect(prepush.startsWith('secretlint "**/*" && ')).toBe(true);
      expect(prepush).toMatch(/\(npm audit --omit=dev --audit-level=high \|\| echo [^)]*\)/);
      expect(prepush).toMatch(/&& echo .*npm run check:audit.*$/);
      expect(scripts(tree)['check:audit']).toBe('npm audit --omit=dev --audit-level=high');
    });

    it('writes .husky/pre-push with the marker when there is none', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'quality' });
      expect(read(tree, '.husky/pre-push')).toBe(`${PREPUSH_MARKER}\nnpm run check:prepush\n`);
    });

    it('appends to an existing .husky/pre-push exactly once', () => {
      const tree = workspace();
      tree.write('.husky/pre-push', 'npm test');
      const first = applyInfra(tree, { with: 'quality' });
      const once = read(tree, '.husky/pre-push');
      expect(once).toBe(`npm test\n${PREPUSH_MARKER}\nnpm run check:prepush\n`);
      expect(first.appended).toEqual(['.husky/pre-push']);

      const second = applyInfra(tree, { with: 'quality', force: true });
      expect(read(tree, '.husky/pre-push')).toBe(once);
      expect(second.appended).toEqual([]);
    });

    it('adds husky and its prepare script only when missing', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'quality' });
      expect(devDeps(tree)['husky']).toBe('^9.0.0');
      expect(scripts(tree)['prepare']).toBe('husky');

      const other = workspace();
      updateJson(other, 'package.json', (j) => ({
        ...j,
        scripts: { prepare: 'husky install' },
        devDependencies: { husky: '^8.0.0' },
      }));
      applyInfra(other, { with: 'quality' });
      expect(devDeps(other)['husky']).toBe('^8.0.0');
      expect(scripts(other)['prepare']).toBe('husky install');
    });
  });

  describe('upgrades', () => {
    const workflow = (tree: Tree) =>
      yaml.load(read(tree, '.github/workflows/dependency-upgrade.yml')) as Doc;

    it('weekly by default: Monday 03:17 UTC plus workflow_dispatch', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'upgrades' });
      const doc = workflow(tree);
      expect(doc.on.schedule).toEqual([{ cron: '17 3 * * 1' }]);
      expect(doc.on).toHaveProperty('workflow_dispatch');
    });

    it('monthly: the 1st at 03:17 UTC', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'upgrades', upgradeSchedule: 'monthly' });
      expect(workflow(tree).on.schedule).toEqual([{ cron: '17 3 1 * *' }]);
    });

    it('polystack scope: pstack update to the latest release, then a PR', () => {
      const tree = workspace('main');
      applyInfra(tree, { with: 'upgrades' });
      const text = read(tree, '.github/workflows/dependency-upgrade.yml');
      const s = steps(workflow(tree));
      const runs = s.map((x) => String(x['run'] ?? '')).join('\n');
      expect(runs).toContain('npx --no-install pstack update --to=');
      expect(runs).toContain('--allow-dirty');
      expect(runs).toContain('gh release view');
      expect(text).toContain('PSTACK_REPO_TOKEN');
      expect(runs).not.toContain('nx migrate');
      const pr = s.find((x) => x['uses'] === 'peter-evans/create-pull-request@v8');
      expect(pr?.['with']).toMatchObject({
        branch: 'chore/dependency-upgrade',
        base: 'main',
        title: 'chore(deps): scheduled dependency upgrade',
      });
      expect(s[0]).toMatchObject({ uses: 'actions/checkout@v5', with: { ref: 'main' } });
      expect(workflow(tree).permissions).toEqual({
        contents: 'write',
        'pull-requests': 'write',
      });
    });

    it('nx-minor scope: also migrates Nx within its current major', () => {
      const tree = workspace();
      applyInfra(tree, { with: 'upgrades', upgradeScope: 'nx-minor' });
      const runs = steps(workflow(tree))
        .map((x) => String(x['run'] ?? ''))
        .join('\n');
      expect(runs).toContain('npx --no-install pstack update');
      expect(runs).toContain('npx nx migrate "nx@${major}"');
      expect(runs).toContain('npx nx migrate --run-migrations');
      expect(runs).toContain('migrations.json');
      expect(runs).toContain('npm install');
    });

    it('notes the PSTACK_REPO_TOKEN secret', () => {
      const tree = workspace();
      const report = applyInfra(tree, { with: 'upgrades' });
      expect(report.notes.join('\n')).toContain('PSTACK_REPO_TOKEN');
    });

    it('an npm build needs no token: npm view finds the latest version (NX-51)', () => {
      setInstallSourceForTests({ kind: 'npm' });
      try {
        const tree = workspace();
        const report = applyInfra(tree, { with: 'upgrades,ci', flutter: 'on' });
        const text = read(tree, '.github/workflows/dependency-upgrade.yml');
        expect(text).not.toContain('PSTACK_REPO_TOKEN');
        expect(text).toContain('latest=$(npm view @mouryaamit/nx-polystack version)');
        expect(text).toContain('npx --no-install pstack update --to="${latest}" --allow-dirty');
        for (const f of CI_GITHUB) {
          expect(read(tree, f)).not.toContain('PSTACK_REPO_TOKEN');
          expect(() => yaml.load(read(tree, f))).not.toThrow();
        }
        expect(report.notes.join('\n')).not.toContain('PSTACK_REPO_TOKEN');
        expect(() => yaml.load(text)).not.toThrow();
      } finally {
        setInstallSourceForTests(DEV);
      }
    });
  });

  describe('all rendered YAML is valid', () => {
    it.each([
      ['defaults', {}],
      [
        'cache + flutter + monthly + nx-minor',
        { ciCache: true, flutter: 'on', upgradeSchedule: 'monthly', upgradeScope: 'nx-minor' },
      ],
    ])('%s', (_label, opts) => {
      const tree = workspace();
      applyInfra(tree, opts as Parameters<typeof applyInfra>[1]);
      const files = [...DOCS, ...CI_GITHUB, ...UPGRADES].filter((f) => f.endsWith('.yml'));
      for (const f of files) expect(() => yaml.load(read(tree, f))).not.toThrow();
      expect(files).toHaveLength(6);
    });
  });

  describe('never overwrite', () => {
    it('keeps existing files and lists them as skipped', () => {
      const tree = workspace();
      tree.write('CONTRIBUTING.md', '# Ours\n');
      tree.write('knip.json', '{}\n');
      const report = applyInfra(tree, {});
      expect(read(tree, 'CONTRIBUTING.md')).toBe('# Ours\n');
      expect(read(tree, 'knip.json')).toBe('{}\n');
      expect(report.skipped).toEqual(['CONTRIBUTING.md', 'knip.json']);
    });

    it('--force overwrites them', () => {
      const tree = workspace();
      tree.write('CONTRIBUTING.md', '# Ours\n');
      const report = applyInfra(tree, { force: true });
      expect(read(tree, 'CONTRIBUTING.md')).toContain('feature-<ticket>');
      expect(report.skipped).toEqual([]);
      expect(report.overwritten).toEqual(['CONTRIBUTING.md']);
    });

    it('a second run changes nothing', () => {
      const tree = workspace();
      applyInfra(tree, {});
      const before = tree.listChanges().map((c) => [c.path, c.content?.toString()]);
      const report = applyInfra(tree, {});
      const after = tree.listChanges().map((c) => [c.path, c.content?.toString()]);
      expect(after).toEqual(before);
      expect(report.written).toEqual([]);
      expect(report.skipped).toEqual([]);
    });

    it('prints the skipped list at the end', async () => {
      const tree = workspace();
      tree.write('SECURITY.md', '# Ours\n');
      const info = jest.spyOn(logger, 'info');
      await infraGenerator(tree, { skipFormat: true });
      const out = info.mock.calls.flat().join('\n');
      expect(out).toMatch(/Kept existing files \(pass --force to overwrite\):\n {2}SECURITY\.md/);
      expect(out).toContain('<conduct-contact> in CODE_OF_CONDUCT.md');
    });
  });

  describe('dependencies and scripts', () => {
    it('never changes an existing version or script', () => {
      const tree = workspace();
      updateJson(tree, 'package.json', (j) => ({
        ...j,
        scripts: { 'check:cycles': 'echo custom', 'stale-code': 'knip' },
        devDependencies: { knip: '^5.30.0', secretlint: '^9.0.0' },
      }));
      const report = applyInfra(tree, {});
      expect(scripts(tree)['check:cycles']).toBe('echo custom');
      expect(scripts(tree)['stale-code']).toBe('knip');
      expect(devDeps(tree)['knip']).toBe('^5.30.0');
      expect(devDeps(tree)['secretlint']).toBe('^9.0.0');
      expect(report.keptScripts).toEqual(['check:cycles', 'stale-code']);
    });

    it('returns an install task only when something was added', async () => {
      const tree = workspace();
      expect(typeof (await infraGenerator(tree, { skipFormat: true }))).toBe('function');
      expect(await infraGenerator(tree, { skipFormat: true })).toBeUndefined();
      expect(await infraGenerator(workspace(), { with: 'docs', skipFormat: true })).toBeUndefined();
    });
  });

  describe('llm block', () => {
    it('refreshes an existing block and lists the infra checks', async () => {
      const tree = workspace();
      tree.write('CLAUDE.md', `# CLAUDE.md\n\n${LLM_START}\nold\n${LLM_END}\n`);
      await infraGenerator(tree, { skipFormat: true });
      const claude = read(tree, 'CLAUDE.md');
      expect(claude).not.toContain('\nold\n');
      expect(claude).toContain('`npm run check:cycles`');
      expect(claude).toContain('`npm run stale-code`');
      expect(claude).toContain('`npm run check:audit`');
      expect(claude).toContain('`pstack infra`');
    });
  });

  it('formats unless skipFormat', async () => {
    const spy = jest.spyOn(devkit, 'formatFiles').mockResolvedValue(undefined);
    await infraGenerator(workspace(), { with: 'docs' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    await infraGenerator(workspace(), { with: 'docs', skipFormat: true });
    expect(spy).not.toHaveBeenCalled();
  });
});
