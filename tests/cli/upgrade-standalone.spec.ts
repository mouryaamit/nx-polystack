import * as fs from 'fs';
import * as path from 'path';

import { runUpgrade, UpgradeDeps } from '../../src/cli/commands/upgrade';
import {
  addZoneProvider,
  dropUnusedNamedImport,
  enablePreferStandalone,
  keepNonceImportFirst,
} from '../../src/cli/commands/upgrade-standalone';
import { assertLocalSupports } from '../../src/cli/launcher';
import { scriptedPrompter } from '../../src/cli/prompt';

import { makeCtx, tmpDir, writeJson } from './helpers';

const MODULE_MAIN = `// Gives <script>/<style> elements added at runtime the page's CSP nonce (keep it first).
import '@mouryaamit/nx-polystack/runtime/csp-nonce';

import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { AppModule } from './app/app.module';

platformBrowserDynamic().bootstrapModule(AppModule).catch((err) => console.error(err));
`;

function workspace(core = '15.2.10'): string {
  const ws = tmpDir('pstack-standalone-');
  writeJson(path.join(ws, 'nx.json'), {});
  writeJson(path.join(ws, 'package.json'), { dependencies: { '@angular/core': `~${core}` } });
  writeJson(path.join(ws, 'node_modules/@angular/core/package.json'), { version: core });
  const file = (f: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), text);
  };
  writeJson(path.join(ws, 'apps/web/project.json'), { name: 'web', projectType: 'application' });
  file('apps/web/src/main.ts', MODULE_MAIN);
  file('apps/web/src/app/app.module.ts', '@NgModule({})\nexport class AppModule {}\n');
  writeJson(path.join(ws, 'apps/web/.eslintrc.json'), {
    overrides: [{ files: ['*.ts'], rules: { '@angular-eslint/prefer-standalone': 'off' } }],
  });
  writeJson(path.join(ws, 'libs/shared/ui/project.json'), {
    name: 'shared-ui',
    projectType: 'library',
  });
  file('libs/shared/ui/src/lib/ui.module.ts', '@NgModule({})\nexport class UiModule {}\n');
  writeJson(path.join(ws, 'libs/shared/util/project.json'), { name: 'shared-util' });
  file('libs/shared/util/src/index.ts', 'export const x = 1;\n');
  return ws;
}

function fakeDeps(
  ws: string,
  onSchematic?: (mode: string) => void,
  over: Partial<UpgradeDeps> = {},
) {
  const calls: string[] = [];
  const out: string[] = [];
  const deps: UpgradeDeps = {
    exec(cmd, args) {
      calls.push(`${cmd} ${args.join(' ')}`);
      const mode = args.find((a) => a.startsWith('--mode='))?.slice('--mode='.length);
      if (mode) onSchematic?.(mode);
    },
    gitStatus: () => '',
    nodeMajor: () => 20,
    interactive: false,
    prompter: () => scriptedPrompter([]),
    log: (l) => void out.push(l),
    ...over,
  };
  return { deps, calls, out };
}

describe('pstack upgrade standalone', () => {
  it('--all: three modes over the workspace, a check and a commit each, fix-ups', async () => {
    const ws = workspace();
    const main = path.join(ws, 'apps/web/src/main.ts');
    const eslintFile = path.join(ws, 'apps/web/.eslintrc.json');
    const ruleBefore: Record<string, unknown> = {};
    const { deps, calls, out } = fakeDeps(ws, (mode) => {
      // AppComponent stays in AppModule until the bootstrap mode, so the rule stays off till then.
      ruleBefore[mode] = JSON.parse(fs.readFileSync(eslintFile, 'utf8')).overrides[0].rules[
        '@angular-eslint/prefer-standalone'
      ];
      if (mode === 'standalone-bootstrap') {
        // The schematic adds its imports above the side-effect import.
        fs.writeFileSync(
          main,
          "import { bootstrapApplication } from '@angular/platform-browser';\n" +
            "import { AppComponent } from './app/app.component';\n" +
            MODULE_MAIN.replace(
              'platformBrowserDynamic().bootstrapModule(AppModule)',
              'bootstrapApplication(AppComponent, { providers: [] })',
            ),
        );
      }
    });
    expect(
      await runUpgrade(
        makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true } }),
        deps,
      ),
    ).toBe(0);
    const g = calls.filter((c) => c.includes('@angular/core:standalone'));
    expect(g).toEqual([
      'npx nx g @angular/core:standalone --path=./ --mode=convert-to-standalone --interactive=false',
      'npx nx g @angular/core:standalone --path=./ --mode=prune-ng-modules --interactive=false',
      'npx nx g @angular/core:standalone --path=./ --mode=standalone-bootstrap --interactive=false',
    ]);
    expect(calls.filter((c) => c === 'npx nx run-many -t build lint')).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith('git commit'))).toEqual([
      'git commit -m chore: standalone convert-to-standalone (pstack upgrade standalone)',
      'git commit -m chore: standalone prune-ng-modules (pstack upgrade standalone)',
      'git commit -m chore: standalone standalone-bootstrap (pstack upgrade standalone)',
    ]);
    expect(fs.readFileSync(main, 'utf8')).toMatch(
      /^\/\/ Gives .*\nimport '@mouryaamit\/nx-polystack\/runtime\/csp-nonce';\n/,
    );
    expect(ruleBefore).toEqual({
      'convert-to-standalone': 'off',
      'prune-ng-modules': 'off',
      'standalone-bootstrap': 'off',
    });
    const eslint = JSON.parse(fs.readFileSync(eslintFile, 'utf8'));
    expect(eslint.overrides[0].rules).toEqual({});
    expect(JSON.parse(fs.readFileSync(path.join(ws, 'nx.json'), 'utf8')).pstack).toEqual({
      angular: { style: 'standalone' },
    });
    expect(out.join('\n')).toContain('of web, shared-ui:');
  });

  it('--project limits the paths; projects without NgModules are reported; no bootstrap for libs', async () => {
    const ws = workspace();
    const { deps, calls, out } = fakeDeps(ws);
    await runUpgrade(
      makeCtx({
        cwd: ws,
        positionals: ['standalone'],
        flags: { project: 'shared-ui,shared-util', skipCheck: true },
      }),
      deps,
    );
    expect(calls.filter((c) => c.includes('@angular/core:standalone'))).toEqual([
      'npx nx g @angular/core:standalone --path=libs/shared/ui --mode=convert-to-standalone --interactive=false',
      'npx nx g @angular/core:standalone --path=libs/shared/ui --mode=prune-ng-modules --interactive=false',
    ]);
    expect(out).toContain('shared-util: no NgModules, nothing to convert.');
    expect(calls).not.toContain('npx nx run-many -t build lint');
    expect(
      fs.existsSync(path.join(ws, 'nx.json')) &&
        JSON.parse(fs.readFileSync(path.join(ws, 'nx.json'), 'utf8')).pstack,
    ).toBeUndefined();
  });

  it('refuses: no selection, unknown project, dirty tree, Angular below 15.2; dry run changes nothing', async () => {
    const ws = workspace();
    const run = (flags: Record<string, unknown>, over: Partial<UpgradeDeps> = {}, dryRun = false) =>
      runUpgrade(
        makeCtx({ cwd: ws, positionals: ['standalone'], flags: flags as never, dryRun }),
        fakeDeps(ws, undefined, over).deps,
      );
    await expect(run({})).rejects.toThrow('pass --all');
    await expect(run({ project: 'nope' })).rejects.toThrow('no project named "nope"');
    await expect(run({ all: true }, { gitStatus: () => ' M x' })).rejects.toThrow(
      'commit or stash',
    );
    const { deps, calls } = fakeDeps(ws);
    await runUpgrade(
      makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true }, dryRun: true }),
      deps,
    );
    expect(calls).toEqual([]);
    const old = workspace('15.1.5');
    await expect(
      runUpgrade(
        makeCtx({ cwd: old, positionals: ['standalone'], flags: { all: true } }),
        fakeDeps(old).deps,
      ),
    ).rejects.toThrow('needs Angular 15.2 or later (installed: 15.1.5)');
  });

  it('Angular 21: keeps zone change detection in the bootstrapApplication providers', async () => {
    expect(
      addZoneProvider(
        "import { enableProdMode } from '@angular/core';\nbootstrapApplication(App, {\n  providers: [provideRouter(routes)],\n});\n",
      ),
    ).toBe(
      "import { enableProdMode, provideZoneChangeDetection } from '@angular/core';\nbootstrapApplication(App, {\n  providers: [provideZoneChangeDetection(), provideRouter(routes)],\n});\n",
    );
    expect(addZoneProvider('bootstrapApplication(App, appConfig);')).toBeUndefined();
  });

  it('keepNonceImportFirst and enablePreferStandalone', () => {
    const moved = keepNonceImportFirst(
      "import { a } from 'a';\n// Gives elements the page's CSP nonce (keep it first).\nimport '@mouryaamit/nx-polystack/runtime/csp-nonce';\n\nrun();\n",
    );
    expect(moved).toBe(
      "// Gives elements the page's CSP nonce (keep it first).\nimport '@mouryaamit/nx-polystack/runtime/csp-nonce';\n\nimport { a } from 'a';\n\nrun();\n",
    );
    expect(keepNonceImportFirst(MODULE_MAIN)).toBe(MODULE_MAIN);
    expect(enablePreferStandalone('/nope/.eslintrc.json')).toBe(false);
  });

  it('needs nx-polystack 1.10.3 in the workspace when delegated', () => {
    expect(() => assertLocalSupports('upgrade', '1.10.2', {}, 'standalone')).toThrow(
      'pstack upgrade standalone needs nx-polystack >= 1.10.3 in this workspace (found 1.10.2)',
    );
    expect(() => assertLocalSupports('upgrade', '1.10.2', {}, 'angular')).not.toThrow();
    expect(() => assertLocalSupports('upgrade', '1.10.3', {}, 'standalone')).not.toThrow();
  });

  it('Angular 21 bootstrap output: one provideZoneChangeDetection import, no unused platformBrowserDynamic', () => {
    // What the standalone-bootstrap schematic writes from a module main.ts with applicationProviders.
    const schematic =
      "import { enableProdMode, provideZoneChangeDetection, importProvidersFrom } from '@angular/core';\n" +
      "import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';\n" +
      "import { bootstrapApplication } from '@angular/platform-browser';\n" +
      "import { AppComponent } from './app/app.component';\n" +
      'bootstrapApplication(AppComponent, { providers: [importProvidersFrom(AppRoutingModule)] });\n';
    const zoned = addZoneProvider(schematic) ?? '';
    expect(zoned.match(/provideZoneChangeDetection\b/g)).toHaveLength(2);
    expect(zoned).toContain(
      "import { enableProdMode, provideZoneChangeDetection, importProvidersFrom } from '@angular/core';",
    );
    expect(zoned).toContain('providers: [provideZoneChangeDetection(), importProvidersFrom(');
    const tidy = dropUnusedNamedImport(
      zoned,
      'platformBrowserDynamic',
      '@angular/platform-browser-dynamic',
    );
    expect(tidy).not.toContain('platform-browser-dynamic');
    expect(tidy).toContain("import { bootstrapApplication } from '@angular/platform-browser';");
    // Still used, or another name in the import: kept.
    const used =
      "import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';\nplatformBrowserDynamic();\n";
    expect(
      dropUnusedNamedImport(used, 'platformBrowserDynamic', '@angular/platform-browser-dynamic'),
    ).toBe(used);
    expect(
      dropUnusedNamedImport(
        "import { a, platformBrowserDynamic } from '@angular/platform-browser-dynamic';\na();\n",
        'platformBrowserDynamic',
        '@angular/platform-browser-dynamic',
      ),
    ).toBe("import { a } from '@angular/platform-browser-dynamic';\na();\n");
  });
});
