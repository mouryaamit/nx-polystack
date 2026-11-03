import * as fs from 'fs';
import * as path from 'path';

import {
  aliasCrossProjectImports,
  inlineReexportModules,
} from '../../src/cli/commands/reexport-modules';
import { loadTypescript } from '../../src/cli/commands/standalone-providers';
import { AngularProject } from '../../src/cli/commands/upgrade-standalone';

import { REPO_ROOT, tmpDir, writeJson } from './helpers';

const ts = loadTypescript(REPO_ROOT);
if (!ts) throw new Error('typescript is a devDependency of the plugin');

const MOBILE: AngularProject = { name: 'mobile', root: 'apps/mobile', app: true };
const FEED: AngularProject = { name: 'feed', root: 'libs/feed', app: false };

/** The feed library after convert-to-standalone: a module that only re-exports FeedPage. */
const FEED_MODULE = `import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { IonicModule } from '@ionic/angular';

import { FeedPage } from './feed/feed.page';

@NgModule({
  imports: [CommonModule, IonicModule, FeedPage],
  exports: [FeedPage],
})
export class FeedModule {}
`;
const FEED_PAGE = `import { Component } from '@angular/core';
import { IonicModule } from '@ionic/angular';

@Component({ selector: 'lib-feed', template: '', standalone: true, imports: [IonicModule] })
export class FeedPage {}
`;
const APP_MODULE = `import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FeedModule } from "@acme/feed";

import { AppComponent } from './app.component';

@NgModule({
  declarations: [AppComponent],
  imports: [FeedModule, BrowserModule],
  bootstrap: [AppComponent],
})
export class AppModule {}
`;

function ws(files: Record<string, string>): string {
  const root = tmpDir('pstack-reexport-');
  writeJson(path.join(root, 'tsconfig.base.json'), {
    compilerOptions: { paths: { '@acme/feed': ['libs/feed/src/index.ts'] } },
  });
  const all: Record<string, string> = {
    'libs/feed/src/index.ts':
      "export * from './lib/feed.module';\nexport * from './lib/feed/feed.page';\n",
    'libs/feed/src/lib/feed.module.ts': FEED_MODULE,
    'libs/feed/src/lib/feed/feed.page.ts': FEED_PAGE,
    'apps/mobile/src/app/app.module.ts': APP_MODULE,
    ...files,
  };
  for (const [f, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}

const read = (root: string, f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const run = (root: string, scope = ['./'], major = 17) =>
  inlineReexportModules(ts as never, root, [MOBILE, FEED], scope, major);

describe('re-exporting NgModules before prune-ng-modules', () => {
  it('a library module in an app module: the exported page instead, from the same path', () => {
    const root = ws({});
    const r = run(root);
    expect(r.changed).toEqual(['apps/mobile/src/app/app.module.ts']);
    const app = read(root, 'apps/mobile/src/app/app.module.ts');
    expect(app).toContain('imports: [FeedPage, BrowserModule]');
    expect(app).toContain("import { FeedPage } from '@acme/feed';");
    expect(app).not.toContain('FeedModule');
    expect(r.done[0]).toContain('imports FeedPage instead of FeedModule');
    // The module itself is left for Angular's prune.
    expect(read(root, 'libs/feed/src/lib/feed.module.ts')).toBe(FEED_MODULE);
    // A rerun changes nothing.
    expect(run(root).changed).toEqual([]);
  });

  it('a relative import of the module: the classes come from their own files', () => {
    const root = ws({
      'libs/feed/src/lib/feed-shell.component.ts': `import { Component } from '@angular/core';
import { FeedModule } from './feed.module';

@Component({ selector: 's', template: '<lib-feed></lib-feed>', standalone: true, imports: [FeedModule] })
export class FeedShellComponent {}
`,
    });
    run(root);
    const shell = read(root, 'libs/feed/src/lib/feed-shell.component.ts');
    expect(shell).toContain('imports: [FeedPage]');
    expect(shell).toContain("import { FeedPage } from './feed/feed.page';");
    expect(shell).not.toContain('FeedModule');
  });

  it('a page already in the array is not added twice', () => {
    const root = ws({
      'apps/mobile/src/app/app.module.ts': APP_MODULE.replace(
        'import { FeedModule } from "@acme/feed";',
        'import { FeedModule, FeedPage } from "@acme/feed";',
      ).replace(
        'imports: [FeedModule, BrowserModule]',
        'imports: [FeedModule, FeedPage, BrowserModule]',
      ),
    });
    run(root);
    expect(read(root, 'apps/mobile/src/app/app.module.ts')).toContain(
      'imports: [FeedPage, BrowserModule]',
    );
  });

  it('a module used outside an imports array is left, and noted', () => {
    const root = ws({
      'apps/mobile/src/app/shared.module.ts': `import { NgModule } from '@angular/core';
import { FeedModule } from '@acme/feed';
@NgModule({ imports: [FeedModule], exports: [FeedModule], declarations: [] , providers: [{ provide: 'x', useValue: 1 }]})
export class SharedModule {}
`,
    });
    const r = run(root);
    expect(read(root, 'apps/mobile/src/app/shared.module.ts')).toContain('exports: [FeedModule]');
    expect(r.notes.join('\n')).toContain(
      'apps/mobile/src/app/shared.module.ts: FeedModule is used outside an imports array',
    );
  });

  it('modules with declarations or providers, and modules outside the scope, are not touched', () => {
    const declares = ws({
      'libs/feed/src/lib/feed.module.ts': FEED_MODULE.replace(
        'exports: [FeedPage],',
        'exports: [FeedPage],\n  providers: [{ provide: "x", useValue: 1 }],',
      ),
    });
    expect(run(declares).changed).toEqual([]);
    const outside = ws({});
    expect(run(outside, ['apps/mobile']).changed).toEqual([]);
    // A non-standalone export (Angular 17 needs standalone: true) is not a re-export module.
    const notStandalone = ws({
      'libs/feed/src/lib/feed/feed.page.ts': FEED_PAGE.replace(' standalone: true,', ''),
    });
    expect(run(notStandalone).changed).toEqual([]);
    // From Angular 19, standalone is the default.
    expect(run(notStandalone, ['./'], 19).changed).toEqual(['apps/mobile/src/app/app.module.ts']);
  });

  it('an alias that does not export the page leaves the use, and says why', () => {
    const root = ws({ 'libs/feed/src/index.ts': "export * from './lib/feed.module';\n" });
    const r = run(root);
    expect(r.changed).toEqual([]);
    expect(r.notes.join('\n')).toContain(
      'FeedModule left (FeedPage is not exported where it is imported from)',
    );
  });
});

describe('relative imports into another project', () => {
  it('go back to the library path when it exports the names; merged into an existing import', () => {
    const root = ws({
      'apps/mobile/src/app/app.component.ts': `import { Component } from '@angular/core';
import { FeedPage } from '../../../../libs/feed/src/lib/feed/feed.page';
import { FeedModule } from '@acme/feed';
import { Local } from './local';

@Component({ selector: 'a', standalone: true, imports: [FeedPage, Local], template: '' })
export class AppComponent {}
`,
      'apps/mobile/src/app/local.ts': 'export class Local {}\n',
    });
    const done = aliasCrossProjectImports(root, [MOBILE, FEED]);
    expect(done).toEqual([
      'apps/mobile/src/app/app.component.ts: imports FeedPage from @acme/feed (not by a relative path into another project)',
    ]);
    const text = read(root, 'apps/mobile/src/app/app.component.ts');
    expect(text).not.toContain('libs/feed');
    expect(text).toContain("import { FeedModule, FeedPage } from '@acme/feed';");
    expect(text).toContain("import { Local } from './local';");
    expect(aliasCrossProjectImports(root, [MOBILE, FEED])).toEqual([]);
  });

  it('a name the library path does not export keeps its relative import', () => {
    const root = ws({
      'libs/feed/src/lib/internal.ts': 'export class Internal {}\n',
      'apps/mobile/src/app/x.ts':
        "import { Internal } from '../../../../libs/feed/src/lib/internal';\nexport const x = Internal;\n",
    });
    expect(aliasCrossProjectImports(root, [MOBILE, FEED])).toEqual([]);
  });
});
