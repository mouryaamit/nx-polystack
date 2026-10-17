import * as fs from 'fs';
import * as path from 'path';

import { detectAngularCli } from '../../../src/generators/migrate/adapters/angular-cli';
import { detectIonic } from '../../../src/generators/migrate/adapters/ionic';

import { fixtureCopy, put } from './helpers';

describe('ionic adapter detection', () => {
  it('scores the Ionic fixture 0.95 and angular-cli 0.5', () => {
    const src = fixtureCopy('ionic7-app');
    const d = detectIonic(src);
    expect(d.confidence).toBe(0.95);
    expect(d.reasons).toEqual([
      'angular.json with one application project (app)',
      '@ionic/angular ^7.8.0 in package.json',
      'capacitor.config.ts (Capacitor 5.7.0)',
    ]);
    const cli = detectAngularCli(src);
    expect(cli.confidence).toBe(0.5);
    expect(cli.reasons[cli.reasons.length - 1]).toBe(
      'Ionic/Capacitor app (@ionic/angular in package.json, capacitor.config.ts, ' +
        'ionic.config.json): see the ionic adapter',
    );
  });

  it('takes an Angular Capacitor app without Ionic at 0.9', () => {
    const src = fixtureCopy('angular15-app');
    put(src, 'capacitor.config.json', '{}');
    expect(detectIonic(src)).toEqual({
      confidence: 0.8,
      reasons: [
        'angular.json with one application project (legacy-portal)',
        'no @ionic/angular (an Angular Capacitor app)',
        'capacitor.config.json (no @capacitor/core)',
      ],
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    pkg.dependencies['@capacitor/core'] = '5.7.0';
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pkg));
    expect(detectIonic(src).confidence).toBe(0.9);
  });

  it('needs @ionic/angular or a Capacitor config', () => {
    expect(detectIonic(fixtureCopy('angular15-app'))).toEqual({
      confidence: 0,
      reasons: ['no @ionic/angular and no Capacitor config'],
    });
  });

  it('asks for Capacitor first when there is only ionic.config.json', () => {
    const src = fixtureCopy('ionic7-app');
    fs.rmSync(path.join(src, 'capacitor.config.ts'));
    const d = detectIonic(src);
    expect(d.confidence).toBe(0.5);
    expect(d.reasons).toContain(
      'no Capacitor config (only ionic.config.json): add Capacitor first (npx cap init)',
    );
  });

  it('refuses Cordova apps', () => {
    const src = fixtureCopy('ionic7-app');
    fs.rmSync(path.join(src, 'capacitor.config.ts'));
    put(src, 'config.xml', '<widget/>');
    expect(detectIonic(src)).toEqual({
      confidence: 0,
      reasons: ['Cordova app (config.xml, no Capacitor config): migrate it to Capacitor first'],
    });
  });

  it('refuses Nx workspaces and multi-project angular.json like angular-cli', () => {
    const src = fixtureCopy('ionic7-app');
    put(src, 'nx.json', '{}');
    expect(detectIonic(src).confidence).toBe(0);
  });
});
