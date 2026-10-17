import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { addProjectConfiguration } from '@nx/devkit';

import { envSecretWrapper } from '../../src/generators/migrate/nx/env-encryption';
import {
  decryptEnvironmentCalls,
  moduleScopeEnvReads,
  rewriteMainForGcm,
  rewriteWrapperForGcm,
  switchAppsToGcm,
} from '../../src/lib/env-encryption/switch-gcm';

const MAIN = `import { enableProdMode } from '@angular/core';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { AppModule } from './app/app.module';
import { environment } from '../../../environments/environment';

if (environment.production) enableProdMode();
platformBrowserDynamic()
  .bootstrapModule(AppModule)
  .catch((err) => console.error(err));
`;

/** A wrapper as pstack migrate wrote it before decryptEnvironmentAsync (trimmed). */
const OLD_WRAPPER = `// libs/shared/src/config/env-secret.ts
// Env secrets through the nx-polystack runtime module (rewritten by pstack migrate). The release
// build encrypts env values (nx.json pstack.envEncryption).
import {
  decryptEnvValue as runtimeDecryptEnvValue,
  decryptTree,
  envReadySync,
  envSecret as runtimeEnvSecret,
  getBuildMeta as runtimeGetBuildMeta,
  type BuildMeta,
} from '@mouryaamit/nx-polystack/runtime/env-secret';

import { environment } from '../../../../environments/environment';

/** Decrypts every ENC(...) value of the environment in place; returns the dotted paths decrypted. */
export function decryptEnvironment(
  env: Record<string, unknown> = environment as Record<string, unknown>,
): string[] {
  if (env !== (environment as unknown)) return decryptTree(env);
  return envReadySync(environment, { inPlace: true });
}
`;

describe('switch to aes-gcm', () => {
  it('rewrites a known main.ts once', () => {
    const out = rewriteMainForGcm(MAIN, '../../../environments/environment')!;
    expect(out).toContain(
      "import { envReady } from '@mouryaamit/nx-polystack/runtime/env-secret';",
    );
    expect(out).toContain(
      'envReady(environment, { inPlace: true })\n  .then(() => platformBrowserDynamic().bootstrapModule(AppModule))',
    );
    expect(rewriteMainForGcm(out, 'x')).toBe(out);
    expect(rewriteMainForGcm('bootstrapApplication(App);', 'x')).toBeUndefined();
  });

  it('adds the environment import when main.ts has none', () => {
    const noEnv = MAIN.replace(
      "import { environment } from '../../../environments/environment';\n",
      '',
    ).replace('if (environment.production) enableProdMode();\n', '');
    expect(rewriteMainForGcm(noEnv, '../../../environments/environment')).toContain(
      "import { environment } from '../../../environments/environment';",
    );
  });

  it('finds module-scope reads of non-public env fields only', () => {
    const src = `import { environment } from 'x';
export const API = environment.apiUrl;
export const C = { key: environment.aesKey, name: environment.envName };
export class S { url = environment.apiUrl; get() { return environment.uname; } }
function f() { return environment.servicePassword; }
`;
    expect(moduleScopeEnvReads(src, ['envName'])).toEqual(['apiUrl', 'aesKey']);
  });

  it('adds decryptEnvironmentAsync to a migrated env-secret wrapper once', () => {
    const out = rewriteWrapperForGcm(OLD_WRAPPER)!;
    expect(out).toContain(
      'export function decryptEnvironmentAsync(obj?: object): Promise<string[]> {\n' +
        '  return obj ? decryptTreeAsync(obj) : envReady(environment, { inPlace: true });\n}',
    );
    expect(out).toMatch(
      /decryptTree,\n {2}decryptTreeAsync,\n {2}envReady,\n {2}envReadySync,\n[^}]*\} from '@mouryaamit\/nx-polystack\/runtime\/env-secret';/,
    );
    expect(out).toContain('export function decryptEnvironment(');
    expect(rewriteWrapperForGcm(out)).toBe(out);
    const fresh = envSecretWrapper('libs/a/env-secret.ts', '../env/environment');
    expect(rewriteWrapperForGcm(fresh)).toBe(fresh);
    expect(rewriteWrapperForGcm('export const x = 1;\n')).toBeUndefined();
  });

  it('finds decryptEnvironment calls on objects outside environment', () => {
    const src = `import { decryptEnvironment } from '@acme/shared';
decryptEnvironment();
decryptEnvironment(environment);
decryptEnvironment(environment.profile);
decryptEnvironment(appProfile);
// decryptEnvironment(commented);
export function decryptEnvironment(env = environment) {}
const p = decryptEnvironment(this.load('x'));
await decryptEnvironmentAsync(other);
`;
    expect(decryptEnvironmentCalls(src)).toEqual(['appProfile', "this.load('x')"]);
  });

  it('switches every release app and reports what it could not do', () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'portal', {
      root: 'apps/portal',
      sourceRoot: 'apps/portal/src',
      targets: {
        build: {
          executor: '@angular-devkit/build-angular:browser',
          options: { main: 'apps/portal/src/main.ts' },
        },
        release: {
          executor: '@mouryaamit/nx-polystack:build',
          options: { type: 'angular', outputPath: 'dist/apps/portal', envProject: 'portal' },
        },
      },
    });
    tree.write('apps/portal/src/main.ts', MAIN);
    tree.write(
      'apps/portal/src/app/config.ts',
      "import { environment } from 'e';\nexport const K = environment.aesKey;\n",
    );
    tree.write(
      'apps/portal/src/app/profile.service.ts',
      "import { decryptEnvironment } from '@acme/shared';\n" +
        'export class P { load(p: object) { decryptEnvironment(p); } }\n',
    );
    addProjectConfiguration(tree, 'odd', {
      root: 'apps/odd',
      targets: {
        build: { executor: 'x', options: { main: 'apps/odd/main.ts' } },
        release: { executor: '@mouryaamit/nx-polystack:build', options: { envProject: 'odd' } },
      },
    });
    tree.write('apps/odd/main.ts', 'bootstrapApplication(App);\n');
    addProjectConfiguration(tree, 'shared', { root: 'libs/shared', sourceRoot: 'libs/shared/src' });
    tree.write('libs/shared/src/config/env-secret.ts', OLD_WRAPPER);
    const notes = switchAppsToGcm(tree, ['envName']);
    expect(tree.read('apps/portal/src/main.ts', 'utf8')).toContain(
      'envReady(environment, { inPlace: true })',
    );
    expect(notes.join('\n')).toMatch(/odd.*apps\/odd\/main\.ts.*await envReady/s);
    expect(notes.join('\n')).toMatch(/apps\/portal\/src\/app\/config\.ts: aesKey/);
    expect(tree.read('libs/shared/src/config/env-secret.ts', 'utf8')).toContain(
      'export function decryptEnvironmentAsync(',
    );
    expect(notes.join('\n')).toContain(
      'libs/shared/src/config/env-secret.ts now exports decryptEnvironmentAsync',
    );
    expect(notes).toContain(
      'apps/portal/src/app/profile.service.ts: decryptEnvironment(p) stays encrypted under aes-gcm ' +
        'unless the object is part of environment; use `await decryptEnvironmentAsync(p)`.',
    );
    expect(notes.join('\n')).not.toMatch(/getKey/);

    // Idempotent: a second run changes nothing and reports no rewrite.
    const again = switchAppsToGcm(tree, ['envName'], { keySources: ['commit', 'custom'] });
    expect(again.join('\n')).not.toMatch(/now awaits|now exports/);
    expect(again.join('\n')).toMatch(/custom.*getKey/s);
  });

  it('reports only listed keys in listed mode', () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'portal', {
      root: 'apps/portal',
      sourceRoot: 'apps/portal/src',
      targets: {
        release: { executor: '@mouryaamit/nx-polystack:build', options: { envProject: 'portal' } },
      },
    });
    tree.write(
      'apps/portal/src/app/config.ts',
      'export const A = environment.apiUrl;\nexport const K = environment.aesKey;\n',
    );
    const notes = switchAppsToGcm(tree, [], { mode: 'listed', keys: { default: ['aesKey'] } });
    expect(notes.join('\n')).toMatch(/config\.ts: aesKey read at import/);
    expect(notes.join('\n')).not.toMatch(/apiUrl/);
  });
});

describe('switch to aes-gcm: main.ts shapes', () => {
  const head =
    "import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';\n" +
    "import { AppModule } from './app/app.module';\n" +
    "import { environment } from '../../../environments/environment';\n\n";
  const rw = (body: string, meta?: string) => rewriteMainForGcm(head + body, 'x', meta);

  it('keeps a block catch handler', () => {
    const out = rw(
      'platformBrowserDynamic()\n  .bootstrapModule(AppModule)\n  .catch(err => { console.error(err); });\n',
    )!;
    expect(out).toContain(
      'envReady(environment, { inPlace: true })\n' +
        '  .then(() => platformBrowserDynamic().bootstrapModule(AppModule))\n' +
        '  .catch(err => { console.error(err); });\n',
    );
  });

  it('keeps a custom catch handler and comments with brackets', () => {
    const out = rw(
      'platformBrowserDynamic().bootstrapModule(AppModule)\n' +
        '  .catch((err) => { /* ) */ Sentry.captureException(err); });\n',
    )!;
    expect(out).toContain('.catch((err) => { /* ) */ Sentry.captureException(err); });');
    expect(out).not.toContain('console.error');
  });

  it('keeps bootstrap options', () => {
    const out = rw(
      "platformBrowserDynamic()\n  .bootstrapModule(AppModule, { ngZone: 'noop' })\n  .catch((e) => console.error(e));\n",
    )!;
    expect(out).toContain(
      ".then(() => platformBrowserDynamic().bootstrapModule(AppModule, { ngZone: 'noop' }))\n  .catch((e) => console.error(e));",
    );
  });

  it('wraps a bootstrap without catch and refuses unbalanced brackets', () => {
    expect(rw('platformBrowserDynamic().bootstrapModule(AppModule);\n')).toContain(
      'envReady(environment, { inPlace: true })\n  .then(() => platformBrowserDynamic().bootstrapModule(AppModule));\n',
    );
    expect(rw('platformBrowserDynamic().bootstrapModule(AppModule;\n')).toBeUndefined();
    expect(
      rw('platformBrowserDynamic().bootstrapModule(AppModule).catch((e) => f(e);\n'),
    ).toBeUndefined();
  });

  it('uses the local name of an aliased environment import', () => {
    const out = rewriteMainForGcm(
      "import { environment as env } from '../env/environment';\n" +
        'platformBrowserDynamic().bootstrapModule(AppModule);\n',
      '../other',
    )!;
    expect(out).toContain('envReady(env, { inPlace: true })');
    expect(out).not.toContain('../other');
  });

  it('passes metaName when it is not x-build', () => {
    const body = 'platformBrowserDynamic().bootstrapModule(AppModule);\n';
    expect(rw(body, 'x-app')).toContain(
      "envReady(environment, { inPlace: true, metaName: 'x-app' })",
    );
    expect(rw(body, 'x-build')).toContain('envReady(environment, { inPlace: true })');
  });

  it('checks for envReady in code, not comments', () => {
    const out = rw(
      '// envReady(environment) later\nplatformBrowserDynamic().bootstrapModule(AppModule);\n',
    )!;
    expect(out).toContain('.then(() => platformBrowserDynamic()');
    expect(rewriteMainForGcm(out, 'x')).toBe(out);
  });
});

describe('switch to aes-gcm: import-time reads', () => {
  it('defers arrow expression bodies', () => {
    expect(
      moduleScopeEnvReads(
        'export const P = [{ provide: X, useFactory: () => environment.x }];\n' +
          'export const f = () => ({ v: environment.y });\n' +
          'export const g = (a) => a + environment.z, h = environment.h2;\n',
        [],
      ),
    ).toEqual(['h2']);
  });

  it('reports template literals, static fields and destructuring', () => {
    expect(moduleScopeEnvReads('export const U = `${environment.apiUrl}/v1`;\n', [])).toEqual([
      'apiUrl',
    ]);
    expect(
      moduleScopeEnvReads(
        'export class A extends B { static X = environment.y; z = environment.w;\n' +
          '  static m() { return environment.q; } n = environment.n; }\n',
        [],
      ),
    ).toEqual(['y']);
    expect(
      moduleScopeEnvReads('const { a, b: bb, c = 1, ...rest } = environment;\n', ['c']),
    ).toEqual(['a', 'b']);
    expect(moduleScopeEnvReads('function f() { const { a } = environment; }\n', [])).toEqual([]);
  });

  it('ignores properties named environment', () => {
    expect(
      moduleScopeEnvReads('export const A = this.environment.k + cfg.environment.j;\n', []),
    ).toEqual([]);
  });
});

describe('switch to aes-gcm: workspace', () => {
  const release = (tree: ReturnType<typeof createTreeWithEmptyWorkspace>, main: string) => {
    addProjectConfiguration(tree, 'portal', {
      root: 'apps/portal',
      sourceRoot: 'apps/portal/src',
      targets: {
        build: { executor: 'b', options: { main: 'apps/portal/src/main.ts' } },
        release: { executor: '@mouryaamit/nx-polystack:build', options: { envProject: 'portal' } },
      },
    });
    tree.write('apps/portal/src/main.ts', main);
  };

  it('scans main.ts too (production excluded) and passes metaName', () => {
    const tree = createTreeWithEmptyWorkspace();
    release(
      tree,
      MAIN.replace(
        'if (environment.production)',
        'const u = environment.apiUrl;\nif (environment.production)',
      ),
    );
    const notes = switchAppsToGcm(tree, [], { metaName: 'x-app' });
    expect(tree.read('apps/portal/src/main.ts', 'utf8')).toContain("metaName: 'x-app'");
    expect(notes.join('\n')).toMatch(/apps\/portal\/src\/main\.ts: apiUrl read at import/);
    expect(notes.join('\n')).not.toMatch(/production/);
  });

  it('prints metaName in instructions for an unknown main.ts', () => {
    const tree = createTreeWithEmptyWorkspace();
    release(tree, 'bootstrapApplication(App);\n');
    expect(switchAppsToGcm(tree, [], { metaName: 'x-app' }).join('\n')).toContain(
      "await envReady(environment, { inPlace: true, metaName: 'x-app' })",
    );
  });

  it('says when no app builds with the release executor', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(switchAppsToGcm(tree, []).join('\n')).toMatch(/No app under apps\/.*release/);
  });

  it('treats only files with the pstack migrate marker as wrappers', () => {
    const plain = OLD_WRAPPER.replace(' (rewritten by pstack migrate)', '');
    expect(rewriteWrapperForGcm(plain)).toBeUndefined();
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'shared', { root: 'libs/shared', sourceRoot: 'libs/shared/src' });
    tree.write('libs/shared/src/env-secret.ts', plain);
    const notes = switchAppsToGcm(tree, []);
    expect(tree.read('libs/shared/src/env-secret.ts', 'utf8')).toBe(plain);
    expect(notes.join('\n')).not.toMatch(/env-secret\.ts/);
  });
});
