import * as path from 'path';

import { Tree, formatFiles, generateFiles, updateJson } from '@nx/devkit';

import { readPackageVersion, selfPackageRoot } from '../../cli/context';
import { formatPluginSpec, PLUGIN_NAME } from '../../cli/versions';
import { defaultEnvEncryptionConfig } from '../../lib/env-encryption/config';
import { writeEnvEncryptionBlock } from '../../lib/env-encryption/workspace';
import { ANGULAR_PINS } from '../../lib/upgrade/pins';
import { ensureAngularDependencies, GENERATOR_ANGULAR_MAJORS } from '../../lib/utils/angular-deps';
import { typescriptEslintVersion } from '../../lib/utils/dependencies';
import { LINT_STAGED_CONFIG } from '../../lib/utils/lint-staged';
import {
  LINT_STAGED_ESLINT_COMMAND,
  LINT_STAGED_ESLINT_JS,
  LINT_STAGED_ESLINT_SCRIPT,
  unusedImportsVersion,
} from '../../lib/utils/quality';
import { normalizeProviders } from '../../lib/utils/llm-block';
import infraGenerator from '../infra/generator';
import { parseCiProviders, parseParts } from '../infra/options';
import llmGenerator from '../llm/generator';

import { PresetGeneratorSchema } from './schema.d';

/** What the workspace "lint" npm script runs when the CI lint command is "npm run lint". */
export const DEFAULT_LINT_SCRIPT = 'nx run-many -t lint';

/**
 * True when the command, used as the "lint" npm script, would only run that script again:
 * `npm run lint`, `npm run-script lint`, `yarn lint`, `pnpm [run] lint`, optionally followed by
 * `--fix` or `-- <args>`. Anything more (`npm run lint && x`, `npm run lint:all`) is not matched.
 */
export function isRecursiveLintCommand(command: string): boolean {
  return /^\s*(npm\s+run(-script)?|yarn|pnpm(\s+run)?)\s+lint(\s+--fix|\s+--\s.*)?\s*$/.test(
    command,
  );
}

/**
 * Nx and the lint stack for a new workspace on this Angular major: the major's Nx pin (Nx 18 from
 * Angular 17), and from Nx 18 typescript-eslint 7 with eslint-plugin-unused-imports 3 (its peer).
 */
export function alignWorkspaceStack(tree: Tree, angularMajor: number): void {
  const nx = `~${ANGULAR_PINS[angularMajor].nx}`;
  const tsEslint = typescriptEslintVersion(nx);
  updateJson(tree, 'package.json', (json) => {
    const dev: Record<string, string> = json.devDependencies ?? {};
    for (const name of ['nx', '@nx/devkit', '@nx/eslint', '@nx/eslint-plugin']) {
      if (dev[name] !== undefined) dev[name] = nx;
    }
    for (const name of ['@typescript-eslint/eslint-plugin', '@typescript-eslint/parser']) {
      if (dev[name] !== undefined) dev[name] = tsEslint;
    }
    json.devDependencies = dev;
    return json;
  });
  updateJson(tree, 'package.json', (json) => {
    if (json.devDependencies?.['eslint-plugin-unused-imports'] !== undefined) {
      json.devDependencies['eslint-plugin-unused-imports'] = unusedImportsVersion(tree);
    }
    return json;
  });
}

export default async function presetGenerator(
  tree: Tree,
  options: PresetGeneratorSchema,
): Promise<void> {
  const {
    npmScope = 'mouryaamit',
    baseBranch = 'master',
    ci = '',
    infra,
    llm = '',
    projectDescription = '',
    lintCommand = 'npm run lint',
    skipFormat = false,
  } = options;

  // Validated up front so a bad --infra, --ci or --llm fails before anything is generated.
  const infraParts = parseParts(infra, '--infra');
  const ciProviders = parseCiProviders(ci);
  const llmProviders = llm.trim() ? normalizeProviders(llm) : [];

  // package.json's "lint" script must not call itself ("npm run lint" → infinite recursion).
  // Broader than the migration's exact check: any command that starts by running the "lint" script
  // (e.g. "npm run lint && x") would call itself from inside that script.
  const callsLintScript = /^\s*(npm\s+run(-script)?|yarn|pnpm(\s+run)?)\s+lint(\s|$)/.test(
    lintCommand,
  );
  const lintScript =
    callsLintScript || isRecursiveLintCommand(lintCommand) ? DEFAULT_LINT_SCRIPT : lintCommand;
  const vars = {
    npmScope,
    baseBranch,
    projectDescription,
    lintCommand,
    lintScript,
    template: '',
  };

  generateFiles(tree, path.join(__dirname, 'files', 'root'), '.', vars);
  // Env encryption settings for release builds (pstack encryption changes them).
  // New workspaces mark encrypted values as ENC(...) (read by runtime/env-secret).
  writeEnvEncryptionBlock(tree, { ...defaultEnvEncryptionConfig(), format: 'enc' });
  const pluginVersion =
    options.pluginVersion ||
    readPackageVersion(path.join(selfPackageRoot(__dirname), 'package.json'));
  updateJson(tree, 'package.json', (json) => {
    json.devDependencies = {
      ...json.devDependencies,
      [PLUGIN_NAME]: formatPluginSpec(pluginVersion),
    };
    // The husky pre-commit hook runs `npx lint-staged`, which fails without a config.
    // ESLint on commit reports without blocking (pstack infra --lint-staged=block to block).
    if (json['lint-staged'] === undefined) {
      json['lint-staged'] = {
        ...LINT_STAGED_CONFIG,
        '*.ts': [LINT_STAGED_ESLINT_COMMAND.warn],
      };
    }
    return json;
  });
  tree.write(LINT_STAGED_ESLINT_SCRIPT, LINT_STAGED_ESLINT_JS);

  // `pstack new --angular=N`: the workspace starts on that Angular, so apps, libraries and
  // migrated projects are generated for it (pstack new installs after the preset).
  if (options.angular !== undefined) {
    if (!GENERATOR_ANGULAR_MAJORS.includes(options.angular)) {
      throw new Error(
        `preset: --angular must be one of ${GENERATOR_ANGULAR_MAJORS.join(', ')} (got ${
          options.angular
        }).`,
      );
    }
    alignWorkspaceStack(tree, options.angular);
    ensureAngularDependencies(tree, { major: options.angular });
  }

  // Repo docs, CI (replaces the old --ci templates), quality checks, upgrade workflow. Its install
  // task is not returned: `pstack new` (or Nx's create flow) installs after the preset.
  if (infraParts.length > 0) {
    await infraGenerator(tree, {
      with: infraParts.join(','),
      ci: ciProviders.join(','),
      ciCache: options.ciCache,
      flutter: options.flutter,
      upgradeSchedule: options.upgradeSchedule,
      upgradeScope: options.upgradeScope,
      skipFormat: true,
    });
  }

  if (!skipFormat) {
    await formatFiles(tree);
  }

  // After formatting: the block is already in Prettier's shape and must stay byte-stable.
  if (llmProviders.length > 0) {
    await llmGenerator(tree, { providers: llmProviders.join(',') });
  }
}
