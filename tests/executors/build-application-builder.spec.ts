import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import buildExecutor, { Runner } from '../../src/executors/build/executor';
import { BuildExecutorSchema } from '../../src/executors/build/schema.d';

/**
 * The release build through a real-shaped Angular 17+ application-builder target (NX-113). The
 * fake Angular build writes where @angular/build:application would: a CLI `--outputPath=<dir>`
 * replaces the outputPath object, so the app goes to <dir>/browser/; without it the target's own
 * `{ base, browser }` is used (browser defaults to "browser"; "" means base itself).
 */

type Json = Record<string, unknown>;

let ws: string;
let commands: string[];

/** What @angular/build:application writes for a command and the target config. */
function angularBuild(target: Json): Runner {
  return (cmd: string) => {
    commands.push(cmd);
    const config = /:(\w+)\s/.exec(cmd.replace(/^npx nx run [^:]+/, ''))?.[1] ?? 'production';
    const options = {
      ...((target['options'] as Json) ?? {}),
      ...(((target['configurations'] as Record<string, Json>) ?? {})[config] ?? {}),
    };
    const flag = /--outputPath=(\S+)/.exec(cmd)?.[1];
    let base: string;
    let browser: string;
    if (flag) {
      base = flag;
      browser = 'browser';
    } else {
      const out = options['outputPath'] as Json;
      base = out['base'] as string;
      browser = out['browser'] === undefined ? 'browser' : (out['browser'] as string);
    }
    const root = path.join(ws, base);
    const served = path.join(root, browser);
    fs.mkdirSync(path.join(served, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(served, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>' +
        '<body><app-root></app-root><script src="main.js" type="module"></script></body></html>',
    );
    fs.writeFileSync(path.join(served, 'main.js'), 'console.log(1);');
    fs.writeFileSync(path.join(served, 'styles.css'), 'a{}');
    fs.writeFileSync(path.join(root, '3rdpartylicenses.txt'), 'licenses');
    fs.writeFileSync(path.join(root, 'prerendered-routes.json'), '{"routes":[]}');
  };
}

/** A workspace with app "web" whose build target is the given application-builder target. */
function workspace(build: Json): ExecutorContext {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-build-appb-'));
  fs.mkdirSync(path.join(ws, 'environments', 'web'), { recursive: true });
  for (const env of ['dev', 'uat', 'prod']) {
    fs.writeFileSync(path.join(ws, 'environments', 'web', `htaccess.${env}`), `# ${env}\n`);
  }
  fs.writeFileSync(
    path.join(ws, 'environments', 'web', 'environment.prod.ts'),
    "export const environment = { production: true, apiUrl: 'https://api.example.com' };",
  );
  fs.writeFileSync(path.join(ws, 'nx.json'), '{}');
  return {
    projectName: 'web',
    targetName: 'release',
    root: ws,
    isVerbose: false,
    projectsConfigurations: {
      version: 2,
      projects: { web: { root: 'apps/web', targets: { build } } },
    },
  } as unknown as ExecutorContext;
}

const release = (extra: Partial<BuildExecutorSchema> = {}): BuildExecutorSchema => ({
  type: 'angular',
  outputPath: 'dist/web-app',
  envProject: 'web',
  env: 'PROD',
  buildTarget: 'web:build',
  secure: true,
  ...extra,
});

const applicationTarget = (outputPath: unknown, configurations: Json = {}): Json => ({
  executor: '@angular/build:application',
  options: { outputPath, index: 'apps/web/src/index.html', browser: 'apps/web/src/main.ts' },
  configurations: { production: { outputHashing: 'all' }, ...configurations },
});

describe('release build of an application-builder app (NX-113)', () => {
  beforeEach(() => {
    commands = [];
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('{ base, browser: "" }: no --outputPath, everything in dist/<app>/, no browser/ folder', async () => {
    const target = applicationTarget({ base: 'dist/web-app', browser: '' });
    const ctx = workspace(target);
    await expect(buildExecutor(release(), ctx, angularBuild(target))).resolves.toEqual({
      success: true,
    });
    expect(commands).toEqual(['npx nx run web:build:production --skip-nx-cache']);
    const dist = path.join(ws, 'dist/web-app');
    expect(fs.readdirSync(dist).sort()).toEqual([
      '.htaccess',
      '3rdpartylicenses.txt',
      'assets',
      'index.html',
      'main.js',
      'prerendered-routes.json',
      'styles.css',
    ]);
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    expect(html).toMatch(/<meta name="x-build" content="[^"]+">/);
    expect(html).toContain('nonce=');
    expect(fs.readFileSync(path.join(dist, '.htaccess'), 'utf8')).toBe('# prod\n');
  });

  it('a configuration that sets the outputPath is the one used', async () => {
    const target = applicationTarget(
      { base: 'dist/web-app' },
      { production: { outputPath: { base: 'dist/web-app', browser: '' } } },
    );
    const ctx = workspace(target);
    await buildExecutor(release(), ctx, angularBuild(target));
    expect(fs.existsSync(path.join(ws, 'dist/web-app/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'dist/web-app/browser'))).toBe(false);
  });

  it.each([
    ['browser left out (Angular puts the app in browser/)', { base: 'dist/web-app' }],
    ['browser "browser"', { base: 'dist/web-app', browser: 'browser' }],
    ['a string outputPath', 'dist/web-app'],
  ])('refuses %s before anything is built', async (_why, outputPath) => {
    const target = applicationTarget(outputPath);
    const ctx = workspace(target);
    const envFile = path.join(ws, 'environments/web/environment.prod.ts');
    const before = fs.readFileSync(envFile, 'utf8');
    await expect(buildExecutor(release(), ctx, angularBuild(target))).rejects.toThrow(
      'Release builds have no browser/ folder: set its outputPath to {"base":"dist/web-app","browser":""}',
    );
    expect(commands).toEqual([]);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(before);
  });

  it('refuses a release outputPath that is not the build base', async () => {
    const target = applicationTarget({ base: 'dist/portal', browser: '' });
    const ctx = workspace(target);
    await expect(buildExecutor(release(), ctx, angularBuild(target))).rejects.toThrow(
      'the release outputPath is "dist/web-app" but web:build:production builds to "dist/portal". ' +
        'Set the release target\'s outputPath to "dist/portal".',
    );
    expect(commands).toEqual([]);
  });

  it('refuses server rendering', async () => {
    const target = applicationTarget(
      { base: 'dist/web-app', browser: '' },
      { production: { ssr: { entry: 'apps/web/src/server.ts' } } },
    );
    const ctx = workspace(target);
    await expect(buildExecutor(release(), ctx, angularBuild(target))).rejects.toThrow(
      'web:build:production sets "ssr" (server rendering)',
    );
  });

  it('fails when the build still made a browser/ folder', async () => {
    const target = applicationTarget({ base: 'dist/web-app', browser: '' });
    const ctx = workspace(target);
    // A build that ignores the config (e.g. an older builder): browser/ appears anyway.
    const wrong = angularBuild({ ...target, options: { outputPath: { base: 'dist/web-app' } } });
    await expect(buildExecutor(release(), ctx, wrong)).rejects.toThrow(
      'the build wrote dist/web-app/browser/; release builds have no browser/ folder',
    );
  });

  it('a browser-builder app (string outputPath) builds exactly as before', async () => {
    const target: Json = {
      executor: '@angular-devkit/build-angular:browser',
      options: { outputPath: 'dist/apps/web' },
    };
    const ctx = workspace(target);
    const runner: Runner = (cmd) => {
      commands.push(cmd);
      fs.mkdirSync(path.join(ws, 'dist/apps/web'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'dist/apps/web/index.html'), '<html><head></head></html>');
    };
    await buildExecutor(release({ outputPath: 'dist/apps/web', secure: false }), ctx, runner);
    expect(commands).toEqual([
      'npx nx run web:build:production --outputPath=dist/apps/web --skip-nx-cache',
    ]);
    expect(fs.readFileSync(path.join(ws, 'dist/apps/web/index.html'), 'utf8')).toContain(
      '<meta name="x-build"',
    );
  });

  it('the meta goes into the served index.html; none at all fails the build', async () => {
    const target = applicationTarget({ base: 'dist/web-app', browser: '' });
    const ctx = workspace(target);
    const noIndex: Runner = (cmd) => {
      commands.push(cmd);
      fs.mkdirSync(path.join(ws, 'dist/web-app'), { recursive: true });
    };
    await expect(buildExecutor(release(), ctx, noIndex)).rejects.toThrow(
      'index.html not found under dist/web-app; the build meta could not be written',
    );
  });
});
