import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import * as ts from 'typescript';

import libGenerator from '../../src/generators/lib/generator';

/** Compiles a generated, framework-free TypeScript file and returns its exports. */
function load<T>(source: string): T {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} as T };
  new Function('module', 'exports', js)(module, module.exports);
  return module.exports;
}

describe('lib generator starters (NX-44)', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
    );
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  const read = (p: string) => tree.read(p, 'utf8') ?? '';

  describe('--type=session', () => {
    const ROOT = 'libs/shared/session';

    it('writes a buildable Angular lib with the service, warning component and module', async () => {
      await libGenerator(tree, { name: 'session', type: 'session', prefix: 'acme' });
      expect(read(`${ROOT}/src/index.ts`)).toContain(
        "export * from './lib/session-timeout.service';",
      );
      expect(read(`${ROOT}/src/lib/session-warning/session-warning.component.ts`)).toContain(
        "selector: 'acme-session-warning'",
      );
      const service = read(`${ROOT}/src/lib/session-timeout.service.ts`);
      expect(service).toContain('runOutsideAngular');
      expect(service).toContain('BroadcastChannel');
      expect(service).not.toMatch(/^import .*(auth|token|http)/im);
      expect(read(`${ROOT}/README.md`)).toContain('@acme/shared-session');
      const pj = readJson(tree, `${ROOT}/project.json`);
      expect(Object.keys(pj.targets).sort()).toEqual(['build', 'lint', 'typecheck']);
      expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual({
        '@acme/shared-session': [`${ROOT}/src/index.ts`],
      });
      const deps = readJson(tree, 'package.json').dependencies;
      expect(Object.keys(deps)).not.toContain('@ng-idle/core');
    });

    describe('session-clock', () => {
      type Clock = typeof import('./lib-starters.types').clock;
      let clock: Clock;
      beforeEach(async () => {
        await libGenerator(tree, { name: 'session', type: 'session' });
        clock = load<Clock>(read(`${ROOT}/src/lib/session-clock.ts`));
      });
      const cfg = (extra: object = {}) => ({
        ...clock.DEFAULT_SESSION_TIMEOUT,
        idleMs: 10_000,
        warningMs: 3_000,
        ...extra,
      });

      it('is active, then warns, then times out on inactivity', () => {
        expect(clock.sessionState(1_000, 0, 0, cfg())).toEqual({
          status: 'active',
          remainingMs: 9_000,
          reason: 'idle',
        });
        expect(clock.sessionState(8_000, 0, 0, cfg()).status).toBe('warning');
        expect(clock.sessionState(10_000, 0, 0, cfg())).toEqual({
          status: 'timedOut',
          remainingMs: 0,
          reason: 'idle',
        });
        // Activity pushes it out again.
        expect(clock.sessionState(10_000, 0, 5_000, cfg()).status).toBe('active');
      });

      it('applies the absolute limit whatever the activity', () => {
        const c = cfg({ absoluteMs: 20_000 });
        expect(clock.sessionState(18_000, 0, 18_000, c)).toMatchObject({
          status: 'warning',
          reason: 'absolute',
          remainingMs: 2_000,
        });
        expect(clock.sessionState(20_000, 0, 20_000, c)).toMatchObject({
          status: 'timedOut',
          reason: 'absolute',
        });
      });

      it('fails closed on timestamps that are not numbers and ignores a clock that went back', () => {
        expect(clock.sessionState(1_000, NaN, 0, cfg()).status).toBe('active');
        expect(clock.sessionState(1_000, 0, NaN, cfg()).status).toBe('timedOut');
        expect(clock.sessionState(1_000, NaN, 0, cfg({ absoluteMs: 5_000 })).status).toBe(
          'timedOut',
        );
        // lastActivity ahead of now counts as now: no extra time.
        expect(clock.sessionState(1_000, 0, 50_000, cfg()).remainingMs).toBe(10_000);
      });

      it('validates start times, activity messages and builds a per-app channel key', () => {
        const now = Date.UTC(2026, 9, 16);
        expect(clock.startedAtProblem(now - 1000, now)).toBeNull();
        expect(clock.startedAtProblem(now / 1000, now)).toContain('not seconds');
        expect(clock.startedAtProblem(NaN, now)).toContain('milliseconds');
        expect(clock.startedAtProblem(now + 60_000, now)).toContain('future');
        expect(clock.validActivityTime(now - 10, now)).toBe(true);
        expect(clock.validActivityTime(now + 60_000, now)).toBe(false);
        expect(clock.validActivityTime('1', now)).toBe(false);
        expect(clock.channelKey('session-timeout', 'https://bank.example/retail/')).toBe(
          'session-timeout:/retail/',
        );
        expect(clock.channelKey('session-timeout', undefined)).toBe('session-timeout:/');
        expect(clock.sessionConfigProblems(cfg({ activityEvents: [] }))).toContain(
          'activityEvents must list at least one event',
        );
      });

      it('reports unusable configurations', () => {
        expect(clock.sessionConfigProblems(cfg())).toEqual([]);
        expect(clock.sessionConfigProblems(cfg({ warningMs: 10_000 }))).toContain(
          'warningMs must be shorter than idleMs',
        );
        expect(clock.sessionConfigProblems(cfg({ idleMs: 0, absoluteMs: -1 }))).toEqual([
          'idleMs must be a positive number of milliseconds',
          'absoluteMs must be a positive number of milliseconds when set',
        ]);
      });
    });
  });

  describe('--type=pii', () => {
    const ROOT = 'libs/shared/pii';

    it('writes the pipe, the prefixed directive and the module', async () => {
      await libGenerator(tree, { name: 'pii', type: 'pii', prefix: 'acme' });
      expect(read(`${ROOT}/src/lib/pii-mask.pipe.ts`)).toContain("@Pipe({ name: 'piiMask' })");
      const directive = read(`${ROOT}/src/lib/pii-mask.directive.ts`);
      expect(directive).toContain("selector: '[acmePiiMask]'");
      expect(directive).toContain('textContent');
      expect(directive).not.toContain('innerHTML');
      expect(read(`${ROOT}/src/index.ts`)).toContain("export * from './lib/pii-mask.module';");
    });

    describe('maskPii', () => {
      type Mask = typeof import('./lib-starters.types').mask;
      let m: Mask;
      beforeEach(async () => {
        await libGenerator(tree, { name: 'pii', type: 'pii' });
        m = load<Mask>(read(`${ROOT}/src/lib/pii-mask.ts`));
      });

      it.each([
        ['pan', 'ABCDE1234F', 'XXXXX1234F'],
        ['pan', 'abcde1234f', 'XXXXX1234F'],
        ['aadhaar', '1234 5678 9012', 'XXXX XXXX 9012'],
        ['aadhaar', '123456789012', 'XXXX XXXX 9012'],
        ['mobile', '+91 98765 43210', '+91 XXXXX X3210'],
        ['mobile', '9876543210', 'XXXXXX3210'],
        ['mobile', '+919876543210', '+91XXXXXX3210'],
        ['mobile', '+1-98765-43210', '+1-XXXXX-X3210'],
        ['email', 'asha.k@example.com', 'aXXX@example.com'],
        ['email', 'a@example.com', 'XXXX@example.com'],
        ['account', '00123456789', 'XXXXXXX6789'],
        ['card', '4111 1111 1111 1111', 'XXXX XXXX XXXX 1111'],
        ['card', '4111-1111-1111-1111', 'XXXX-XXXX-XXXX-1111'],
        ['ifsc', 'sbin0001234', 'SBIN0001234'],
      ])('%s: %s → %s', (format, value, masked) => {
        expect(m.maskPii(value, format)).toBe(masked);
      });

      it('masks everything when the value does not match or the format is unknown', () => {
        expect(m.maskPii('ABCD1234', 'pan')).toBe('XXXXXXXX');
        expect(m.maskPii('not-an-email', 'email')).toBe('XXX-XX-XXXXX');
        expect(m.maskPii('secret 42', 'unknown')).toBe('XXXXXX XX');
        expect(m.maskPii('1234 5678', 'card')).toBe('XXXX XXXX');
      });

      it('masks letters and digits of every script when failing closed', () => {
        expect(m.maskPii('१२३४ ५६७८ ९०१२', 'aadhaar')).toBe('XXXX XXXX XXXX');
        expect(m.maskPii('ＡＢＣＤＥ１２３４Ｆ', 'pan')).toBe('XXXXXXXXXX');
        expect(m.maskPii('अमित कुमार', 'unknown')).not.toMatch(/[\u0900-\u097F]/);
        const rules = { name: { visibleStart: 1 } };
        expect(m.maskPii('अमित', 'name', { rules })).toBe('अXXX');
      });

      it('never shows more than half, and copes with odd options', () => {
        expect(m.maskPii('123456', 'account')).toBe('XXX456');
        expect(m.maskPii('ABCDE1234F', 'pan', { maskChar: '**' })).toBe('*****1234F');
        expect(m.maskPii('ABCDE1234F', 'pan', { maskChar: 5 as never })).toBe('XXXXX1234F');
        expect(m.maskPii('ABCDE1234F', 'pan', { maskChar: '' })).toBe('XXXXX1234F');
        const g = { code: { valid: /^\d{4}$/g, visibleEnd: 2 } };
        expect([1, 2, 3].map(() => m.maskPii('1234', 'code', { rules: g }))).toEqual([
          'XX34',
          'XX34',
          'XX34',
        ]);
        expect(m.maskPii('x', '__proto__')).toBe('X');
        expect(m.maskPii('x', 'toString')).toBe('X');
      });

      it('handles empty values, the mask character and custom rules', () => {
        expect(m.maskPii(null, 'pan')).toBe('');
        expect(m.maskPii(undefined, 'pan')).toBe('');
        expect(m.maskPii('  ', 'pan')).toBe('');
        expect(m.maskPii(1234567890, 'account', { maskChar: '•' })).toBe('••••••7890');
        const rules = { passport: { valid: /^[A-Z]\d{7}$/, visibleEnd: 3 } };
        expect(m.maskPii('K1234567', 'passport', { rules })).toBe('XXXXX567');
        expect(m.maskPii('K12', 'passport', { rules })).toBe('XXX');
      });
    });
  });
});
