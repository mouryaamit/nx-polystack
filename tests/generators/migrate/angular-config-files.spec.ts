import {
  appRootTsconfig,
  extendRootEslintConfig,
  fixProjectTsconfig,
  mergeTsPaths,
} from '../../../src/generators/migrate/angular-config-files';
import { PathMapper } from '../../../src/generators/migrate/angular-project-json';

const mapper = (over: Partial<PathMapper> = {}): PathMapper => ({
  sourceRoot: '',
  projectRoot: 'apps/portal',
  name: 'portal',
  exists: () => true,
  warnings: [],
  ...over,
});

describe('migrate: tsconfig and ESLint rewrites', () => {
  it('root tsconfig extends the workspace base and drops baseUrl, paths and outDir', () => {
    expect(
      appRootTsconfig(
        {
          compileOnSave: false,
          compilerOptions: {
            baseUrl: './',
            outDir: './dist/out-tsc',
            paths: { '@x/*': ['src/x/*'] },
            strict: true,
            target: 'ES2022',
          },
          angularCompilerOptions: { strictTemplates: true },
        },
        mapper(),
      ),
    ).toEqual({
      extends: '../../tsconfig.base.json',
      compileOnSave: false,
      compilerOptions: { strict: true, target: 'ES2022' },
      angularCompilerOptions: { strictTemplates: true },
    });
  });

  it('root tsconfig: rebases include, files, references and typeRoots for a nested project root', () => {
    expect(
      appRootTsconfig(
        {
          compilerOptions: {
            typeRoots: ['./node_modules/@types', 'node_modules/@types/', './projects/shop/typings'],
          },
          files: ['projects/shop/src/main.ts'],
          include: ['projects/shop/src/**/*.d.ts'],
          references: [
            { path: './projects/shop/tsconfig.app.json' },
            { path: './tsconfig.node.json' },
          ],
        },
        mapper({ sourceRoot: 'projects/shop' }),
      ),
    ).toEqual({
      extends: '../../tsconfig.base.json',
      compilerOptions: { typeRoots: ['./typings'] },
      files: ['./src/main.ts'],
      include: ['./src/**/*.d.ts'],
      references: [{ path: './tsconfig.app.json' }, { path: '../../tsconfig.node.json' }],
    });
  });

  it('root tsconfig at the repo root: paths stay relative, node_modules/@types typeRoots are dropped', () => {
    expect(
      appRootTsconfig(
        {
          compilerOptions: { typeRoots: ['node_modules/@types', 'src/typings'] },
          include: ['src/**/*.ts'],
        },
        mapper(),
      ),
    ).toEqual({
      extends: '../../tsconfig.base.json',
      compilerOptions: { typeRoots: ['./src/typings'] },
      include: ['./src/**/*.ts'],
    });
  });

  it('tsconfig.app.json keeps extends ./tsconfig.json and gets the workspace outDir', () => {
    const r = fixProjectTsconfig(
      {
        extends: './tsconfig.json',
        compilerOptions: { outDir: './out-tsc/app', types: [] },
        files: ['src/main.ts'],
      },
      { sourceFile: 'tsconfig.app.json', sourceRoot: '', projectRoot: 'apps/portal' },
    );
    expect(r).toEqual({
      config: {
        extends: './tsconfig.json',
        compilerOptions: { outDir: '../../dist/out-tsc', types: [] },
        files: ['src/main.ts'],
      },
      warnings: [],
    });
  });

  it('a nested project tsconfig pointing at the repo-root tsconfig now points at apps/<name>/tsconfig.json', () => {
    const r = fixProjectTsconfig(
      { extends: '../../tsconfig.json', compilerOptions: { outDir: '../../out-tsc/app' } },
      {
        sourceFile: 'projects/shop/tsconfig.app.json',
        sourceRoot: 'projects/shop',
        projectRoot: 'apps/portal',
      },
    );
    expect(r.config).toEqual({
      extends: './tsconfig.json',
      compilerOptions: { outDir: '../../dist/out-tsc' },
    });
  });

  it('a tsconfig in a sub-folder gets paths for its depth', () => {
    const r = fixProjectTsconfig(
      { extends: '../tsconfig.json', compilerOptions: { outDir: '../out-tsc/e2e' } },
      { sourceFile: 'e2e/tsconfig.json', sourceRoot: '', projectRoot: 'apps/portal' },
    );
    expect(r.config).toEqual({
      extends: '../tsconfig.json',
      compilerOptions: { outDir: '../../../dist/out-tsc' },
    });
  });

  it('warns about extends outside the project, and leaves package extends alone', () => {
    const outside = fixProjectTsconfig(
      { extends: '../../tsconfig.shared.json' },
      {
        sourceFile: 'projects/shop/tsconfig.app.json',
        sourceRoot: 'projects/shop',
        projectRoot: 'apps/portal',
      },
    );
    expect(outside.warnings).toEqual([
      'projects/shop/tsconfig.app.json: extends "../../tsconfig.shared.json" is outside the project; left unchanged',
    ]);
    const pkg = fixProjectTsconfig(
      { extends: '@tsconfig/strictest/tsconfig.json' },
      { sourceFile: 'tsconfig.app.json', sourceRoot: '', projectRoot: 'apps/portal' },
    );
    expect(pkg).toEqual({ config: { extends: '@tsconfig/strictest/tsconfig.json' }, warnings: [] });
  });

  it('merges source paths into the base: new aliases added, same mapping ignored, clashes reported', () => {
    const r = mergeTsPaths(
      {
        '@acme/ui': ['libs/shared/ui/src/index.ts'],
        '@app/env': ['apps/portal/src/environments/environment.ts'],
      },
      {
        '@app/core/*': ['src/app/core/*'],
        '@app/env': ['src/environments/environment.ts'],
        '@acme/ui': ['src/app/ui/index.ts'],
      },
      './',
      mapper(),
    );
    expect(r.paths).toEqual({
      '@acme/ui': ['libs/shared/ui/src/index.ts'],
      '@app/env': ['apps/portal/src/environments/environment.ts'],
      '@app/core/*': ['apps/portal/src/app/core/*'],
    });
    expect(r.added).toEqual(['@app/core/*']);
    expect(r.clashes).toEqual([
      {
        alias: '@acme/ui',
        workspace: ['libs/shared/ui/src/index.ts'],
        source: ['apps/portal/src/app/ui/index.ts'],
      },
    ]);
  });

  it('resolves path targets against the source baseUrl', () => {
    const r = mergeTsPaths({}, { '@app/*': ['app/*'] }, 'src', mapper());
    expect(r.paths).toEqual({ '@app/*': ['apps/portal/src/app/*'] });
  });

  it('a copied .eslintrc.json extends the root config and un-ignores the app', () => {
    expect(
      extendRootEslintConfig(
        {
          root: true,
          ignorePatterns: ['projects/**/*'],
          overrides: [
            {
              files: ['*.ts'],
              parserOptions: {
                project: ['tsconfig.json', 'tsconfig.app.json'],
                createDefaultProgram: true,
              },
              extends: ['plugin:@angular-eslint/recommended'],
            },
            { files: ['*.html'], extends: ['plugin:@angular-eslint/template/recommended'] },
          ],
        },
        mapper(),
      ),
    ).toEqual({
      extends: ['../../.eslintrc.json'],
      ignorePatterns: ['!**/*', 'projects/**/*'],
      overrides: [
        {
          files: ['*.ts'],
          parserOptions: {
            project: ['apps/portal/tsconfig.json', 'apps/portal/tsconfig.app.json'],
            createDefaultProgram: true,
          },
          extends: ['plugin:@angular-eslint/recommended'],
        },
        { files: ['*.html'], extends: ['plugin:@angular-eslint/template/recommended'] },
      ],
    });
  });

  it('keeps existing extends after the root config', () => {
    const out = extendRootEslintConfig({ extends: 'eslint:recommended' }, mapper());
    expect(out['extends']).toEqual(['../../.eslintrc.json', 'eslint:recommended']);
  });
});

describe('migrate: nested project roots', () => {
  it('extends the workspace files from the right depth', () => {
    const m = mapper({ projectRoot: 'apps/legacy/portal' });
    expect(appRootTsconfig({}, m)['extends']).toBe('../../../tsconfig.base.json');
    expect(
      extendRootEslintConfig({ extends: ['../../.eslintrc.json'] }, m)['extends'] as string[],
    ).toEqual(['../../../.eslintrc.json']);
  });
});
