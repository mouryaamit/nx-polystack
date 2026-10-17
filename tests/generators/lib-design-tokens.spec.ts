import { readFileSync } from 'fs';
import * as path from 'path';

import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import libGenerator from '../../src/generators/lib/generator';
import {
  camelName,
  flattenTokens,
  kebabName,
  pascalName,
  renderCss,
  renderDart,
  renderEs6,
  renderScss,
} from '../../src/generators/lib/style-dictionary';

const ROOT = 'libs/shared/brand';

describe('lib generator --type=design-tokens', () => {
  let tree: Tree;

  const read = (f: string): string => tree.read(`${ROOT}/${f}`, 'utf8') ?? '';
  const gen = () => libGenerator(tree, { name: 'brand', type: 'design-tokens' });

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
    );
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it('writes Style Dictionary v3 token files', async () => {
    await gen();
    const color = readJson(tree, `${ROOT}/tokens/color.json`);
    expect(color.color.brand.primary).toEqual({ value: '#2563eb' });
    const spacing = readJson(tree, `${ROOT}/tokens/spacing.json`);
    expect(spacing.size.spacing.md).toEqual({ value: '1' });
    const typo = readJson(tree, `${ROOT}/tokens/typography.json`);
    expect(typo.size.font.lg).toEqual({ value: '1.25' });
    expect(typo.font.family.base.value).toContain('sans-serif');
    // Only families under `font`, which the flutter group quotes.
    expect(Object.keys(typo.font)).toEqual(['family']);
    expect(typo.fontWeight.bold).toEqual({ value: 700 });
    expect(typo.lineHeight.normal).toEqual({ value: 1.5 });
  });

  it('writes a CommonJS config with root-relative paths and the four platforms', async () => {
    await gen();
    const cfg = read('style-dictionary.config.js');
    expect(cfg).toContain("const LIB = 'libs/shared/brand';");
    expect(cfg).toContain('module.exports = {');
    expect(cfg).not.toMatch(/\bexport\b|\bimport\b/);
    expect(cfg).toContain('source: [`${LIB}/tokens/**/*.json`]');

    // Evaluate it as Node would, with the LIB constant substituted.
    const mod = { exports: {} as Record<string, unknown> };
    new Function('module', cfg)(mod);
    const config = mod.exports as {
      source: string[];
      platforms: Record<
        string,
        {
          transformGroup: string;
          buildPath: string;
          files: { destination: string; format: string; className?: string; filter?: unknown }[];
        }
      >;
    };
    expect(config.source).toEqual(['libs/shared/brand/tokens/**/*.json']);
    const p = config.platforms;
    expect(Object.keys(p)).toEqual(['scss', 'css', 'ts', 'dart']);
    for (const platform of Object.values(p)) {
      expect(platform.buildPath.endsWith('/')).toBe(true);
      expect(platform.buildPath.startsWith('libs/shared/brand/')).toBe(true);
    }
    expect(p['scss']).toMatchObject({
      transformGroup: 'scss',
      buildPath: 'libs/shared/brand/generated/scss/',
      files: [{ destination: '_tokens.scss', format: 'scss/variables' }],
    });
    expect(p['css']).toMatchObject({
      transformGroup: 'css',
      buildPath: 'libs/shared/brand/generated/css/',
      files: [{ destination: 'tokens.css', format: 'css/variables' }],
    });
    expect(p['ts']).toMatchObject({
      transformGroup: 'js',
      buildPath: 'libs/shared/brand/src/lib/',
      files: [{ destination: 'tokens.ts', format: 'javascript/es6' }],
    });
    expect(p['dart']).toMatchObject({
      transformGroup: 'flutter',
      buildPath: 'libs/shared/brand/generated/dart/lib/',
      files: [
        { destination: 'tokens.dart', format: 'flutter/class.dart', className: 'BrandTokens' },
      ],
    });
    // Every token reaches the Dart output (families are quoted by font/flutter/literal).
    expect(p['dart'].files[0].filter).toBeUndefined();
  });

  it('pre-generates every output, untouched by Prettier', async () => {
    await gen();
    const tokens = flattenTokens(
      Object.fromEntries(
        ['color', 'spacing', 'typography'].map((f) => [
          f,
          readJson(tree, `${ROOT}/tokens/${f}.json`),
        ]),
      ),
    );
    expect(read('generated/scss/_tokens.scss')).toBe(renderScss(tokens));
    expect(read('generated/css/tokens.css')).toBe(renderCss(tokens));
    expect(read('src/lib/tokens.ts')).toBe(renderEs6(tokens));
    expect(read('generated/dart/lib/tokens.dart')).toBe(
      renderDart(tokens, 'BrandTokens', 'tokens.dart'),
    );
    // Style Dictionary's double quotes survive (Prettier would have made them single).
    expect(read('src/lib/tokens.ts')).toContain('export const ColorBrandPrimary = "#2563eb";');
    expect(read('src/index.ts')).toBe("export * from './lib/tokens';\n");
    const dart = read('generated/dart/lib/tokens.dart');
    expect(dart).toContain('static const fontFamilyBase = "Inter, system-ui, sans-serif";');
    expect(dart).toContain('static const fontWeightRegular = 400;');
    expect(dart).toContain('static const lineHeightNormal = 1.5;');
    expect(read('generated/scss/_tokens.scss')).toContain('$line-height-normal: 1.5;');
  });

  it('pre-generated Dart matches a real Style Dictionary 3.9.2 build byte for byte', async () => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
    );
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    await libGenerator(tree, { name: 'tokens', type: 'design-tokens' });
    const real = readFileSync(
      path.join(__dirname, '../fixtures/style-dictionary-3.9-tokens.dart'),
      'utf8',
    );
    expect(tree.read('libs/shared/tokens/generated/dart/lib/tokens.dart', 'utf8')).toBe(real);
  });

  it('writes a Dart package for the Flutter output', async () => {
    await gen();
    const pubspec = read('generated/dart/pubspec.yaml');
    expect(pubspec).toMatch(/^name: brand_tokens$/m);
    expect(pubspec).toMatch(/dependencies:\n {2}flutter:\n {4}sdk: flutter/);
    expect(pubspec).toContain('publish_to: none');
  });

  it('writes project.json with a style-dictionary build and a lint that skips generated/', async () => {
    await gen();
    const pj = readJson(tree, `${ROOT}/project.json`);
    expect(pj.name).toBe('shared-brand');
    expect(pj.tags).toEqual(['scope:shared', 'type:design-tokens', 'platform:any']);
    expect(pj.targets.build).toEqual({
      executor: 'nx:run-commands',
      inputs: ['{projectRoot}/tokens/**/*.json', '{projectRoot}/style-dictionary.config.js'],
      outputs: ['{projectRoot}/generated', '{projectRoot}/src/lib/tokens.ts'],
      options: {
        command: 'npx style-dictionary build --config libs/shared/brand/style-dictionary.config.js',
      },
    });
    const patterns: string[] = pj.targets.lint.options.lintFilePatterns;
    expect(patterns).toEqual([`${ROOT}/src/**/*.ts`, `${ROOT}/*.js`]);
    expect(patterns.some((p) => p.includes('generated'))).toBe(false);
  });

  it('uses the ts type tsconfig/eslint files, the ts path and adds style-dictionary', async () => {
    await gen();
    expect(readJson(tree, `${ROOT}/tsconfig.json`).compilerOptions.strict).toBe(true);
    expect(readJson(tree, `${ROOT}/tsconfig.lib.json`).include).toEqual(['src/**/*.ts']);
    expect(readJson(tree, `${ROOT}/.eslintrc.json`).overrides).toEqual([
      { files: ['*.ts'], rules: {} },
    ]);
    expect(
      readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/shared-brand'],
    ).toEqual([`${ROOT}/src/index.ts`]);
    const pkg = readJson(tree, 'package.json');
    expect(pkg.devDependencies['style-dictionary']).toBe('^3.9.2');
    expect(pkg.devDependencies['@nx/eslint']).toBe('17.0.6');
  });

  it('keeps an existing style-dictionary version', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/source',
        devDependencies: { nx: '17.0.6', 'style-dictionary': '3.8.0' },
      }),
    );
    await gen();
    expect(readJson(tree, 'package.json').devDependencies['style-dictionary']).toBe('3.8.0');
  });

  it('adds the outputs to .prettierignore once, keeping existing entries', async () => {
    tree.write('.prettierignore', 'node_modules\ndist');
    await gen();
    await libGenerator(tree, { name: 'theme', type: 'design-tokens' });
    expect(tree.read('.prettierignore', 'utf8')).toBe(
      'node_modules\ndist\n' +
        '# Style Dictionary output (shared-brand)\n' +
        'libs/shared/brand/generated/\nlibs/shared/brand/src/lib/tokens.ts\n' +
        '# Style Dictionary output (shared-theme)\n' +
        'libs/shared/theme/generated/\nlibs/shared/theme/src/lib/tokens.ts\n',
    );
  });

  it('adds its generated outputs to an existing knip.json ignore list, once per lib', async () => {
    tree.write(
      'knip.json',
      '{\n  "$schema": "https://unpkg.com/knip@5/schema.json",\n  "entry": ["apps/*/src/main.ts"]\n}\n',
    );
    await gen();
    await libGenerator(tree, { name: 'theme', type: 'design-tokens' });
    const text = tree.read('knip.json', 'utf8') ?? '';
    expect(JSON.parse(text).ignore).toEqual([
      'libs/shared/brand/generated/**',
      'libs/shared/brand/src/lib/tokens.ts',
      'libs/shared/theme/generated/**',
      'libs/shared/theme/src/lib/tokens.ts',
    ]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prettier = require('prettier');
    expect(prettier.format(text, { parser: 'json', printWidth: 100 })).toBe(text);
  });

  it('does not create knip.json', async () => {
    await gen();
    expect(tree.exists('knip.json')).toBe(false);
  });

  it('README shows SCSS, CSS, TS and Dart usage', async () => {
    await gen();
    const readme = read('README.md');
    expect(readme).toContain('"includePaths": ["libs/shared/brand/generated/scss"]');
    expect(readme).toContain("@use 'tokens' as t;");
    expect(readme).toContain('"styles": ["libs/shared/brand/generated/css/tokens.css"');
    expect(readme).toContain(
      "import { ColorBrandPrimary, SizeSpacingMd } from '@acme/shared-brand';",
    );
    expect(readme).toContain('path: ../../libs/shared/brand/generated/dart');
    expect(readme).toContain("import 'package:brand_tokens/tokens.dart';");
    expect(readme).toContain('BrandTokens.colorBrandPrimary');
  });

  it('rejects --variant', async () => {
    await expect(
      libGenerator(tree, { name: 'brand', type: 'design-tokens', variant: 'buildable' }),
    ).rejects.toThrow(/has no variants/);
  });
});

describe('Style Dictionary 3 output emulation', () => {
  const tokens = flattenTokens({
    b: {
      size: { font: { md: { value: '1' } } },
      font: { family: { base: { value: 'Inter, sans-serif' } } },
      fontWeight: { bold: { value: 700 } },
    },
    a: {
      color: { brand: { primary: { value: '#2563EB', comment: 'main' } } },
      size: { spacing: { sm: { value: '0.5' } } },
    },
  });

  it('merges files in name order and flattens in key order', () => {
    expect(tokens.map((t) => t.path.join('.'))).toEqual([
      'color.brand.primary',
      'size.spacing.sm',
      'size.font.md',
      'font.family.base',
      'fontWeight.bold',
    ]);
  });

  it('names tokens like the cti name transforms', () => {
    expect(kebabName(['lineHeight', 'tight'])).toBe('line-height-tight');
    expect(camelName(['lineHeight', 'tight'])).toBe('lineHeightTight');
    expect(kebabName(['font', 'line-height', 'tight'])).toBe('font-line-height-tight');
    expect(pascalName(['color', 'brand', 'primary'])).toBe('ColorBrandPrimary');
  });

  it('renders scss/variables', () => {
    expect(renderScss(tokens)).toBe(
      '\n// Do not edit directly\n// Generated by Style Dictionary from tokens/*.json\n\n' +
        '$color-brand-primary: #2563eb; // main\n' +
        '$size-spacing-sm: 0.5rem;\n$size-font-md: 1rem;\n' +
        '$font-family-base: Inter, sans-serif;\n$font-weight-bold: 700;\n',
    );
  });

  it('renders css/variables', () => {
    expect(renderCss(tokens)).toBe(
      '/**\n * Do not edit directly\n * Generated by Style Dictionary from tokens/*.json\n */\n\n' +
        ':root {\n  --color-brand-primary: #2563eb; /* main */\n  --size-spacing-sm: 0.5rem;\n' +
        '  --size-font-md: 1rem;\n  --font-family-base: Inter, sans-serif;\n' +
        '  --font-weight-bold: 700;\n}\n',
    );
  });

  it('renders javascript/es6', () => {
    expect(renderEs6(tokens)).toContain(
      'export const ColorBrandPrimary = "#2563eb"; // main\n' +
        'export const SizeSpacingSm = "0.5rem";\n' +
        'export const SizeFontMd = "1rem";\n' +
        'export const FontFamilyBase = "Inter, sans-serif";\n' +
        'export const FontWeightBold = 700;\n',
    );
  });

  it('renders flutter/class.dart', () => {
    const dart = renderDart(tokens, 'BrandTokens', 'tokens.dart');
    expect(dart).toContain('\n//\n// tokens.dart\n//\n');
    expect(dart).toContain("import 'dart:ui';\n\nclass BrandTokens {\n  BrandTokens._();\n\n");
    expect(dart).toContain('    static const colorBrandPrimary = Color(0xFF2563EB); // main\n');
    expect(dart).toContain('    static const sizeFontMd = 16.00;\n');
    expect(dart).toContain('    static const fontFamilyBase = "Inter, sans-serif";\n');
    expect(dart).toContain('    static const fontWeightBold = 700;\n');
    // flutter/class.dart sorts by name, so sizeSpacingSm comes last.
    expect(dart).toContain('    static const sizeSpacingSm = 8.00;\n}\n');
  });
});
