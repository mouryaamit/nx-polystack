import { readJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import {
  applyEnvAlias,
  ensureEnvAlias,
  envAliasImport,
  rewriteEnvImports,
} from '../../src/lib/utils/env-alias';
import envImportAlias from '../../src/migrations/env-import-alias/env-import-alias';

describe('env alias helpers', () => {
  it('maps a file under environments/ to the alias', () => {
    expect(envAliasImport('environments/web/environment')).toBe('@env/web/environment');
    expect(envAliasImport('environments/environment.ts')).toBe('@env/environment');
  });

  it('adds the alias once and reports a conflicting one', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(ensureEnvAlias(tree)).toBe('added');
    expect(ensureEnvAlias(tree)).toBe('present');
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@env/*']).toEqual([
      'environments/*',
    ]);

    const other = createTreeWithEmptyWorkspace();
    other.write(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: { paths: { '@env/*': ['src/env/*'] } } }),
    );
    expect(ensureEnvAlias(other)).toBe('conflict');
    expect(readJson(other, 'tsconfig.base.json').compilerOptions.paths['@env/*']).toEqual([
      'src/env/*',
    ]);
  });

  it('keeps comments in a tsconfig with comments', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'tsconfig.base.json',
      '{\n  // shared options\n  "compilerOptions": { "baseUrl": "." }\n}\n',
    );
    expect(ensureEnvAlias(tree)).toBe('added');
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@env/*']).toEqual([
      'environments/*',
    ]);
  });

  it('rewrites relative and baseUrl-style env imports only', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'apps/web/src/app/app.component.ts',
      [
        "import { environment } from '../../../../environments/web/environment';",
        "import { other } from 'environments/web/environment.prod';",
        "import { thing } from './thing';",
        "import { lib } from '../../../../libs/shared/src';",
        "const lazy = () => import('../../../../environments/web/flags');",
        '',
      ].join('\n'),
    );
    expect(rewriteEnvImports(tree, 'apps/web/src/app/app.component.ts')).toBe(3);
    const out = tree.read('apps/web/src/app/app.component.ts', 'utf8');
    expect(out).toContain("from '@env/web/environment';");
    expect(out).toContain("from '@env/web/environment.prod';");
    expect(out).toContain("import('@env/web/flags')");
    expect(out).toContain("from './thing';");
    expect(out).toContain("from '../../../../libs/shared/src';");
  });

  it('leaves files inside environments/ alone', () => {
    const tree = createTreeWithEmptyWorkspace();
    const text = "import { base } from './environment';\nexport const environment = base;\n";
    tree.write('environments/web/environment.prod.ts', text);
    expect(rewriteEnvImports(tree, 'environments/web/environment.prod.ts')).toBe(0);
    expect(tree.read('environments/web/environment.prod.ts', 'utf8')).toBe(text);
  });
});

describe('env-import-alias migration', () => {
  function workspace() {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('environments/web/environment.ts', 'export const environment = {};\n');
    tree.write(
      'apps/web/src/main.ts',
      "import { environment } from '../../../environments/web/environment';\n",
    );
    tree.write(
      'libs/shared/src/lib/env-secret.ts',
      "import { environment } from '../../../../environments/web/environment';\n",
    );
    tree.write(
      'node_modules/pkg/index.ts',
      "import x from '../../environments/web/environment';\n",
    );
    return tree;
  }

  it('adds the alias and rewrites imports in apps and libs', () => {
    const tree = workspace();
    envImportAlias(tree);
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@env/*']).toEqual([
      'environments/*',
    ]);
    expect(tree.read('apps/web/src/main.ts', 'utf8')).toBe(
      "import { environment } from '@env/web/environment';\n",
    );
    expect(tree.read('libs/shared/src/lib/env-secret.ts', 'utf8')).toBe(
      "import { environment } from '@env/web/environment';\n",
    );
    expect(tree.read('node_modules/pkg/index.ts', 'utf8')).toContain('../../environments');
  });

  it('is idempotent', () => {
    const tree = workspace();
    envImportAlias(tree);
    const once = tree.read('apps/web/src/main.ts', 'utf8');
    envImportAlias(tree);
    expect(tree.read('apps/web/src/main.ts', 'utf8')).toBe(once);
  });

  it('changes nothing without an environments folder', () => {
    const tree = createTreeWithEmptyWorkspace();
    const before = tree.read('tsconfig.base.json', 'utf8');
    expect(applyEnvAlias(tree).state).toBe('no-environments');
    envImportAlias(tree);
    expect(tree.read('tsconfig.base.json', 'utf8')).toBe(before);
  });

  it('leaves imports relative when @env/* points elsewhere', () => {
    const tree = workspace();
    tree.write(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: { paths: { '@env/*': ['src/env/*'] } } }),
    );
    envImportAlias(tree);
    expect(tree.read('apps/web/src/main.ts', 'utf8')).toContain('../../../environments/');
  });
});
