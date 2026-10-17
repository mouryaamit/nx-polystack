import { parsePnpmYaml } from '../../../src/generators/migrate/npm-workspaces/pnpm-yaml';

describe('pnpm-workspace.yaml reader', () => {
  it('reads block and flow lists, maps, quotes and comments', () => {
    const doc = parsePnpmYaml(
      [
        '# workspace',
        'packages:',
        "  - 'packages/*'",
        '  - "apps/**" # every app',
        "  - '!**/test/**'",
        'catalog:',
        '  react: ^18.2.0',
        "  '@angular/core': ~15.2.0",
        'catalogs:',
        '  ng16:',
        '    "@angular/core": ~16.2.0',
        'onlyBuiltDependencies: [esbuild, "@swc/core"]',
        'overrides: {}',
        'key#hash: value # comment',
        '',
      ].join('\n'),
    );
    expect(doc).toEqual({
      packages: ['packages/*', 'apps/**', '!**/test/**'],
      catalog: { react: '^18.2.0', '@angular/core': '~15.2.0' },
      catalogs: { ng16: { '@angular/core': '~16.2.0' } },
      onlyBuiltDependencies: ['esbuild', '@swc/core'],
      overrides: {},
      'key#hash': 'value',
    });
  });

  it('reads a list at the key indent, list items holding maps, and escapes', () => {
    expect(
      parsePnpmYaml(
        [
          '---',
          'packages:',
          '- a',
          '- b',
          'items:',
          '  - name: x',
          '    version: "1"',
          '  -',
          '    name: y',
          "quote: 'it''s'",
          'empty:',
        ].join('\n'),
      ),
    ).toEqual({
      packages: ['a', 'b'],
      items: [{ name: 'x', version: '1' }, { name: 'y' }],
      quote: "it's",
      empty: '',
    });
    expect(parsePnpmYaml('# nothing\n')).toEqual({});
  });

  it('handles a BOM, a document end, null values, and quotes inside plain values', () => {
    expect(
      parsePnpmYaml(
        [
          '\uFEFFpackages:',
          "  - 'pkg' # c",
          "note: don't # comment",
          'esc: "say \\"hi\\"" # comment',
          "single: 'it''s # not a comment'",
          'none: ~',
          'nothing: null',
          "'@scope/pkg@1.0.0': patches/x.patch",
          '...',
          '# trailing comment',
        ].join('\r\n'),
      ),
    ).toEqual({
      packages: ['pkg'],
      note: "don't",
      esc: 'say "hi"',
      single: "it's # not a comment",
      none: '',
      nothing: '',
      '@scope/pkg@1.0.0': 'patches/x.patch',
    });
    expect(() => parsePnpmYaml('a: 1\n...\nb: 2\n')).toThrow('line 3: more than one YAML document');
    expect(parsePnpmYaml("x: pre-'q' # c\ny: a:'b' # c\n")).toEqual({ x: "pre-'q'", y: "a:'b'" });
    expect(() => parsePnpmYaml("x: 'abc # c\n")).toThrow("line 1: unterminated quoted string 'abc");
  });

  it('refuses what it cannot read, naming the line', () => {
    expect(() => parsePnpmYaml('a: &x 1\n')).toThrow('line 1: "&"');
    expect(() => parsePnpmYaml('a:\n  b: 1\n c: 2\n')).toThrow('line 3');
    expect(() => parsePnpmYaml('a: |\n  text\n')).toThrow('line 1: "|"');
    expect(() => parsePnpmYaml('a: 1\n---\nb: 2\n')).toThrow('more than one YAML document');
    expect(() => parsePnpmYaml('a:\n\t- x\n')).toThrow('line 2: tab indentation');
    expect(() => parsePnpmYaml('- a\n')).toThrow('expected keys');
    expect(() => parsePnpmYaml('just text\n')).toThrow('not a key: value pair');
    expect(() => parsePnpmYaml('a: [x, y\n')).toThrow('unclosed "["');
  });
});
