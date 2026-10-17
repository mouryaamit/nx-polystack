import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { COMMANDS } from '../../src/cli/commands';
import { runInfra } from '../../src/cli/commands/infra';
import { helpText } from '../../src/cli/help';
import {
  assertLocalSupports,
  MIN_LOCAL_VERSION,
  shouldDelegate,
  WORKSPACE_COMMANDS,
} from '../../src/cli/launcher';
import { CliError } from '../../src/cli/types';

import { fakeLocalPlugin, makeCtx, REPO_ROOT, tmpDir, writeJson } from './helpers';

function workspace(): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), { affected: { defaultBase: 'main' } });
  writeJson(path.join(ws, 'package.json'), {
    name: '@acme/source',
    scripts: {},
    // Already declared, so no install task runs in these tests.
    devDependencies: {
      nx: '17.0.6',
      knip: '^5.0.0',
      secretlint: '^8.0.0',
      '@secretlint/secretlint-rule-preset-recommend': '^8.0.0',
      husky: '^9.0.0',
      '@commitlint/cli': '^18.0.0',
      '@commitlint/config-conventional': '^18.0.0',
    },
  });
  return ws;
}

const exists = (ws: string, f: string) => fs.existsSync(path.join(ws, f));

describe('pstack infra', () => {
  let info: jest.SpyInstance;
  beforeEach(() => {
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('requires a workspace', async () => {
    await expect(runInfra(makeCtx({ cwd: tmpDir() }))).rejects.toThrow(
      /no nx.json found[\s\S]*pstack infra/,
    );
  });

  it('writes all parts from a subdirectory, then is a no-op', async () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, 'apps'));
    expect(
      await runInfra(makeCtx({ cwd: path.join(ws, 'apps'), flags: { skipFormat: true } })),
    ).toBe(0);
    for (const f of [
      'CONTRIBUTING.md',
      '.github/workflows/ci.yml',
      '.github/workflows/dependency-upgrade.yml',
      'knip.json',
      '.husky/pre-push',
      'tools/scripts/check-cycles.js',
    ]) {
      expect(exists(ws, f)).toBe(true);
    }
    info.mockClear();
    await runInfra(makeCtx({ cwd: ws, flags: { skipFormat: true } }));
    expect(info).toHaveBeenCalledWith('Nothing to generate.');
  });

  it('--with=docs --dry-run writes nothing', async () => {
    const ws = workspace();
    await runInfra(makeCtx({ cwd: ws, dryRun: true, flags: { with: 'docs' } }));
    expect(exists(ws, 'CONTRIBUTING.md')).toBe(false);
  });

  it('--force overwrites an existing file', async () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, 'SECURITY.md'), '# ours\n');
    await runInfra(makeCtx({ cwd: ws, flags: { with: 'docs', skipFormat: true } }));
    expect(fs.readFileSync(path.join(ws, 'SECURITY.md'), 'utf8')).toBe('# ours\n');
    await runInfra(makeCtx({ cwd: ws, flags: { with: 'docs', force: true, skipFormat: true } }));
    expect(fs.readFileSync(path.join(ws, 'SECURITY.md'), 'utf8')).toContain('<security-contact>');
  });

  it('passes --ci, --ci-cache, --upgrade-schedule and --upgrade-scope through', async () => {
    const ws = workspace();
    await runInfra(
      makeCtx({
        cwd: ws,
        flags: {
          ci: 'github-actions,jenkins',
          ciCache: true,
          upgradeSchedule: 'monthly',
          upgradeScope: 'nx-minor',
          skipFormat: true,
        },
      }),
    );
    expect(exists(ws, 'Jenkinsfile')).toBe(true);
    const ci = fs.readFileSync(path.join(ws, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('actions/cache@v5');
    const up = fs.readFileSync(path.join(ws, '.github/workflows/dependency-upgrade.yml'), 'utf8');
    expect(up).toContain("'17 3 1 * *'");
    expect(up).toContain('nx migrate');
  });

  it('--flutter: auto detects a Flutter app, on/off override', async () => {
    const ws = workspace();
    writeJson(path.join(ws, 'apps/mobile/project.json'), { name: 'mobile' });
    fs.writeFileSync(path.join(ws, 'apps/mobile/pubspec.yaml'), 'name: mobile\n');
    const ci = () => fs.readFileSync(path.join(ws, '.github/workflows/ci.yml'), 'utf8');
    await runInfra(makeCtx({ cwd: ws, flags: { with: 'ci', skipFormat: true } }));
    expect(ci()).toContain('subosito/flutter-action@v2');
    await runInfra(
      makeCtx({ cwd: ws, flags: { with: 'ci', flutter: 'off', force: true, skipFormat: true } }),
    );
    expect(ci()).not.toContain('flutter-action');
    const other = workspace();
    await runInfra(makeCtx({ cwd: other, flags: { with: 'ci', flutter: 'on', skipFormat: true } }));
    expect(fs.readFileSync(path.join(other, '.github/workflows/ci.yml'), 'utf8')).toContain(
      'subosito/flutter-action@v2',
    );
  });

  it.each([
    [{ with: 'docs,bogus' }, /unknown part "bogus" in --with/],
    [{ with: true }, /--with needs a value/],
    [{ ci: 'gitlab' }, /unknown CI provider "gitlab"/],
    [{ ciCache: 'maybe' }, /--ci-cache must be true or false/],
    [{ upgradeSchedule: 'daily' }, /--upgrade-schedule must be weekly or monthly/],
    [{ upgradeScope: 'all' }, /--upgrade-scope must be polystack or nx-minor/],
    [{ flutter: 'yes' }, /--flutter must be auto, on or off/],
    [{ flutter: true }, /--flutter needs a value/],
  ])('rejects %j as a usage error', async (flags, message) => {
    const ws = workspace();
    const err = runInfra(makeCtx({ cwd: ws, flags: flags as Record<string, string | boolean> }));
    await expect(err).rejects.toBeInstanceOf(CliError);
    await expect(err).rejects.toThrow(message);
    expect(exists(ws, 'CONTRIBUTING.md')).toBe(false);
  });

  it('is registered, delegated from the workspace root, needs 0.9.0 locally, and is in the help', () => {
    expect(COMMANDS['infra']).toBeDefined();
    expect(WORKSPACE_COMMANDS.has('infra')).toBe(true);
    expect(MIN_LOCAL_VERSION['infra']).toBe('0.9.0');
    expect(() => assertLocalSupports('infra', '0.8.1')).toThrow(
      'pstack infra needs nx-polystack >= 0.9.0 in this workspace (found 0.8.1). ' +
        'Run "pstack update" first.',
    );
    expect(() => assertLocalSupports('infra', '0.9.0')).not.toThrow();
    const help = helpText('0.0.0');
    expect(help).toContain('OPTIONS — infra');
    expect(help).toContain('pstack infra --with=docs,ci --ci=jenkins');
    expect(help).toContain('--infra=<parts>');
    expect(help).toContain('--flutter=<mode>');
  });

  it('delegates to a different local install', () => {
    const ws = tmpDir();
    const root = fakeLocalPlugin(ws, '0.9.0');
    expect(
      shouldDelegate({
        command: 'infra',
        flags: {},
        env: {},
        selfRoot: REPO_ROOT,
        local: { root, version: '0.9.0', cliPath: path.join(root, 'dist/bin/cli.js') },
      }),
    ).toBe(true);
  });
});
