import * as fs from 'fs';
import * as path from 'path';

import {
  ADAPTERS,
  chooseAdapter,
  detectAll,
  findAdapter,
  formatDetectionTable,
  MIN_CONFIDENCE,
  parseMinConfidence,
  recognisedUnsupported,
} from '../../../src/generators/migrate/adapters';
import { detectAngularCli } from '../../../src/generators/migrate/adapters/angular-cli';
import { detectFlutter, readPubspec } from '../../../src/generators/migrate/adapters/flutter';

import { FIXTURES, fixtureCopy, put, putJson, readJsonFile, tmpSource } from './helpers';

const ANGULAR = `${FIXTURES}/angular15-app`;
const FLUTTER = `${FIXTURES}/flutter-app`;

describe('migrate detection', () => {
  it('registers every adapter, with a 0.8 threshold', () => {
    expect(ADAPTERS.map((a) => a.id)).toEqual([
      'angular-cli',
      'flutter',
      'nx-workspace',
      'angular-workspace',
      'ionic',
      'npm-workspaces',
    ]);
    expect(MIN_CONFIDENCE).toBe(0.8);
  });

  describe('angular-cli', () => {
    it('is fully confident on an ng new app, with the reasons', () => {
      const d = detectAngularCli(ANGULAR);
      expect(d.confidence).toBe(1);
      expect(d.reasons).toEqual([
        'angular.json with one application project (legacy-portal)',
        '@angular/core ^15.2.0 in package.json',
        'src/main.ts present',
      ]);
    });

    it('adds confidence per signal: angular.json alone is 0.5, + @angular/core 0.8', () => {
      const src = fixtureCopy('angular15-app');
      const pkg = readJsonFile<{ dependencies: Record<string, string> }>(src, 'package.json');
      delete pkg.dependencies['@angular/core'];
      putJson(src, 'package.json', pkg);
      fs.rmSync(`${src}/src/main.ts`);
      expect(detectAngularCli(src).confidence).toBe(0.5);
      expect(detectAngularCli(src).reasons).toContain('src/main.ts missing');

      putJson(src, 'package.json', { dependencies: { '@angular/core': '15.2.9' } });
      expect(detectAngularCli(src).confidence).toBe(0.8);
    });

    it('is 0 without angular.json', () => {
      expect(detectAngularCli(FLUTTER)).toEqual({ confidence: 0, reasons: ['no angular.json'] });
    });

    it('is disqualified by nx.json', () => {
      const src = fixtureCopy('angular15-app');
      putJson(src, 'nx.json', {});
      const d = detectAngularCli(src);
      expect(d.confidence).toBe(0);
      expect(d.reasons[0]).toMatch(/nx\.json: an Nx workspace/);
    });

    it('is disqualified by more than one project', () => {
      const src = fixtureCopy('angular15-app');
      const ws = readJsonFile<{ projects: Record<string, unknown> }>(src, 'angular.json');
      ws.projects['admin'] = { projectType: 'application', root: 'projects/admin' };
      ws.projects['ui'] = { projectType: 'library', root: 'projects/ui' };
      putJson(src, 'angular.json', ws);
      const d = detectAngularCli(src);
      expect(d.confidence).toBe(0);
      expect(d.reasons[0]).toBe(
        'angular.json has 3 projects (legacy-portal, admin, ui): use the angular-workspace adapter',
      );
    });

    it('a library project next to the one app also disqualifies (angular-workspace takes it)', () => {
      const src = fixtureCopy('angular15-app');
      const ws = readJsonFile<{ projects: Record<string, unknown> }>(src, 'angular.json');
      ws.projects['ui'] = { projectType: 'library', root: 'projects/ui' };
      putJson(src, 'angular.json', ws);
      expect(detectAngularCli(src).confidence).toBe(0);
    });

    it('reads angular.json with comments', () => {
      const src = fixtureCopy('angular15-app');
      const text = fs.readFileSync(`${src}/angular.json`, 'utf8');
      put(src, 'angular.json', `// comment\n${text}`);
      expect(detectAngularCli(src).confidence).toBe(1);
    });

    it('caps an Ionic app below the threshold and says why', () => {
      const src = fixtureCopy('angular15-app');
      put(src, 'capacitor.config.ts', 'export default {};\n');
      const d = detectAngularCli(src);
      expect(d.confidence).toBe(0.5);
      expect(d.reasons[d.reasons.length - 1]).toMatch(
        /Ionic\/Capacitor app \(capacitor\.config\.ts\): see the ionic adapter$/,
      );
    });
  });

  describe('flutter', () => {
    it('is fully confident on a flutter create app', () => {
      expect(detectFlutter(FLUTTER)).toEqual({
        confidence: 1,
        reasons: ['pubspec.yaml depends on the Flutter SDK', 'lib/main.dart present'],
      });
    });

    it('is 0.6 without lib/main.dart', () => {
      const src = fixtureCopy('flutter-app');
      fs.rmSync(`${src}/lib/main.dart`);
      expect(detectFlutter(src).confidence).toBe(0.6);
    });

    it('is 0 for a Dart package (no flutter SDK dependency)', () => {
      const src = tmpSource();
      put(src, 'pubspec.yaml', 'name: util\ndependencies:\n  path: ^1.8.0\n');
      put(src, 'lib/main.dart', '');
      expect(detectFlutter(src).confidence).toBe(0);
    });

    it('is disqualified by nx.json', () => {
      const src = fixtureCopy('flutter-app');
      putJson(src, 'nx.json', {});
      expect(detectFlutter(src).confidence).toBe(0);
    });
  });

  describe('readPubspec', () => {
    it('reads the name, the flutter SDK dependency and path dependencies', () => {
      const info = readPubspec(
        [
          'name: "field_notes" # the app',
          'dependencies:',
          '  flutter:',
          '    sdk: flutter',
          '  local_a:',
          "    path: '../local_a'",
          'dev_dependencies:',
          '  flutter_test:',
          '    sdk: flutter',
          '  tool:',
          '    path: tools/tool',
          'flutter:',
          '  uses-material-design: true',
        ].join('\n'),
      );
      expect(info).toEqual({
        name: 'field_notes',
        flutterSdk: true,
        pathDependencies: [
          { section: 'dependencies', name: 'local_a', path: '../local_a' },
          { section: 'dev_dependencies', name: 'tool', path: 'tools/tool' },
        ],
      });
    });

    it('does not take flutter_test (dev_dependencies) as the flutter SDK dependency', () => {
      const info = readPubspec('name: x\ndev_dependencies:\n  flutter:\n    sdk: flutter\n');
      expect(info.flutterSdk).toBe(false);
    });
  });

  describe('choosing an adapter', () => {
    it('detectAll lists every adapter, best first', () => {
      const rows = detectAll(FLUTTER);
      expect(rows.map((r) => [r.adapter.id, r.confidence])).toEqual([
        ['flutter', 1],
        ['angular-cli', 0],
        ['nx-workspace', 0],
        ['angular-workspace', 0],
        ['ionic', 0],
        ['npm-workspaces', 0],
      ]);
      expect(formatDetectionTable(rows)).toBe(
        [
          'Adapter            Confidence  Reasons',
          'flutter            1.00        pubspec.yaml depends on the Flutter SDK; lib/main.dart present',
          'angular-cli        0.00        no angular.json',
          'nx-workspace       0.00        no nx.json',
          'angular-workspace  0.00        no angular.json',
          'ionic              0.00        no @ionic/angular and no Capacitor config',
          'npm-workspaces     0.00        no "workspaces" in package.json',
        ].join('\n'),
      );
    });

    it('picks the confident adapter', () => {
      expect(chooseAdapter(ANGULAR).adapter.id).toBe('angular-cli');
      expect(chooseAdapter(FLUTTER)).toMatchObject({ forced: false, detection: { confidence: 1 } });
    });

    it('fails below the threshold with the table and a hint to use --adapter', () => {
      const src = tmpSource();
      put(src, 'pubspec.yaml', 'name: x\ndependencies:\n  flutter:\n    sdk: flutter\n');
      expect(() => chooseAdapter(src)).toThrow(
        /no adapter is confident enough \(needs 0\.80\)[\s\S]*flutter +0\.60[\s\S]*This project shape is not supported yet\.\nTo migrate it anyway, pick an adapter with --adapter=<angular-cli\|flutter\|nx-workspace\|angular-workspace\|ionic\|npm-workspaces>\./,
      );
    });

    it('names what it recognised but does not support (Ionic without Capacitor)', () => {
      const src = fixtureCopy('angular15-app');
      putJson(src, 'nx.json', {});
      put(src, 'ionic.config.json', '{}');
      expect(recognisedUnsupported(src)).toEqual([
        'Ionic/Capacitor app (ionic.config.json; no @ionic/angular and no Capacitor config)',
      ]);
      expect(() => chooseAdapter(src)).toThrow(
        'Recognised, but not supported yet: Ionic/Capacitor app (ionic.config.json; no ' +
          '@ionic/angular and no Capacitor config).',
      );
    });

    it('--adapter skips the threshold but still reports the detection', () => {
      const src = fixtureCopy('angular15-app');
      put(src, 'capacitor.config.ts', 'export default {};\n');
      const choice = chooseAdapter(src, 'angular-cli');
      expect(choice).toMatchObject({ forced: true, detection: { confidence: 0.5 } });
      expect(choice.adapter.id).toBe('angular-cli');
    });

    it('rejects an unknown --adapter', () => {
      expect(() => findAdapter('cordova')).toThrow(
        'migrate: unknown --adapter="cordova". Supported: angular-cli, flutter, nx-workspace, angular-workspace, ionic, npm-workspaces.',
      );
    });
  });
});

describe('minimum confidence', () => {
  const flutterWithoutMain = () => {
    const dir = fixtureCopy('flutter-app');
    fs.rmSync(path.join(dir, 'lib/main.dart'));
    return dir;
  };

  it('parseMinConfidence accepts 0.5 to 1', () => {
    expect(parseMinConfidence(undefined)).toBe(0.8);
    expect(parseMinConfidence(0.5)).toBe(0.5);
    expect(parseMinConfidence('1')).toBe(1);
    expect(parseMinConfidence(' .6 ')).toBe(0.6);
    expect(parseMinConfidence('1.0')).toBe(1);
    for (const bad of [0.49, 1.01, 'x', '', NaN, '0x1', '1e0', '0.6abc', true]) {
      expect(() => parseMinConfidence(bad)).toThrow(
        'migrate: --min-confidence must be a number from 0.50 to 1.00',
      );
    }
  });

  it('refuses a 0.60 match at the default, with a hint, and accepts it at 0.6', () => {
    const dir = flutterWithoutMain();
    expect(() => chooseAdapter(dir)).toThrow(
      /needs 0\.80[\s\S]*To accept flutter at 0\.60: --min-confidence=0\.6\./,
    );
    expect(chooseAdapter(dir, undefined, 0.6).adapter.id).toBe('flutter');
  });

  it('1.0 refuses a 0.95 match', () => {
    expect(() => chooseAdapter(fixtureCopy('nx16-workspace'), undefined, 1)).toThrow(
      /needs 1\.00[\s\S]*--min-confidence=0\.95/,
    );
  });
});
