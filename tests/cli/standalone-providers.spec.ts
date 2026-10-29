import * as fs from 'fs';
import * as path from 'path';

import {
  loadTypescript,
  ProvidersResult,
  tidyStandaloneProviders,
} from '../../src/cli/commands/standalone-providers';
import { runUpgrade, UpgradeDeps } from '../../src/cli/commands/upgrade';
import { scriptedPrompter } from '../../src/cli/prompt';

import { makeCtx, REPO_ROOT, tmpDir, writeJson } from './helpers';

const ts = loadTypescript(REPO_ROOT);
if (!ts) throw new Error('typescript is a devDependency of the plugin');

const MAIN = (
  providers: string,
  extraImports = '',
) => `// Gives <script>/<style> elements added at runtime the page's CSP nonce (keep it first).
import '@mouryaamit/nx-polystack/runtime/csp-nonce';

import { provideHttpClient } from '@angular/common/http';
import { enableProdMode, importProvidersFrom } from '@angular/core';
import { BrowserModule, bootstrapApplication } from '@angular/platform-browser';
${extraImports}
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, {
  providers: [${providers}],
}).catch((err) => console.error(err));
`;

const ROUTING = (
  forRoot: string,
  head = '',
  decorator = '',
) => `import { NgModule } from '@angular/core';
import { PreloadAllModules, RouterModule, Routes } from '@angular/router';
${head}
const routes: Routes = [
  { path: '', loadChildren: () => import('./home/home.module').then((m) => m.HomeModule) },
];

@NgModule({
  imports: [RouterModule.forRoot(${forRoot})],
  exports: [RouterModule],${decorator}
})
export class AppRoutingModule {}
`;

function app(files: Record<string, string>): { ws: string; src: string } {
  const ws = tmpDir('pstack-providers-');
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(ws, 'apps/web/src', f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return { ws, src: path.join(ws, 'apps/web/src') };
}

function tidy(ws: string, src: string, major = 21): ProvidersResult {
  const result: ProvidersResult = { writes: new Map(), renames: new Map(), done: [], notes: [] };
  tidyStandaloneProviders(ts as never, ws, path.join(src, 'main.ts'), src, major, result);
  return result;
}

describe('standalone providers tidy-up', () => {
  it('drops BrowserModule, and importProvidersFrom when nothing else is in it', () => {
    const { ws, src } = app({
      'main.ts': MAIN('\n    importProvidersFrom(BrowserModule),\n    provideHttpClient(),\n  '),
    });
    const r = tidy(ws, src);
    const out = r.writes.get(path.join(src, 'main.ts')) ?? '';
    expect(out).not.toContain('BrowserModule');
    expect(out).not.toContain('importProvidersFrom');
    expect(out).toContain("import { enableProdMode } from '@angular/core';");
    expect(out).toContain("import { bootstrapApplication } from '@angular/platform-browser';");
    expect(out).toContain('providers: [\n    provideHttpClient(),\n  ]');
    expect(r.done).toEqual(['apps/web/src/main.ts: BrowserModule dropped']);
  });

  it('keeps other modules in importProvidersFrom', () => {
    const { ws, src } = app({
      'main.ts': MAIN(
        'provideHttpClient(), importProvidersFrom(BrowserModule, IonicModule.forRoot())',
        "import { IonicModule } from '@ionic/angular/lazy';",
      ),
    });
    const out = tidy(ws, src).writes.get(path.join(src, 'main.ts')) ?? '';
    expect(out).toContain(
      'providers: [provideHttpClient(), importProvidersFrom(IonicModule.forRoot())]',
    );
    expect(out).toContain("import { enableProdMode, importProvidersFrom } from '@angular/core';");
  });

  it('turns the root routing module into provideRouter and a routes file', () => {
    const { ws, src } = app({
      'main.ts': MAIN(
        'importProvidersFrom(BrowserModule, AppRoutingModule), provideHttpClient()',
        "import { AppRoutingModule } from './app/app-routing.module';",
      ),
      'app/app-routing.module.ts': ROUTING(
        "routes, { useHash: true, initialNavigation: 'enabledBlocking', preloadingStrategy: PreloadAllModules, scrollPositionRestoration: 'top', anchorScrolling: 'enabled', paramsInheritanceStrategy: 'always' }",
      ),
    });
    const r = tidy(ws, src);
    const main = r.writes.get(path.join(src, 'main.ts')) ?? '';
    expect(main).toContain(
      'providers: [provideRouter(routes, withHashLocation(), withEnabledBlockingInitialNavigation(), ' +
        "withPreloading(PreloadAllModules), withInMemoryScrolling({ scrollPositionRestoration: 'top', " +
        "anchorScrolling: 'enabled' }), withRouterConfig({ paramsInheritanceStrategy: 'always' })), " +
        'provideHttpClient()]',
    );
    expect(main).not.toMatch(/AppRoutingModule|importProvidersFrom|BrowserModule/);
    expect(main).toContain("import { routes } from './app/app.routes';");
    expect(main).toMatch(
      /import \{ provideRouter, withHashLocation, withEnabledBlockingInitialNavigation, PreloadAllModules, withPreloading|import \{ provideRouter[^}]*withPreloading[^}]*\} from '@angular\/router';/,
    );
    for (const n of ['PreloadAllModules', 'withInMemoryScrolling', 'withRouterConfig']) {
      expect(main).toMatch(new RegExp(`import \\{[^}]*\\b${n}\\b[^}]*\\} from '@angular/router'`));
    }
    const file = path.join(src, 'app/app-routing.module.ts');
    expect(r.renames.get(file)).toBe(path.join(src, 'app/app.routes.ts'));
    const routes = r.writes.get(file) ?? '';
    expect(routes).toContain('export const routes: Routes = [');
    expect(routes).not.toMatch(/NgModule|RouterModule|AppRoutingModule/);
    expect(routes).toContain("import { PreloadAllModules, Routes } from '@angular/router';");
    expect(r.done).toEqual([
      'apps/web/src/main.ts: BrowserModule dropped, provideRouter instead of the routing module',
      'apps/web/src/app/app-routing.module.ts: AppRoutingModule → apps/web/src/app/app.routes.ts (export const routes)',
    ]);
  });

  it('inline routes become an exported routes constant', () => {
    const { ws, src } = app({
      'main.ts': MAIN(
        'importProvidersFrom(AppRoutingModule)',
        "import { AppRoutingModule } from './app/app-routing.module';",
      ),
      'app/app-routing.module.ts':
        "import { NgModule } from '@angular/core';\nimport { RouterModule } from '@angular/router';\n\n" +
        "@NgModule({ imports: [RouterModule.forRoot([{ path: '', redirectTo: 'home', pathMatch: 'full' }])], exports: [RouterModule] })\n" +
        'export class AppRoutingModule {}\n',
    });
    const r = tidy(ws, src);
    expect(r.writes.get(path.join(src, 'main.ts'))).toContain('providers: [provideRouter(routes)]');
    expect(r.writes.get(path.join(src, 'app/app-routing.module.ts'))).toBe(
      "import { Routes } from '@angular/router';\n\n" +
        "export const routes: Routes = [{ path: '', redirectTo: 'home', pathMatch: 'full' }];\n",
    );
  });

  it('leaves routing modules it cannot convert, and says why', () => {
    const cases: [string, Record<string, string>, string][] = [
      [
        'providers',
        { 'app/app-routing.module.ts': ROUTING('routes', '', '\n  providers: [],') },
        'AppRoutingModule: @NgModule has providers',
      ],
      [
        'an option without a feature',
        { 'app/app-routing.module.ts': ROUTING('routes, { errorHandler: handle }') },
        'router option errorHandler: handle has no feature',
      ],
      [
        'another importer',
        {
          'app/app-routing.module.ts': ROUTING('routes'),
          'app/app.component.ts': "import { AppRoutingModule } from './app-routing.module';\n",
        },
        'AppRoutingModule is also imported by app.component.ts',
      ],
    ];
    for (const [, files, note] of cases) {
      const { ws, src } = app({
        'main.ts': MAIN(
          'importProvidersFrom(AppRoutingModule)',
          "import { AppRoutingModule } from './app/app-routing.module';",
        ),
        ...files,
      });
      const r = tidy(ws, src);
      expect(r.writes.size).toBe(0);
      expect(r.notes.join('\n')).toContain(note);
    }
  });

  it('bindToComponentInputs needs Angular 16', () => {
    const files = {
      'main.ts': MAIN(
        'importProvidersFrom(AppRoutingModule)',
        "import { AppRoutingModule } from './app/app-routing.module';",
      ),
      'app/app-routing.module.ts': ROUTING('routes, { bindToComponentInputs: true }'),
    };
    const a = app(files);
    expect(tidy(a.ws, a.src, 16).writes.get(path.join(a.src, 'main.ts'))).toContain(
      'provideRouter(routes, withComponentInputBinding())',
    );
    const b = app(files);
    expect(tidy(b.ws, b.src, 15).notes.join('\n')).toContain('bindToComponentInputs: true');
  });

  it('pstack upgrade standalone runs only this step on apps already on bootstrapApplication', async () => {
    const ws = tmpDir('pstack-providers-ws-');
    writeJson(path.join(ws, 'nx.json'), {});
    writeJson(path.join(ws, 'package.json'), { dependencies: { '@angular/core': '~21.2.25' } });
    writeJson(path.join(ws, 'node_modules/@angular/core/package.json'), { version: '21.2.25' });
    fs.symlinkSync(
      path.join(REPO_ROOT, 'node_modules/typescript'),
      path.join(ws, 'node_modules/typescript'),
    );
    writeJson(path.join(ws, 'apps/web/project.json'), { name: 'web', projectType: 'application' });
    const files = {
      'main.ts': MAIN(
        'importProvidersFrom(BrowserModule, AppRoutingModule)',
        "import { AppRoutingModule } from './app/app-routing.module';",
      ),
      'app/app-routing.module.ts': ROUTING('routes'),
    };
    for (const [f, text] of Object.entries(files)) {
      const p = path.join(ws, 'apps/web/src', f);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    const calls: string[] = [];
    const out: string[] = [];
    let statusCalls = 0;
    const deps: UpgradeDeps = {
      exec: (cmd, args) => void calls.push(`${cmd} ${args.join(' ')}`),
      // Clean before the run; the step's own changes after it.
      gitStatus: () => (statusCalls++ % 2 === 0 ? '' : ' M apps/web/src/main.ts'),
      nodeMajor: () => 22,
      interactive: false,
      prompter: () => scriptedPrompter([]),
      log: (l) => void out.push(l),
    };
    const ctx = makeCtx({ cwd: ws, positionals: ['standalone'], flags: { all: true } });
    expect(await runUpgrade(ctx, deps)).toBe(0);
    expect(calls.filter((c) => c.includes('@angular/core:standalone'))).toEqual([]);
    expect(calls).toEqual([
      'npx --no-install eslint --fix apps/web/src/app/app.routes.ts apps/web/src/main.ts',
      'npx --no-install prettier --write apps/web/src/app/app.routes.ts apps/web/src/main.ts',
      'npx nx run-many -t build lint',
      'git add -A',
      'git commit -m chore: standalone standalone-providers (pstack upgrade standalone)',
    ]);
    expect(fs.existsSync(path.join(ws, 'apps/web/src/app/app-routing.module.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(ws, 'apps/web/src/app/app.routes.ts'), 'utf8')).toContain(
      'export const routes: Routes',
    );
    expect(out.join('\n')).toContain('1. standalone-providers');

    // Run again: nothing left to do.
    out.length = 0;
    expect(await runUpgrade(ctx, deps)).toBe(0);
    expect(out.join('\n')).toContain('nothing to do');
  });
});
