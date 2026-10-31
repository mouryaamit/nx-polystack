import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { removeScriptReferences } from '../../src/generators/adopt/old-script-refs';

describe('removeScriptReferences', () => {
  it('YAML and shell comments, jsonc lists, JSON values left for review, kept files', () => {
    const t = createTreeWithEmptyWorkspace();
    t.write(
      '.github/workflows/ci.yml',
      'jobs:\n  # Was: node tools/scripts/build.js\n  build:\n    runs-on: ubuntu-latest\n',
    );
    t.write(
      'scripts/deploy.sh',
      '#!/bin/sh\n# old: tools/scripts/build.js\nnpx nx run web:release:prod\n',
    );
    t.write(
      'tsconfig.json',
      '{\n  // compiled by tsc\n  "exclude": ["tools/scripts/build.js", "dist"]\n}\n',
    );
    t.write('tools/config/env.json', '{ "builder": "tools/scripts/build.js" }\n');
    t.write('docs/migrations/adopt.md', 'Removed: `tools/scripts/build.js`.\n');

    const r = removeScriptReferences(t, ['tools/scripts/build.js'], ['docs/migrations/adopt.md']);

    expect(t.read('.github/workflows/ci.yml', 'utf8')).toBe(
      'jobs:\n  build:\n    runs-on: ubuntu-latest\n',
    );
    expect(t.read('scripts/deploy.sh', 'utf8')).toBe('#!/bin/sh\nnpx nx run web:release:prod\n');
    // jsonc (a comment): the list item goes as a comment-file edit would not; it is reported.
    expect(r.review).toContain('tools/config/env.json:1');
    expect(t.read('tools/config/env.json', 'utf8')).toContain('tools/scripts/build.js');
    expect(t.read('docs/migrations/adopt.md', 'utf8')).toContain('tools/scripts/build.js');
    expect(r.edited).toEqual(
      expect.arrayContaining([
        '.github/workflows/ci.yml:2: comment line removed',
        'scripts/deploy.sh:2: comment line removed',
      ]),
    );
    // tsconfig.json with a comment is not plain JSON: its mention is reported, not edited.
    expect(r.review).toContain('tsconfig.json:3');
  });

  it('does not touch a longer name that starts with a removed one, or other paths', () => {
    const t = createTreeWithEmptyWorkspace();
    t.write(
      '.gitignore',
      'tools/scripts/build.json\ntools/scripts/build.js.map\nfoo/tools/scripts/build.js\n',
    );
    const r = removeScriptReferences(t, ['tools/scripts/build.js']);
    expect(t.read('.gitignore', 'utf8')).toBe(
      'tools/scripts/build.json\ntools/scripts/build.js.map\n',
    );
    expect(r.edited).toEqual(['.gitignore:3: entry removed']);
  });

  it('a replacement command for a script; notes listed, not edited', () => {
    const t = createTreeWithEmptyWorkspace();
    t.write('docs/a.md', 'Use `node tools/scripts/tc.js` or tools/scripts/build.js.\n');
    t.write('.ai-context/notes.md', 'tools/scripts/tc.js\n');
    const r = removeScriptReferences(t, ['tools/scripts/build.js', 'tools/scripts/tc.js'], [], {
      'tools/scripts/tc.js': 'nx run-many -t typecheck',
    });
    expect(t.read('docs/a.md', 'utf8')).toBe(
      'Use `nx run-many -t typecheck` or the release target (`nx run <app>:release:<env>`).\n',
    );
    expect(r.edited).toEqual([
      'docs/a.md:1: now names the release target and `nx run-many -t typecheck`',
    ]);
    expect(r.notes).toEqual(['.ai-context/notes.md']);
    expect(t.read('.ai-context/notes.md', 'utf8')).toBe('tools/scripts/tc.js\n');
  });
});
