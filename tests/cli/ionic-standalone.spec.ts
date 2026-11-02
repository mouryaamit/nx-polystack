import * as fs from 'fs';
import * as path from 'path';

import {
  convertIonicApp,
  ionicContext,
  isIonicApp,
  runIonicStep,
  scanTags,
} from '../../src/cli/commands/ionic-standalone';
import { loadTypescript } from '../../src/cli/commands/standalone-providers';
import { AngularProject } from '../../src/cli/commands/upgrade-standalone';
import { ionTagClass, moduleExports } from '../../src/lib/utils/ionic-tags';

import { REPO_ROOT, tmpDir, writeJson } from './helpers';

const ts = loadTypescript(REPO_ROOT);
if (!ts) throw new Error('typescript is a devDependency of the plugin');

const APP: AngularProject = { name: 'mobile', root: 'apps/mobile', app: true };
const ICONS_ASSET = {
  glob: '**/*.svg',
  input: 'node_modules/ionicons/dist/ionicons/svg',
  output: './svg',
};

const MAIN = (entry = '@ionic/angular', forRoot = "IonicModule.forRoot({ mode: 'md' })") =>
  `import { enableProdMode, importProvidersFrom } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy } from '@angular/router';
import { IonicModule, IonicRouteStrategy } from '${entry}';

import { AppComponent } from './app/app.component';

enableProdMode();
bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    importProvidersFrom(${forRoot}),
  ],
});
`;

const ROOT_COMPONENT = (entry = '@ionic/angular') => `import { Component } from '@angular/core';
import { IonicModule } from '${entry}';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [IonicModule],
  template: '<ion-app><ion-router-outlet></ion-router-outlet></ion-app>',
})
export class AppComponent {}
`;

function ionicWs(files: Record<string, string>): { ws: string; src: string } {
  const ws = tmpDir('pstack-ionic-');
  fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
  fs.symlinkSync(
    path.join(REPO_ROOT, 'node_modules', 'typescript'),
    path.join(ws, 'node_modules', 'typescript'),
  );
  writeJson(path.join(ws, 'apps/mobile/project.json'), {
    name: 'mobile',
    projectType: 'application',
    targets: {
      build: { options: { assets: ['apps/mobile/src/assets', ICONS_ASSET] } },
    },
  });
  const all: Record<string, string> = {
    'main.ts': MAIN(),
    'app/app.component.ts': ROOT_COMPONENT(),
    ...files,
  };
  for (const [f, text] of Object.entries(all)) {
    const p = path.join(ws, 'apps/mobile/src', f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return { ws, src: path.join(ws, 'apps/mobile/src') };
}

const convert = (ws: string, major = 17, libs: AngularProject[] = []) =>
  convertIonicApp(ionicContext(ts as never, ws, major), APP, libs);

const out = (r: ReturnType<typeof convert>, src: string, f: string) =>
  r.writes.get(path.join(src, f)) ?? '';

describe('ionic-standalone', () => {
  it('main.ts: IonicModule.forRoot(config) → provideIonicAngular(config), imports moved', () => {
    const { ws, src } = ionicWs({});
    const r = convert(ws);
    expect(r.reasons).toEqual([]);
    const main = out(r, src, 'main.ts');
    expect(main).toContain("    provideIonicAngular({ mode: 'md' }),\n  ],");
    expect(main).not.toContain('importProvidersFrom');
    expect(main).not.toContain('IonicModule');
    expect(main).toContain("import { enableProdMode } from '@angular/core';");
    expect(main).toContain(
      "import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular/standalone';",
    );
    expect(main).not.toMatch(/from '@ionic\/angular';/);
    expect(r.done).toContain(
      'apps/mobile/src/main.ts: provideIonicAngular() instead of IonicModule.forRoot(); IonicRouteStrategy from @ionic/angular/standalone',
    );
  });

  it('app.config.ts: forRoot() without config; other importProvidersFrom modules stay', () => {
    const { ws, src } = ionicWs({
      'main.ts':
        "import { bootstrapApplication } from '@angular/platform-browser';\nimport { appConfig } from './app/app.config';\nimport { AppComponent } from './app/app.component';\n\nbootstrapApplication(AppComponent, appConfig);\n",
      'app/app.config.ts': `import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { IonicModule } from '@ionic/angular';
import { StoreModule } from './store.module';

export const appConfig: ApplicationConfig = {
  providers: [importProvidersFrom(StoreModule, IonicModule.forRoot())],
};
`,
    });
    const r = convert(ws);
    expect(r.reasons).toEqual([]);
    const config = out(r, src, 'app/app.config.ts');
    expect(config).toContain(
      'providers: [importProvidersFrom(StoreModule), provideIonicAngular()],',
    );
    expect(config).toContain(
      "import { ApplicationConfig, importProvidersFrom } from '@angular/core';",
    );
    expect(config).toContain("import { provideIonicAngular } from '@ionic/angular/standalone';");
    expect(r.writes.has(path.join(src, 'main.ts'))).toBe(false);
  });

  it('components: IonicModule out, the Ion* classes of their tags in (inline, templateUrl, nested, control flow)', () => {
    const { ws, src } = ionicWs({
      'app/home/home.page.ts': `import { Component } from '@angular/core';
import { NgIf } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [NgIf, IonicModule],
  templateUrl: './home.page.html',
})
export class HomePage {
  ready = true;
}
`,
      'app/home/home.page.html': `<ion-header><ion-toolbar><ion-title>Home</ion-title></ion-toolbar></ion-header>
<ion-content [fullscreen]="ready && 1 > 0">
  <!-- <ion-spinner></ion-spinner> -->
  @if (ready) {
    <ion-list><ion-item><ion-label>One</ion-label></ion-item></ion-list>
  }
  <ion-button *ngIf="ready" (click)="ready = !ready">Go</ion-button>
</ion-content>
`,
    });
    const r = convert(ws);
    expect(r.reasons).toEqual([]);
    const root = out(r, src, 'app/app.component.ts');
    expect(root).toContain('imports: [IonApp, IonRouterOutlet],');
    expect(root).toContain("import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';");
    expect(root).not.toContain('IonicModule');
    const home = out(r, src, 'app/home/home.page.ts');
    expect(home).toContain(
      'imports: [NgIf, IonButton, IonContent, IonHeader, IonItem, IonLabel, IonList, IonTitle, IonToolbar],',
    );
    expect(home).not.toContain('IonSpinner');
    expect(home).toContain(
      "import { IonButton, IonContent, IonHeader, IonItem, IonLabel, IonList, IonTitle, IonToolbar } from '@ionic/angular/standalone';",
    );
  });

  it('routerLink: IonRouterLink on ion-* elements, IonRouterLinkWithHref on <a>', () => {
    const { ws, src } = ionicWs({
      'app/menu.component.ts': `import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-menu',
  standalone: true,
  imports: [IonicModule, RouterLink],
  template: \`<ion-item routerLink="/a">A</ion-item><a [routerLink]="['/b']">B</a>\`,
})
export class MenuComponent {}
`,
    });
    const r = convert(ws);
    const menu = out(r, src, 'app/menu.component.ts');
    expect(menu).toContain('imports: [RouterLink, IonItem, IonRouterLink, IonRouterLinkWithHref],');
  });

  it('services and types imported from @ionic/angular move to the standalone entry', () => {
    const { ws, src } = ionicWs({
      'app/ui.service.ts': `import { Injectable } from '@angular/core';
import { AlertController, ModalController } from '@ionic/angular';
import type { ModalOptions } from '@ionic/angular';

@Injectable({ providedIn: 'root' })
export class UiService {
  constructor(private alerts: AlertController, private modals: ModalController) {}
  open(o: ModalOptions) {
    return this.modals.create(o);
  }
}
`,
    });
    const r = convert(ws);
    const svc = out(r, src, 'app/ui.service.ts');
    expect(svc).toContain(
      "import { AlertController, ModalController, type ModalOptions } from '@ionic/angular/standalone';",
    );
    expect(svc).not.toMatch(/from '@ionic\/angular';/);
  });

  it('Ionic 9 (Angular 21): IonicModule from @ionic/angular/lazy, standalone entry @ionic/angular', () => {
    const { ws, src } = ionicWs({
      'main.ts': MAIN('@ionic/angular/lazy'),
      'app/app.component.ts': ROOT_COMPONENT('@ionic/angular/lazy').replace(
        '  standalone: true,\n',
        '',
      ),
      'app/toast.service.ts':
        "import { ToastController } from '@ionic/angular/lazy';\nexport class ToastService {\n  constructor(private t: ToastController) {}\n}\n",
    });
    const r = convert(ws, 21);
    expect(r.reasons).toEqual([]);
    expect(out(r, src, 'main.ts')).toContain(
      "import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';",
    );
    // Angular 19+: standalone by default.
    expect(out(r, src, 'app/app.component.ts')).toContain(
      "import { IonApp, IonRouterOutlet } from '@ionic/angular';",
    );
    expect(out(r, src, 'app/toast.service.ts')).toContain(
      "import { ToastController } from '@ionic/angular';",
    );
    expect([...r.writes.values()].join('\n')).not.toContain('@ionic/angular/lazy');
  });

  it('ion-icon literal names → addIcons in the constructor; the svg asset goes', () => {
    const { ws, src } = ionicWs({
      'app/tabs.page.ts': `import { Component } from '@angular/core';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-tabs',
  standalone: true,
  imports: [IonicModule],
  template: '<ion-icon name="add-outline"></ion-icon><ion-icon [name]="\\'trash\\'" ios="logo-apple" md="logo-android"></ion-icon>',
})
export class TabsPage {
  title = 'Tabs';

  add(): void {}
}
`,
      'app/base.page.ts': `import { Component } from '@angular/core';
import { IonicModule } from '@ionic/angular';
import { Base } from './base';

@Component({ selector: 'app-base', standalone: true, imports: [IonicModule], template: '<ion-icon name="home"></ion-icon>' })
export class BasePage extends Base {
  constructor() {
    super();
    this.init();
  }
}
`,
    });
    const r = convert(ws);
    expect(r.reasons).toEqual([]);
    const tabs = out(r, src, 'app/tabs.page.ts');
    expect(tabs).toContain(
      "  title = 'Tabs';\n\n  constructor() {\n    addIcons({ addOutline, logoAndroid, logoApple, trash });\n  }\n",
    );
    expect(tabs).toContain("import { addIcons } from 'ionicons';");
    expect(tabs).toContain(
      "import { addOutline, logoAndroid, logoApple, trash } from 'ionicons/icons';",
    );
    expect(tabs).toContain('imports: [IonIcon],');
    const base = out(r, src, 'app/base.page.ts');
    expect(base).toContain('    super();\n    addIcons({ home });\n    this.init();');
    const pj = JSON.parse(r.writes.get(path.join(ws, 'apps/mobile/project.json')) ?? '{}');
    expect(pj.targets.build.options.assets).toEqual(['apps/mobile/src/assets']);
    expect(r.done).toContain(
      'apps/mobile/project.json: ionicons svg asset removed (icons come from addIcons)',
    );
  });

  it('an icon name that clashes with a name in the file is imported under an alias', () => {
    const { ws, src } = ionicWs({
      'app/x.page.ts': `import { Component } from '@angular/core';
import { IonicModule } from '@ionic/angular';

const add = 1;

@Component({ selector: 'app-x', standalone: true, imports: [IonicModule], template: '<ion-icon name="add"></ion-icon>' })
export class XPage {
  constructor() {}
}
`,
    });
    const x = out(convert(ws), src, 'app/x.page.ts');
    expect(x).toContain("import { add as addIcon } from 'ionicons/icons';");
    expect(x).toContain('constructor() {\n    addIcons({ add: addIcon });\n  }');
  });

  it('bound icon names (and icon names in code) are reported, and the svg asset stays', () => {
    const { ws, src } = ionicWs({
      'app/tab.page.ts': `import { Component } from '@angular/core';
import { IonicModule } from '@ionic/angular';

@Component({ selector: 'app-tab', standalone: true, imports: [IonicModule], template: '<ion-icon [name]="icon"></ion-icon><ion-icon name="star"></ion-icon>' })
export class TabPage {
  icon = 'heart';
  buttons = [{ text: 'Delete', icon: 'trash' }];
}
`,
    });
    const r = convert(ws);
    expect(r.reasons).toEqual([]);
    expect(out(r, src, 'app/tab.page.ts')).toContain('addIcons({ star })');
    expect(r.writes.has(path.join(ws, 'apps/mobile/project.json'))).toBe(false);
    const note = r.notes.join('\n');
    expect(note).toContain('ionicons svg asset kept');
    expect(note).toContain('<ion-icon [name]="icon"> (bound name)');
    expect(note).toContain("icon: 'trash' (icon name in code)");
  });

  it('an app with one unsafe file is left whole, and says why', () => {
    const { ws } = ionicWs({
      'app/legacy/legacy.module.ts':
        "import { NgModule } from '@angular/core';\nimport { IonicModule } from '@ionic/angular';\n@NgModule({ imports: [IonicModule] })\nexport class LegacyModule {}\n",
      'app/missing.page.ts':
        "import { Component } from '@angular/core';\nimport { IonicModule } from '@ionic/angular';\n@Component({ selector: 'm', standalone: true, imports: [IonicModule], templateUrl: './gone.html' })\nexport class MissingPage {}\n",
      'app/dynamic.page.ts':
        "import { Component } from '@angular/core';\nconst t = '<ion-button></ion-button>';\n@Component({ selector: 'd', standalone: true, template: t })\nexport class DynamicPage {}\n",
      'app/odd.page.ts':
        "import { Component } from '@angular/core';\n@Component({ selector: 'o', standalone: true, template: '<ion-made-up></ion-made-up>' })\nexport class OddPage {}\n",
    });
    const r = convert(ws);
    expect(r.writes.size).toBe(0);
    expect(r.done).toEqual([]);
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        'apps/mobile/src/app/legacy/legacy.module.ts: an NgModule still imports IonicModule',
        'apps/mobile/src/app/missing.page.ts (MissingPage): template ./gone.html not found',
        'apps/mobile/src/app/dynamic.page.ts (DynamicPage): the template is built at runtime',
        'apps/mobile/src/app/odd.page.ts (OddPage): <ion-made-up> has no standalone IonMadeUp in @ionic/angular/standalone',
      ]),
    );
  });

  it('a non-standalone component, or a library still on IonicModule, skips the app', () => {
    const { ws } = ionicWs({
      'app/old.component.ts':
        "import { Component } from '@angular/core';\n@Component({ selector: 'o', template: '<ion-label></ion-label>' })\nexport class OldComponent {}\n",
    });
    expect(convert(ws).reasons).toEqual([
      'apps/mobile/src/app/old.component.ts (OldComponent): not a standalone component',
    ]);
    const lib = ionicWs({
      'app/home.page.ts':
        "import { Component } from '@angular/core';\nimport { Card } from '@acme/ui';\n@Component({ selector: 'h', standalone: true, imports: [Card], template: '' })\nexport class HomePage {}\n",
    });
    writeJson(path.join(lib.ws, 'tsconfig.base.json'), {
      compilerOptions: { paths: { '@acme/ui': ['libs/ui/src/index.ts'] } },
    });
    fs.mkdirSync(path.join(lib.ws, 'libs/ui/src'), { recursive: true });
    fs.writeFileSync(
      path.join(lib.ws, 'libs/ui/src/index.ts'),
      "import { IonicModule } from '@ionic/angular';\nexport const UI = [IonicModule];\n",
    );
    expect(convert(lib.ws, 17, [{ name: 'ui', root: 'libs/ui', app: false }]).reasons).toEqual([
      'apps/mobile: imports @acme/ui, a library that still uses IonicModule',
    ]);
  });

  it('an app without IonicModule.forRoot in its bootstrap files is skipped', () => {
    const { ws } = ionicWs({
      'main.ts':
        "import { bootstrapApplication } from '@angular/platform-browser';\nimport { AppComponent } from './app/app.component';\nbootstrapApplication(AppComponent);\n",
    });
    expect(convert(ws).reasons[0]).toContain('no importProvidersFrom(IonicModule.forRoot())');
  });

  it('runIonicStep writes the app, notes spec files, and a rerun changes nothing', () => {
    const { ws, src } = ionicWs({
      'app/app.component.spec.ts':
        "import { IonicModule } from '@ionic/angular';\nTestBed.configureTestingModule({ imports: [IonicModule.forRoot()] });\n",
    });
    expect(isIonicApp(ws, APP)).toBe(true);
    const said: string[] = [];
    const logged: string[] = [];
    const changed = runIonicStep(
      ws,
      [APP],
      [],
      17,
      (l) => void said.push(l),
      (l) => void logged.push(l),
    );
    expect(changed).toEqual([
      'apps/mobile/src/app/app.component.ts',
      'apps/mobile/src/main.ts',
      'apps/mobile/project.json',
    ]);
    expect(logged.join('\n')).toContain(
      'apps/mobile/src/app/app.component.spec.ts: spec files still use IonicModule',
    );
    const snapshot = () =>
      ['main.ts', 'app/app.component.ts', 'app/app.component.spec.ts']
        .map((f) => fs.readFileSync(path.join(src, f), 'utf8'))
        .join('\n');
    const before = snapshot();
    expect(isIonicApp(ws, APP)).toBe(false);
    const again: string[] = [];
    expect(
      runIonicStep(
        ws,
        [APP],
        [],
        17,
        (l) => void again.push(l),
        () => undefined,
      ),
    ).toEqual([]);
    expect(again).toEqual(['nothing to change']);
    expect(snapshot()).toBe(before);
  });

  it('a skipped app is reported by runIonicStep and keeps its files', () => {
    const { ws, src } = ionicWs({
      'app/x.module.ts':
        "import { IonicModule } from '@ionic/angular';\n@NgModule({ imports: [IonicModule] })\nexport class XModule {}\n",
    });
    const logged: string[] = [];
    expect(
      runIonicStep(
        ws,
        [APP],
        [],
        17,
        () => undefined,
        (l) => void logged.push(l),
      ),
    ).toEqual([]);
    expect(logged).toContain('  mobile: left on IonicModule (no file changed):');
    expect(fs.readFileSync(path.join(src, 'main.ts'), 'utf8')).toBe(MAIN());
  });

  it('the installed standalone entry and ionicons decide the known classes and icons', () => {
    const { ws, src } = ionicWs({
      'app/app.component.ts': ROOT_COMPONENT().replace(
        '</ion-app>',
        '<ion-icon name="add"></ion-icon><ion-icon name="nope"></ion-icon></ion-app>',
      ),
    });
    const ionic = path.join(ws, 'node_modules/@ionic/angular');
    writeJson(path.join(ionic, 'package.json'), {
      name: '@ionic/angular',
      exports: { './standalone': { types: './standalone/index.d.ts', default: './x.mjs' } },
    });
    fs.mkdirSync(path.join(ionic, 'standalone/directives'), { recursive: true });
    fs.writeFileSync(
      path.join(ionic, 'standalone/index.d.ts'),
      "export { IonApp } from './directives/app';\nexport * from './directives/more';\nexport declare const provideIonicAngular: () => unknown;\nexport declare class IonicRouteStrategy {}\n",
    );
    fs.writeFileSync(
      path.join(ionic, 'standalone/directives/more.d.ts'),
      'export declare class IonIcon {}\nexport interface ModalOptions {}\n',
    );
    const icons = path.join(ws, 'node_modules/ionicons');
    writeJson(path.join(icons, 'package.json'), { name: 'ionicons' });
    fs.mkdirSync(path.join(icons, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(icons, 'icons/index.d.ts'), 'export declare var add: string;\n');
    expect(moduleExports(ts as never, ws, '@ionic/angular/standalone')).toEqual(
      new Set(['IonApp', 'IonIcon', 'ModalOptions', 'provideIonicAngular', 'IonicRouteStrategy']),
    );
    const r = convert(ws);
    // ion-router-outlet is not in the installed list.
    expect(r.reasons).toEqual([
      'apps/mobile/src/app/app.component.ts (AppComponent): <ion-router-outlet> has no standalone IonRouterOutlet in @ionic/angular/standalone',
    ]);
    fs.writeFileSync(
      path.join(src, 'app/app.component.ts'),
      ROOT_COMPONENT().replace(
        '<ion-router-outlet></ion-router-outlet>',
        '<ion-icon name="add"></ion-icon><ion-icon name="nope"></ion-icon>',
      ),
    );
    const ok = convert(ws);
    expect(ok.reasons).toEqual([]);
    expect(out(ok, src, 'app/app.component.ts')).toContain('addIcons({ add })');
    expect(ok.notes.join('\n')).toContain('<ion-icon name="nope"> (not in ionicons/icons)');
  });

  it('scanTags reads attributes with > inside quotes; ionTagClass', () => {
    expect(scanTags('<ion-item [a]="x > 1" routerLink="/b"/><a href=x>')).toEqual([
      {
        name: 'ion-item',
        attrs: [
          { name: '[a]', value: 'x > 1' },
          { name: 'routerLink', value: '/b' },
        ],
      },
      { name: 'a', attrs: [{ name: 'href', value: 'x' }] },
    ]);
    expect(ionTagClass('ion-infinite-scroll-content')).toBe('IonInfiniteScrollContent');
  });
});
