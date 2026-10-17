import * as path from 'path';

import { generateFiles, Tree, writeJson } from '@nx/devkit';

import { addMissingDependencies, ensureLintDependencies } from '../../../lib/utils/dependencies';
import { addKnipIgnores } from '../../../lib/utils/knip';
import {
  combineTasks,
  lintTarget,
  LibTypeSpec,
  NormalizedLibOptions,
  templateVars,
  writeLibProjectJson,
} from '../lib-utils';
import {
  flattenTokens,
  renderCss,
  renderDart,
  renderEs6,
  renderScss,
  TEMPLATE_TOKENS,
  TOKENS_FILE_HEADER,
} from '../style-dictionary';

import { writeTsLibConfig } from './ts';

export const STYLE_DICTIONARY_VERSION = '^3.9.2';

/** Style Dictionary outputs, relative to the project root. */
export const TOKEN_OUTPUTS = {
  scss: 'generated/scss/_tokens.scss',
  css: 'generated/css/tokens.css',
  ts: 'src/lib/tokens.ts',
  dart: 'generated/dart/lib/tokens.dart',
} as const;

const dartClassName = (o: NormalizedLibOptions) => `${o.className}Tokens`;

/** Keeps `prettier --check .` from flagging what Style Dictionary writes. */
function ignoreOutputsForPrettier(tree: Tree, o: NormalizedLibOptions): void {
  const entries = [`${o.projectRoot}/generated/`, `${o.projectRoot}/${TOKEN_OUTPUTS.ts}`];
  const current = tree.exists('.prettierignore') ? tree.read('.prettierignore', 'utf8') ?? '' : '';
  const lines = current.split(/\r?\n/);
  const missing = entries.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  tree.write(
    '.prettierignore',
    `${current}${sep}# Style Dictionary output (${o.projectName})\n${missing.join('\n')}\n`,
  );
}

export const designTokensLib: LibTypeSpec = {
  defaultScope: 'shared',
  platform: 'any',
  tsPath: true,
  dirCase: 'kebab',
  generate(tree, o) {
    writeTsLibConfig(tree, o);
    generateFiles(tree, path.join(__dirname, '..', 'files', 'design-tokens'), o.projectRoot, {
      ...templateVars(o),
      dartClassName: dartClassName(o),
      outputs: TOKEN_OUTPUTS,
      fileHeader: JSON.stringify(TOKENS_FILE_HEADER),
    });
    for (const [name, tokens] of Object.entries(TEMPLATE_TOKENS)) {
      writeJson(tree, `${o.projectRoot}/tokens/${name}.json`, tokens);
    }
    writeLibProjectJson(tree, o, {
      sourceRoot: `${o.projectRoot}/src`,
      targets: {
        build: {
          executor: 'nx:run-commands',
          inputs: ['{projectRoot}/tokens/**/*.json', '{projectRoot}/style-dictionary.config.js'],
          outputs: ['{projectRoot}/generated', `{projectRoot}/${TOKEN_OUTPUTS.ts}`],
          options: {
            command: `npx style-dictionary build --config ${o.projectRoot}/style-dictionary.config.js`,
          },
        },
        // generated/ is left out: only the sources and the config are linted.
        lint: lintTarget(o, ['src/**/*.ts', '*.js']),
      },
    });
    ignoreOutputsForPrettier(tree, o);
    return combineTasks(
      ensureLintDependencies(tree),
      addMissingDependencies(tree, {}, { 'style-dictionary': STYLE_DICTIONARY_VERSION }),
    );
  },
  afterFormat(tree, o) {
    // Written after Prettier so they match what `style-dictionary build` emits as closely as possible.
    const tokens = flattenTokens(TEMPLATE_TOKENS);
    const out = (rel: string, content: string) => tree.write(`${o.projectRoot}/${rel}`, content);
    out(TOKEN_OUTPUTS.scss, renderScss(tokens));
    out(TOKEN_OUTPUTS.css, renderCss(tokens));
    out(TOKEN_OUTPUTS.ts, renderEs6(tokens));
    out(TOKEN_OUTPUTS.dart, renderDart(tokens, dartClassName(o), 'tokens.dart'));
    // Only when the workspace already uses knip (pstack infra); written in Prettier's shape.
    addKnipIgnores(tree, [`${o.projectRoot}/generated/**`, `${o.projectRoot}/${TOKEN_OUTPUTS.ts}`]);
  },
};
