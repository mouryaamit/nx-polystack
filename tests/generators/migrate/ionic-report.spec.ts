import { emptyReportData } from '../../../src/generators/migrate/adapters/types';
import { renderReport } from '../../../src/generators/migrate/report';

describe('report: Ionic section', () => {
  it('renders one block per Ionic app', () => {
    const data = emptyReportData();
    data.ionic = [
      {
        project: 'field',
        packagePath: 'apps/field/package.json',
        ionic: '~6.7.0',
        capacitor: '~4.8.0',
        nativePackages: ['@capacitor/core', 'cordova-plugin-device'],
        alsoAtRoot: ['@capacitor/core'],
        otherApps: ['@capacitor/camera'],
        webDir: { file: 'capacitor.config.ts', from: 'www', to: '../../dist/apps/field' },
        platforms: ['android'],
        cordovaPlugins: ['cordova-plugin-device'],
        droppedTargets: ['cap (@nxext/capacitor:cap)'],
        outputPathMoved: 'apps/field/www',
      },
    ];
    const md = renderReport({
      name: 'field',
      adapterId: 'ionic',
      adapterLabel: 'standalone Ionic Angular app',
      detection: { confidence: 0.95, reasons: ['x'] },
      forced: false,
      source: '../field',
      data,
    });
    expect(md).toContain('## Ionic');
    expect(md).toContain('### `field`');
    expect(md).toContain('- Ionic: `~6.7.0` (Ionic 6: works with Angular 15; plan the move to 7)');
    expect(md).toContain(
      '- Capacitor: `~4.8.0` (the workspace generates Capacitor 5 apps; this app keeps its version)',
    );
    expect(md).toContain(
      '- Native packages (in `apps/field/package.json`): `@capacitor/core`, `cordova-plugin-device`',
    );
    expect(md).toContain(
      '- Also in the root package.json (the code imports them, so the web build needs them): ' +
        '`@capacitor/core`',
    );
    expect(md).toContain(
      '- Left to the other Ionic apps (this app does not import them): `@capacitor/camera`',
    );
    expect(md).toContain('- `webDir` in `capacitor.config.ts`: `www` → `../../dist/apps/field`');
    expect(md).toContain('- Build output moved from `apps/field/www` to the release output');
    expect(md).toContain('- Native platforms copied: android');
    expect(md).toContain(
      '- Cordova plugins (check each one works with Capacitor): `cordova-plugin-device`',
    );
    expect(md).toContain('- Targets dropped: `cap (@nxext/capacitor:cap)`');
  });

  it('says when webDir must be set by hand and no platforms were copied', () => {
    const data = emptyReportData();
    data.ionic = [
      {
        project: 'a',
        packagePath: 'apps/a/package.json',
        nativePackages: [],
        alsoAtRoot: [],
        otherApps: [],
        webDir: { file: 'capacitor.config.ts', to: '../../dist/apps/a', manual: 'not-literal' },
        platforms: [],
        cordovaPlugins: [],
        droppedTargets: [],
      },
    ];
    const md = renderReport({
      name: 'a',
      adapterId: 'ionic',
      adapterLabel: 'l',
      detection: { confidence: 1, reasons: [] },
      forced: false,
      source: 's',
      data,
    });
    expect(md).toContain(
      '- `webDir` in `capacitor.config.ts`: set it to `../../dist/apps/a` by hand (it is not a plain string)',
    );
    expect(md).toContain(
      '- Native platforms copied: none (add them with `npx nx run a:cap-add --platform=android`)',
    );
  });

  it('says when webDir is not set', () => {
    const data = emptyReportData();
    data.ionic = [
      {
        project: 'a',
        packagePath: 'apps/a/package.json',
        nativePackages: [],
        alsoAtRoot: [],
        otherApps: [],
        webDir: { file: 'capacitor.config.ts', to: '../../dist/apps/a', manual: 'not-set' },
        platforms: ['ios'],
        cordovaPlugins: [],
        droppedTargets: [],
      },
    ];
    const md = renderReport({
      name: 'a',
      adapterId: 'ionic',
      adapterLabel: 'l',
      detection: { confidence: 1, reasons: [] },
      forced: false,
      source: 's',
      data,
    });
    expect(md).toContain(
      '- `webDir` is not set in `capacitor.config.ts` (Capacitor then uses `www`): add ' +
        "`webDir: '../../dist/apps/a'`",
    );
    expect(md).toContain('- Native packages (in `apps/a/package.json`): none');
  });
});
