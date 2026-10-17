import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import {
  CSP_NONCE_IMPORT,
  noncePatchMains,
  useLibraryNoncePatch,
  withCspNonceImport,
} from '../../src/lib/utils/csp-nonce';

describe('csp nonce import', () => {
  it('adds the import first, once', () => {
    const once = withCspNonceImport("import { x } from 'y';\n");
    expect(once.split('\n')[0]).toMatch(/^\/\/ /);
    expect(once.split('\n')[1]).toBe(`import '${CSP_NONCE_IMPORT}';`);
    expect(withCspNonceImport(once)).toBe(once);
  });

  it('replaces compatible local patches and keeps others', () => {
    const files: Record<string, string> = {
      'tools/nonce.js':
        'const n = window.__cspNonce; Element.prototype.appendChild = function (x) { x.nonce = n };',
      'tools/own.js':
        'const n = document.currentScript.nonce; Node.prototype.insertBefore = function () {};',
      'tools/other.js': 'console.log(1);',
    };
    const text =
      "import '../../tools/nonce'\n\nimport '../../tools/own';\nimport '../../tools/other';\n" +
      "import '../../vendor/csp-nonce-patch';\nimport { a } from './a';\n";
    const out = useLibraryNoncePatch('apps/web/main.ts', text, (p) => files[p]);
    expect(out.replaced).toEqual(['../../tools/nonce']);
    expect(out.kept).toEqual(['../../tools/own', '../../vendor/csp-nonce-patch']);
    expect(out.text).toBe(
      `import '${CSP_NONCE_IMPORT}'; // was '../../tools/nonce'\n\n` +
        "import '../../tools/own';\nimport '../../tools/other';\n" +
        "import '../../vendor/csp-nonce-patch';\nimport { a } from './a';\n",
    );
  });

  it('only adds the import when told to keep local patches', () => {
    const files = { 'tools/nonce.js': 'window.__cspNonce; Element.prototype.appendChild = 1;' };
    const out = useLibraryNoncePatch(
      'apps/web/main.ts',
      "import '../../tools/nonce';\n",
      (p) => (files as Record<string, string>)[p],
      { replaceLocal: false },
    );
    expect(out.replaced).toEqual([]);
    expect(out.kept).toEqual(['../../tools/nonce']);
    expect(out.text.split('\n')[1]).toBe(`import '${CSP_NONCE_IMPORT}';`);
    expect(out.text).toContain("import '../../tools/nonce';");
  });

  it('goes after triple-slash directives behind a license comment', () => {
    const out = withCspNonceImport(
      '/* (c) x\n * y */\n// note\n/// <reference types="@angular/localize" />\nimport { x } from "y";\n',
    );
    const lines = out.split('\n');
    expect(lines[3]).toBe('/// <reference types="@angular/localize" />');
    expect(lines[5]).toBe(`import '${CSP_NONCE_IMPORT}';`);
  });

  it('goes after triple-slash directives', () => {
    const out = withCspNonceImport(
      '/// <reference types="@angular/localize" />\nimport { x } from "y";\n',
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('/// <reference types="@angular/localize" />');
    expect(lines[2]).toBe(`import '${CSP_NONCE_IMPORT}';`);
  });

  it('notes what it changed in the tree', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('apps/a/src/main.ts', "import './x';\n");
    tree.write('apps/b/src/main.ts', `import '${CSP_NONCE_IMPORT}';\n`);
    const note = noncePatchMains(tree, ['apps/a/src/main.ts', 'apps/b/src/main.ts', 'nope.ts']);
    expect(note).toContain('was added first in `apps/a/src/main.ts`');
    expect(note).not.toContain('apps/b');
    expect(noncePatchMains(tree, ['apps/a/src/main.ts'])).toBeUndefined();
  });
});
