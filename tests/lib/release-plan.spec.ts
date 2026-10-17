import { configurationFor, planBuilds, WorkspaceProject } from '../../src/lib/release/plan';

const POLY = '@mouryaamit/nx-polystack:build';
const FLUTTER = '@mouryaamit/nx-polystack:flutter-build';

const angular = (name: string, configurations: Record<string, Record<string, unknown>>) => ({
  name,
  root: `apps/${name}`,
  json: {
    targets: {
      build: { executor: '@angular-devkit/build-angular:browser' },
      release: { executor: POLY, options: { outputPath: `dist/apps/${name}` }, configurations },
    },
  },
});
const flutter = (name: string): WorkspaceProject => ({
  name,
  root: `apps/${name}`,
  json: {
    targets: {
      'build-web': {
        executor: FLUTTER,
        options: { target: 'web', dist: `dist/apps/${name}/web` },
        configurations: { dev: { env: 'dev' }, uat: { env: 'uat' } },
      },
      'build-android': {
        executor: FLUTTER,
        options: { target: 'apk' },
        configurations: { uat: { env: 'uat' } },
      },
    },
  },
});
const lib: WorkspaceProject = { name: 'shared', root: 'libs/shared', json: { targets: {} } };

const projects: WorkspaceProject[] = [
  angular('portal', { dev: { env: 'DEV' }, uat: { env: 'UAT' } }),
  angular('admin', { development: { env: 'DEV' }, staging: { env: 'UAT', outputPath: 'dist/x' } }),
  angular('reports', { dev: { env: 'DEV' } }),
  flutter('mobile'),
  lib,
];

describe('configurationFor', () => {
  it('prefers the configuration named after the env, then the env option', () => {
    expect(configurationFor({ configurations: { UAT: {}, other: { env: 'uat' } } }, 'uat')).toBe(
      'UAT',
    );
    expect(configurationFor({ configurations: { staging: { env: 'UAT' } } }, 'uat')).toBe(
      'staging',
    );
    expect(configurationFor({ configurations: { dev: {} } }, 'uat')).toBeUndefined();
    expect(configurationFor({}, 'uat')).toBeUndefined();
  });
});

describe('planBuilds', () => {
  it('plans Angular/Ionic release and Flutter web builds sorted by name, listing missing ones', () => {
    const plan = planBuilds(projects, { env: 'uat' });
    expect(plan.jobs).toEqual([
      { project: 'admin', target: 'release', configuration: 'staging', output: 'dist/x' },
      {
        project: 'mobile',
        target: 'build-web',
        configuration: 'uat',
        output: 'dist/apps/mobile/web',
      },
      { project: 'portal', target: 'release', configuration: 'uat', output: 'dist/apps/portal' },
    ]);
    expect(plan.missing).toEqual([{ project: 'reports', target: 'release' }]);
  });

  it('adds the Flutter platforms asked for', () => {
    const plan = planBuilds([flutter('mobile')], {
      env: 'uat',
      flutterPlatforms: ['web', 'android', 'ios'],
    });
    expect(plan.jobs.map((j) => j.target)).toEqual(['build-web', 'build-android']);
    expect(plan.jobs[1].output).toBeUndefined();
  });

  it('limits to --projects and drops --exclude; unknown names fail', () => {
    expect(
      planBuilds(projects, {
        env: 'uat',
        projects: ['portal', 'mobile'],
        exclude: ['mobile'],
      }).jobs.map((j) => j.project),
    ).toEqual(['portal']);
    expect(() =>
      planBuilds(projects, { env: 'uat', projects: ['nope'], exclude: ['gone'] }),
    ).toThrow('unknown project(s): nope, gone');
  });

  it('refuses names that are not safe on a command line', () => {
    const bad: WorkspaceProject = {
      name: 'evil;rm',
      root: 'apps/evil',
      json: { targets: { release: { executor: POLY, configurations: { uat: {} } } } },
    };
    expect(() => planBuilds([bad], { env: 'uat' })).toThrow('"evil;rm" (apps/evil) is not a name');
  });
});
