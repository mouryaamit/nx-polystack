import * as fs from 'fs';
import * as path from 'path';

import { runUpgrade, UpgradeDeps } from '../../src/cli/commands/upgrade';
import {
  addZoneProvider,
  dropUnusedNamedImport,
  enablePreferStandalone,
  keepNonceImportFirst,
  providersOnly,
  tidyMains,
} from '../../src/cli/commands/upgrade-standalone';
import { assertLocalSupports } from '../../src/cli/launcher';
import { scriptedPrompter } from '../../src/cli/prompt';
import { LLM_PROVIDERS, upsertBlock } from '../../src/lib/utils/llm-block';

import { makeCtx, REPO_ROOT, tmpDir, writeJson } from './helpers';

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
  unchanged: string[] = [],
) {
  const calls: string[] = [];
  const out: string[] = [];
  // The tree is clean at the start and after each commit; a schematic mode changes files unless
  // it is listed as unchanged.
  let dirty = false;
  const deps: UpgradeDeps = {
    exec(cmd, args) {
      calls.push(`${cmd} ${args.join(' ')}`);
      const mode = args.find((a) => a.startsWith('--mode='))?.slice('--mode='.length);
      if (mode) {
        onSchematic?.(mode);
        if (!unchanged.includes(mode)) dirty = true;
      }
      if (cmd === 'git' && args[0] === 'commit') dirty = false;
    },
    gitStatus: () => (dirty ? ' M x' : ''),
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
    // main.ts is tidied after the bootstrap mode, before its check and commit.
    const tidy = calls.indexOf('npx --no-install eslint --fix apps/web/src/main.ts');
    expect(tidy).toBeGreaterThan(calls.findIndex((c) => c.includes('--mode=standalone-bootstrap')));
    expect(calls[tidy + 1]).toBe('npx --no-install prettier --write apps/web/src/main.ts');
    expect(calls[tidy + 2]).toBe('npx nx run-many -t build lint');
    expect(calls.filter((c) => c.startsWith('git commit'))).toEqual([
      'git commit -m chore: convert-to-standalone (pstack upgrade standalone)',
      'git commit -m chore: prune-ng-modules (pstack upgrade standalone)',
      'git commit -m chore: standalone-bootstrap (pstack upgrade standalone)',
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

  it('--all refreshes the AI-assistant block to say standalone components', async () => {
    const ws = workspace();
    fs.writeFileSync(
      path.join(ws, 'CLAUDE.md'),
      upsertBlock(null, 'old block', LLM_PROVIDERS.claude),
    );
    const { deps, out } = fakeDeps(ws);
    await runUpgrade(
      makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true, skipCheck: true } }),
      deps,
    );
    const claude = fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('- Angular style: standalone components');
    expect(claude).not.toContain('old block');
    expect(out.join('\n')).toContain('CLAUDE.md: workspace block says standalone components');
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

  it('a mode that changes nothing is neither checked nor committed, and the run goes on', async () => {
    const ws = workspace();
    const { deps, calls, out } = fakeDeps(ws, undefined, {}, ['prune-ng-modules']);
    expect(
      await runUpgrade(
        makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true } }),
        deps,
      ),
    ).toBe(0);
    expect(calls.filter((c) => c.startsWith('git commit'))).toEqual([
      'git commit -m chore: convert-to-standalone (pstack upgrade standalone)',
      'git commit -m chore: standalone-bootstrap (pstack upgrade standalone)',
    ]);
    expect(calls.filter((c) => c === 'npx nx run-many -t build lint')).toHaveLength(2);
    expect(out.join('\n')).toContain('▶ prune-ng-modules: no changes');
  });

  it('an NgModule that only provides services does not start the schematic again', async () => {
    expect(
      providersOnly(
        '@NgModule({ exports: [], imports: [], providers: [provideHttpClient(withInterceptorsFromDi())] })\nexport class DataModule {}\n',
      ),
    ).toBe(true);
    expect(providersOnly('@NgModule({ declarations: [A], providers: [B] })')).toBe(false);
    expect(providersOnly('@NgModule({ imports: [CommonModule], exports: [CommonModule] })')).toBe(
      false,
    );
    // A workspace already converted, with such a module left: nothing to do.
    const ws = workspace();
    const file = (f: string, text: string) => fs.writeFileSync(path.join(ws, f), text);
    file(
      'apps/web/src/main.ts',
      "import { bootstrapApplication } from '@angular/platform-browser';\nbootstrapApplication(AppComponent, { providers: [] });\n",
    );
    fs.rmSync(path.join(ws, 'apps/web/src/app/app.module.ts'));
    file(
      'libs/shared/ui/src/lib/ui.module.ts',
      '@NgModule({ providers: [provideHttpClient()] })\nexport class UiModule {}\n',
    );
    const { deps, calls, out } = fakeDeps(ws);
    expect(
      await runUpgrade(
        makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true } }),
        deps,
      ),
    ).toBe(0);
    expect(calls).toEqual([]);
    expect(out.join('\n')).toContain('nothing to do');
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

  it('tidyMains keeps going when a tool is missing', () => {
    const said: string[] = [];
    const ran: string[] = [];
    tidyMains(
      '/ws',
      ['apps/web/src/main.ts'],
      {
        exec: (cmd, args) => {
          ran.push(args[1]);
          if (args[1] === 'eslint') throw new Error('not installed');
        },
      },
      (l) => void said.push(l),
    );
    expect(ran).toEqual(['eslint', 'prettier']);
    expect(said[0]).toContain('eslint could not tidy');
    tidyMains('/ws', [], { exec: () => ran.push('x') }, () => undefined);
    expect(ran).toHaveLength(2);
  });

  describe('--ionic', () => {
    const IONIC_MAIN = `import { importProvidersFrom } from '@angular/core';
import { BrowserModule, bootstrapApplication } from '@angular/platform-browser';
import { IonicModule } from '@ionic/angular';

import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, {
  providers: [importProvidersFrom(BrowserModule, IonicModule.forRoot())],
});
`;
    const IONIC_ROOT = `import { Component } from '@angular/core';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [IonicModule],
  template: '<ion-app><ion-router-outlet></ion-router-outlet></ion-app>',
})
export class AppComponent {}
`;

    /** A workspace with an Ionic app (already on bootstrapApplication unless moduleMain). */
    function ionicWorkspace(moduleMain = false): string {
      const ws = workspace('17.3.12');
      fs.rmSync(path.join(ws, 'apps/web'), { recursive: true });
      fs.rmSync(path.join(ws, 'libs/shared/ui'), { recursive: true });
      fs.symlinkSync(
        path.join(REPO_ROOT, 'node_modules/typescript'),
        path.join(ws, 'node_modules/typescript'),
      );
      writeJson(path.join(ws, 'apps/mobile/project.json'), {
        name: 'mobile',
        projectType: 'application',
      });
      const file = (f: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
        fs.writeFileSync(path.join(ws, f), text);
      };
      file('apps/mobile/src/main.ts', moduleMain ? MODULE_MAIN : IONIC_MAIN);
      file('apps/mobile/src/app/app.component.ts', IONIC_ROOT);
      if (moduleMain) {
        file(
          'apps/mobile/src/app/app.module.ts',
          "import { IonicModule } from '@ionic/angular';\n@NgModule({ imports: [IonicModule.forRoot()] })\nexport class AppModule {}\n",
        );
      }
      return ws;
    }

    /** Fake git: the tree is dirty when a file under apps/ differs from the last commit. */
    function gitDeps(ws: string) {
      const snap = () => {
        const out: string[] = [];
        const walk = (d: string) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else out.push(`${p}\n${fs.readFileSync(p, 'utf8')}`);
          }
        };
        walk(path.join(ws, 'apps'));
        return out.join('\n');
      };
      let committed = snap();
      return fakeDeps(ws, undefined, {
        exec(cmd, args) {
          calls.push(`${cmd} ${args.join(' ')}`);
          if (cmd === 'git' && args[0] === 'commit') committed = snap();
        },
        gitStatus: () => (snap() === committed ? '' : ' M x'),
      });
    }
    let calls: string[] = [];
    beforeEach(() => {
      calls = [];
    });

    it('runs ionic-standalone after standalone-providers, with its own check and commit', async () => {
      const ws = ionicWorkspace();
      const { deps, out } = gitDeps(ws);
      expect(
        await runUpgrade(
          makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true, ionic: true } }),
          deps,
        ),
      ).toBe(0);
      const log = out.join('\n');
      expect(log).toContain('  1. standalone-providers:');
      expect(log).toContain("  2. ionic-standalone: Ionic's standalone components");
      expect(calls.filter((c) => c.startsWith('git commit'))).toEqual([
        'git commit -m chore: standalone-providers (pstack upgrade standalone)',
        'git commit -m chore: ionic-standalone (pstack upgrade standalone)',
      ]);
      expect(calls.filter((c) => c === 'npx nx run-many -t build lint')).toHaveLength(2);
      const ionicCommit = calls.indexOf(
        'git commit -m chore: ionic-standalone (pstack upgrade standalone)',
      );
      expect(calls.slice(ionicCommit - 4, ionicCommit)).toEqual([
        'npx --no-install eslint --fix apps/mobile/src/app/app.component.ts apps/mobile/src/main.ts',
        'npx --no-install prettier --write apps/mobile/src/app/app.component.ts apps/mobile/src/main.ts',
        'npx nx run-many -t build lint',
        'git add -A',
      ]);
      const main = fs.readFileSync(path.join(ws, 'apps/mobile/src/main.ts'), 'utf8');
      expect(main).toContain('providers: [provideIonicAngular()]');
      expect(main).not.toContain('IonicModule');
      expect(log).not.toContain('Run again with --ionic');

      // A rerun finds nothing to do.
      calls.length = 0;
      out.length = 0;
      await runUpgrade(
        makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true, ionic: true } }),
        deps,
      );
      expect(calls).toEqual([]);
      expect(out.join('\n')).toContain('nothing to do');
    });

    it('comes last after the schematic modes on an app that bootstraps a module', async () => {
      const ws = ionicWorkspace(true);
      const { deps, out } = gitDeps(ws);
      await runUpgrade(
        makeCtx({
          cwd: ws,
          positionals: ['standalone'],
          flags: { all: true, ionic: true },
          dryRun: true,
        }),
        deps,
      );
      const steps = out.filter((l) => /^ {2}\d\. /.test(l)).map((l) => l.split(':')[0].trim());
      expect(steps).toEqual([
        '1. convert-to-standalone',
        '2. prune-ng-modules',
        '3. standalone-bootstrap',
        '4. standalone-providers',
        '5. ionic-standalone',
      ]);
    });

    it('lists Ionic libraries on IonicModule in the ionic-standalone step', async () => {
      const ws = ionicWorkspace();
      writeJson(path.join(ws, 'libs/ui/project.json'), { name: 'ui', projectType: 'library' });
      fs.mkdirSync(path.join(ws, 'libs/ui/src'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'libs/ui/src/card.component.ts'),
        "import { Component } from '@angular/core';\nimport { IonicModule } from '@ionic/angular';\n@Component({ selector: 'c', standalone: true, imports: [IonicModule], template: '<ion-card></ion-card>' })\nexport class CardComponent {}\n",
      );
      const { deps, out } = gitDeps(ws);
      await runUpgrade(
        makeCtx({
          cwd: ws,
          positionals: ['standalone'],
          flags: { project: 'ui', ionic: true },
          dryRun: true,
        }),
        deps,
      );
      const log = out.join('\n');
      expect(log).toContain('Standalone migration (Angular 17.3.12) of ui:');
      expect(log).toContain("  1. ionic-standalone: Ionic's standalone components");
      expect(log).toContain('(libs/ui)');
    });

    it('no Ionic app: no ionic-standalone step, and it says so', async () => {
      const ws = workspace();
      const { deps, out } = fakeDeps(ws);
      await runUpgrade(
        makeCtx({
          cwd: ws,
          positionals: ['standalone'],
          flags: { all: true, ionic: true },
          dryRun: true,
        }),
        deps,
      );
      const log = out.join('\n');
      expect(log).toContain('--ionic: no Ionic app or library on IonicModule');
      expect(log).not.toContain('ionic-standalone:');
    });

    it('the Ionic step runs by default (v1.18.0), as with --ionic', async () => {
      const ws = ionicWorkspace();
      const { deps, out } = gitDeps(ws);
      await runUpgrade(
        makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true } }),
        deps,
      );
      expect(calls.filter((c) => c.startsWith('git commit'))).toEqual([
        'git commit -m chore: standalone-providers (pstack upgrade standalone)',
        'git commit -m chore: ionic-standalone (pstack upgrade standalone)',
      ]);
      expect(fs.readFileSync(path.join(ws, 'apps/mobile/src/main.ts'), 'utf8')).toContain(
        'provideIonicAngular()',
      );
      expect(out.join('\n')).not.toContain('keep IonicModule');
    });

    it.each([[{ noIonic: true }], [{ ionic: 'false' }]])(
      '%j: no ionic step, Ionic apps keep IonicModule and the run says how to move them',
      async (flag) => {
        const ws = ionicWorkspace();
        const { deps, out } = gitDeps(ws);
        await runUpgrade(
          makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true, ...flag } }),
          deps,
        );
        expect(calls.filter((c) => c.startsWith('git commit'))).toEqual([
          'git commit -m chore: standalone-providers (pstack upgrade standalone)',
        ]);
        expect(fs.readFileSync(path.join(ws, 'apps/mobile/src/main.ts'), 'utf8')).toContain(
          'IonicModule.forRoot()',
        );
        const log = out.join('\n');
        expect(log).not.toContain('ionic-standalone');
        expect(log).toContain('as --no-ionic asks. Run again without it');
        expect(log).not.toContain('codemod');
      },
    );

    it('a workspace without Ionic says nothing about Ionic unless --ionic was asked for', async () => {
      const ws = workspace();
      for (const [flags, said] of [
        [{ all: true }, false],
        [{ all: true, ionic: true }, true],
      ] as const) {
        const { deps, out } = fakeDeps(ws);
        await runUpgrade(
          makeCtx({ cwd: ws, positionals: ['standalone'], flags: { ...flags }, dryRun: true }),
          deps,
        );
        expect(out.join('\n').includes('--ionic: no Ionic app or library')).toBe(said);
      }
    });

    it('--ionic needs nx-polystack 1.15.0 in the workspace when delegated', () => {
      expect(() => assertLocalSupports('upgrade', '1.14.0', { ionic: true }, 'standalone')).toThrow(
        'pstack upgrade --ionic needs nx-polystack >= 1.15.0',
      );
      expect(() =>
        assertLocalSupports('upgrade', '1.15.0', { ionic: true }, 'standalone'),
      ).not.toThrow();
    });
  });
});
