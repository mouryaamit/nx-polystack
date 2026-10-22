import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { runEnv } from '../../src/cli/commands/env';
import { helpText } from '../../src/cli/help';
import { assertLocalSupports } from '../../src/cli/launcher';

import { makeCtx, tmpDir, writeJson } from './helpers';

function workspace(): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), { name: '@acme/source', scripts: {} });
  writeJson(path.join(ws, 'apps', 'portal', 'project.json'), {
    name: 'portal',
    targets: {
      build: {
        executor: '@angular-devkit/build-angular:browser',
        configurations: {
          uat: {
            fileReplacements: [
              {
                replace: 'environments/portal/environment.ts',
                with: 'environments/portal/environment.uat.ts',
              },
            ],
          },
        },
      },
      release: {
        executor: '@mouryaamit/nx-polystack:build',
        configurations: { uat: { env: 'UAT', buildConfiguration: 'uat', leakCheck: 'fail' } },
      },
    },
  });
  fs.mkdirSync(path.join(ws, 'environments', 'portal'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'environments/portal/environment.ts'),
    "export const environment = { envName: 'dev' };\n",
  );
  fs.writeFileSync(
    path.join(ws, 'environments/portal/environment.uat.ts'),
    "export const environment = { production: false, envName: 'uat' };\n",
  );
  fs.writeFileSync(path.join(ws, 'environments/portal/htaccess.prod'), '# portal prod\n');
  return ws;
}

describe('pstack env', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('adds the environment to the named app', async () => {
    const ws = workspace();
    await runEnv(makeCtx({ cwd: ws, flags: { name: 'qa', app: 'portal', production: 'false' } }));
    expect(fs.readFileSync(path.join(ws, 'environments/portal/environment.qa.ts'), 'utf8')).toMatch(
      /envName: ["']qa["']/,
    );
    expect(fs.readFileSync(path.join(ws, 'environments/portal/htaccess.qa'), 'utf8')).toBe(
      '# portal prod\n',
    );
    const pj = JSON.parse(fs.readFileSync(path.join(ws, 'apps/portal/project.json'), 'utf8'));
    expect(pj.targets.release.configurations.qa).toEqual({
      env: 'QA',
      buildConfiguration: 'qa',
      leakCheck: 'fail',
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'));
    expect(pkg.scripts['build:portal:qa']).toBe('nx run portal:release:qa');
  });

  it('requires --app or --all and reports generator errors plainly', async () => {
    const ws = workspace();
    await expect(runEnv(makeCtx({ cwd: ws, flags: { name: 'qa' } }))).rejects.toThrow(
      'Name the apps with --app=<a,b> or pass --all',
    );
    await expect(
      runEnv(makeCtx({ cwd: ws, flags: { name: 'qa', app: 'portal', all: true } })),
    ).rejects.toThrow('Name the apps');
    await expect(runEnv(makeCtx({ cwd: ws, flags: { name: 'qa', app: 'ghost' } }))).rejects.toThrow(
      /^no app with environments named ghost/,
    );
    await expect(
      runEnv(makeCtx({ cwd: ws, flags: { name: 'qa', from: true, app: 'portal' } })),
    ).rejects.toThrow('--from needs a value.');
  });

  it('needs plugin 0.34.0 for the new flags and documents them', () => {
    expect(() => assertLocalSupports('env', '0.33.0', { app: 'portal' })).toThrow(/0\.34\.0/);
    expect(helpText('0.34.0')).toContain('--from=<env>');
  });
});
