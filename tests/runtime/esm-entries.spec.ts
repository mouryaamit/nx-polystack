import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

type Entry = string | Record<string, string>;
const exportOf = (sub: string): Record<string, string> => {
  const e: Entry = pkg.exports[`./runtime/${sub}`];
  return typeof e === 'string' ? { default: e } : e;
};

/**
 * NX-129: bundlers that follow the `import` condition (Angular's application builder, webpack 5)
 * get an ES module for every runtime entry, so Angular 21 builds raise no "is not ESM" warning and
 * need no allowedCommonJsDependencies entry. `require` / older tools keep the CommonJS file.
 */
describe('runtime entries ship as ES modules', () => {
  it.each(['csp-nonce', 'csp-style-attr'])(
    '%s: the .mjs is the reviewed .js, byte for byte',
    (name) => {
      const js = fs.readFileSync(path.join(ROOT, 'runtime', `${name}.js`));
      const mjs = fs.readFileSync(path.join(ROOT, 'runtime', `${name}.mjs`));
      expect(mjs.equals(js)).toBe(true);
    },
  );

  it.each(['csp-nonce', 'csp-style-attr'])('%s: import → .mjs, default → .js', (name) => {
    expect(exportOf(name)).toEqual({
      import: `./runtime/${name}.mjs`,
      default: `./runtime/${name}.js`,
    });
  });

  it.each(['csp-nonce', 'csp-style-attr', 'env-secret'])(
    '%s: the import target exists, is shipped and parses as an ES module',
    (name) => {
      const target = exportOf(name)['import'];
      expect(target).toMatch(/\.mjs$/);
      const file = path.join(ROOT, target);
      expect(fs.existsSync(file)).toBe(true);
      expect(pkg.files).toContain(target.split('/')[1]);
      // node --check parses a .mjs as a module (strict mode, import/export allowed).
      expect(() =>
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
      ).not.toThrow();
      // No CommonJS in the code (comments may mention require()).
      const src = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src).not.toMatch(/\brequire\(|\bmodule\.exports\b|\bexports\.\w+\s*=/);
    },
  );
});
