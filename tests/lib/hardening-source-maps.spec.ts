import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { listFiles, servedRoot } from '../../src/lib/hardening/files';
import { checkSourceMaps } from '../../src/lib/hardening/source-maps';

const HINT = 'set "sourceMap": false in the Angular build configuration';

describe('hardening output files', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-hardening-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content = ''): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  describe('servedRoot', () => {
    it('prefers the output folder when it holds index.html', () => {
      write('index.html');
      write('browser/index.html');
      expect(servedRoot(root)).toBe(root);
    });

    it('falls back to browser/ (application builder)', () => {
      write('browser/index.html');
      expect(servedRoot(root)).toBe(path.join(root, 'browser'));
    });

    it('returns the output folder when neither has index.html', () => {
      expect(servedRoot(root)).toBe(root);
    });
  });

  describe('listFiles', () => {
    it('lists matching files recursively, sorted and absolute, skipping the given dirs', () => {
      write('main.js');
      write('chunks/a.MJS');
      write('styles.css');
      write('assets/lib.js');
      write('README');
      expect(listFiles(root, ['js', 'mjs'], { skipDirs: ['assets'] })).toEqual([
        path.join(root, 'chunks/a.MJS'),
        path.join(root, 'main.js'),
      ]);
    });

    it('returns nothing for a missing folder', () => {
      expect(listFiles(path.join(root, 'missing'), ['js'])).toEqual([]);
    });
  });

  describe('checkSourceMaps', () => {
    it('reports .map files', () => {
      write('main.js', 'x();');
      write('main.js.map', '{}');
      const r = checkSourceMaps(root, 'fail');
      expect(r.warnings).toEqual([]);
      expect(r.errors).toHaveLength(2);
      expect(r.errors[0]).toContain('main.js.map');
      expect(r.errors[1]).toContain(HINT);
    });

    it('reports a sourceMappingURL comment in js and css', () => {
      write('js/main.js', 'x();\n//# sourceMappingURL=main.js.map\n');
      write('styles.css', 'a{}\n/*# sourceMappingURL=styles.css.map */\n');
      const r = checkSourceMaps(root, 'fail');
      expect(r.errors.slice(0, 2)).toEqual([
        expect.stringContaining(path.join('js', 'main.js')),
        expect.stringContaining('styles.css'),
      ]);
      expect(r.errors[0]).not.toContain(root);
    });

    it('does not flag sourceMappingURL= inside a string literal', () => {
      write('main.js', 'const s = "//# sourceMappingURL=x.map";\nconst t = "sourceMappingURL=y";');
      expect(checkSourceMaps(root, 'fail')).toEqual({ errors: [], warnings: [] });
    });

    it('reports nothing for a clean output', () => {
      write('main.js', 'const sourceMappingURL = 1;');
      write('styles.css', 'a{}');
      expect(checkSourceMaps(root, 'fail')).toEqual({ errors: [], warnings: [] });
    });

    it('lists the files as warnings in warn mode', () => {
      write('main.js.map', '{}');
      const r = checkSourceMaps(root, 'warn');
      expect(r.errors).toEqual([]);
      expect(r.warnings.join('\n')).toContain('main.js.map');
    });

    it('does nothing when off', () => {
      write('main.js.map', '{}');
      expect(checkSourceMaps(root, 'off')).toEqual({ errors: [], warnings: [] });
    });
  });
});
