import { logger, Tree, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import * as prettier from 'prettier';

import {
  LLM_END,
  LLM_PROVIDERS,
  LLM_START,
  normalizeProviders,
  refreshLlmBlocks,
  renderBlock,
  scanWorkspace,
  upsertBlock,
} from '../../src/lib/utils/llm-block';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PLUGIN_VERSION: string = require('../../package.json').version;

const BLOCK = `${LLM_START}\n\nbody v1\n\n${LLM_END}`;
const target = { file: 'CLAUDE.md', title: '# CLAUDE.md' };

describe('upsertBlock', () => {
  it('creates a file with the title and the block', () => {
    expect(upsertBlock(null, 'body v1', target)).toBe(`# CLAUDE.md\n\n${BLOCK}\n`);
  });

  it('replaces only the block content and keeps everything else byte-for-byte', () => {
    const before = `# Mine\r\n\nintro  \n\n${LLM_START}\nold stuff\n${LLM_END}\n\n## After\ntrailing`;
    const after = upsertBlock(before, 'body v1', target);
    expect(after).toBe(`# Mine\r\n\nintro  \n\n${BLOCK}\n\n## After\ntrailing`);
  });

  it('appends a blank line and the block when there are no markers', () => {
    expect(upsertBlock('# Notes\n\nhand written\n', 'body v1', target)).toBe(
      `# Notes\n\nhand written\n\n${BLOCK}\n`,
    );
    expect(upsertBlock('# Notes', 'body v1', target)).toBe(`# Notes\n\n${BLOCK}\n`);
  });

  it('fills an empty file with just the block', () => {
    expect(upsertBlock('', 'body v1', target)).toBe(`${BLOCK}\n`);
  });

  it('is idempotent', () => {
    const once = upsertBlock('# Notes\n', 'body v1', target);
    expect(upsertBlock(once, 'body v1', target)).toBe(once);
  });

  it.each([
    ['start without end', `${LLM_START}\nx\n`],
    ['end without start', `x\n${LLM_END}\n`],
    ['end before start', `${LLM_END}\nx\n${LLM_START}\n`],
    ['duplicate start', `${LLM_START}\n${LLM_START}\nx\n${LLM_END}\n`],
    ['duplicate blocks', `${LLM_START}\na\n${LLM_END}\n${LLM_START}\nb\n${LLM_END}\n`],
  ])('rejects malformed markers (%s), naming the file', (_case, content) => {
    expect(() => upsertBlock(content, 'body', target)).toThrow(/CLAUDE\.md/);
    expect(() => upsertBlock(content, 'body', target)).toThrow(/malformed/);
  });
});

describe('normalizeProviders', () => {
  it('defaults to claude, agents and copilot', () => {
    expect(normalizeProviders(undefined)).toEqual(['claude', 'agents', 'copilot']);
    expect(normalizeProviders('')).toEqual(['claude', 'agents', 'copilot']);
  });

  it('maps codex and openai-gpt to agents, dedupes and keeps a stable order', () => {
    expect(normalizeProviders('copilot, codex,openai-gpt,claude')).toEqual([
      'claude',
      'agents',
      'copilot',
    ]);
    expect(normalizeProviders(['agents'])).toEqual(['agents']);
  });

  it('rejects unknown providers with the supported list', () => {
    expect(() => normalizeProviders('claude,gemini')).toThrow(
      /unknown provider "gemini".*claude, agents, copilot/,
    );
  });

  it('maps each provider to its file', () => {
    expect(LLM_PROVIDERS.claude.file).toBe('CLAUDE.md');
    expect(LLM_PROVIDERS.agents.file).toBe('AGENTS.md');
    expect(LLM_PROVIDERS.copilot.file).toBe('.github/copilot-instructions.md');
  });
});

/** A workspace with one app of each type and a few libs, shaped like the generators write them. */
function polystack(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  writeJson(tree, 'package.json', {
    name: '@acme/workspace',
    dependencies: { '@angular/core': '~15.2.0' },
    devDependencies: { nx: '~17.0.6' },
    scripts: {
      'serve:web': 'nx serve web',
      'build:web:prod:secure:sri': 'nx run web:release:prod --secure --sri',
      'build:field:prod:android': 'nx run field:release:prod',
      'open:field:ios': 'nx run field:cap-open --platform=ios',
    },
  });
  writeJson(tree, 'tsconfig.base.json', {
    compilerOptions: {
      paths: {
        '@acme/web': ['apps/web/src'],
        '@acme/shared-ui': ['libs/shared/ui/src/index.ts'],
        '@acme/shared-util': ['./libs/shared/util/src/index.ts'],
      },
    },
  });
  const releaseConfigs = { dev: {}, uat: {}, prod: {} };
  writeJson(tree, 'apps/web/project.json', {
    name: 'web',
    projectType: 'application',
    targets: {
      build: { executor: '@angular-devkit/build-angular:browser' },
      serve: { executor: '@angular-devkit/build-angular:dev-server' },
      release: { executor: '@mouryaamit/nx-polystack:build', configurations: releaseConfigs },
    },
  });
  writeJson(tree, 'apps/field/project.json', {
    name: 'field',
    projectType: 'application',
    targets: {
      serve: { executor: '@angular-devkit/build-angular:dev-server' },
      release: {
        executor: '@mouryaamit/nx-polystack:build',
        configurations: { ...releaseConfigs, qa: {} },
      },
      'cap-sync': { executor: '@mouryaamit/nx-polystack:capacitor' },
    },
  });
  writeJson(tree, 'apps/mobile/project.json', {
    name: 'mobile',
    projectType: 'application',
    targets: {
      serve: { executor: '@mouryaamit/nx-polystack:flutter-build' },
      'build-web': {
        executor: '@mouryaamit/nx-polystack:flutter-build',
        configurations: { dev: {}, staging: {} },
      },
    },
  });
  writeJson(tree, 'libs/shared/util/project.json', {
    name: 'shared-util',
    tags: ['scope:shared', 'type:ts'],
  });
  writeJson(tree, 'libs/shared/ui/project.json', {
    name: 'shared-ui',
    tags: ['scope:shared', 'type:angular', 'platform:web'],
  });
  writeJson(tree, 'libs/flutter/shared_core/project.json', {
    name: 'flutter-shared-core',
    tags: ['scope:flutter', 'type:flutter'],
  });
  writeJson(tree, 'libs/shared/brand/project.json', { name: 'shared-brand', tags: [] });
  // Ignored: node_modules and dot-directories.
  writeJson(tree, 'libs/node_modules/x/project.json', { name: 'nm' });
  writeJson(tree, 'apps/.cache/project.json', { name: 'hidden' });
  return tree;
}

describe('scanWorkspace', () => {
  it('reads the workspace versions', () => {
    const info = scanWorkspace(polystack());
    expect(info.npmScope).toBe('acme');
    expect(info.nxVersion).toBe('~17.0.6');
    expect(info.angularVersion).toBe('~15.2.0');
    expect(info.pluginVersion).toBe(PLUGIN_VERSION);
  });

  it('prefers the installed nx version', () => {
    const tree = polystack();
    writeJson(tree, 'node_modules/nx/package.json', { name: 'nx', version: '17.0.6' });
    expect(scanWorkspace(tree).nxVersion).toBe('17.0.6');
  });

  it('leaves out Angular and Nx when they are not declared', () => {
    const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    writeJson(tree, 'package.json', { name: '@acme/workspace' });
    const info = scanWorkspace(tree);
    expect(info.angularVersion).toBeUndefined();
    expect(info.nxVersion).toBeUndefined();
    expect(info.apps).toEqual([]);
    expect(info.libs).toEqual([]);
  });

  it('detects angular, ionic and flutter apps, sorted, skipping node_modules and dot-dirs', () => {
    const { apps } = scanWorkspace(polystack());
    expect(apps.map((a) => [a.name, a.type, a.root])).toEqual([
      ['field', 'ionic', 'apps/field'],
      ['mobile', 'flutter', 'apps/mobile'],
      ['web', 'angular', 'apps/web'],
    ]);
    expect(apps[0].commands).toEqual([
      'npx nx serve field',
      'npx nx run field:release:<env>',
      'npx nx run field:cap-sync',
    ]);
    expect(apps[1].commands).toEqual(['npx nx serve mobile', 'npx nx run mobile:build-web:<env>']);
  });

  it('collects environments from release and build-web configurations', () => {
    expect(scanWorkspace(polystack()).environments).toEqual([
      'dev',
      'prod',
      'qa',
      'staging',
      'uat',
    ]);
  });

  describe('hand-written workspaces (no release target, nx:run-commands)', () => {
    function handWritten(): Tree {
      const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
      writeJson(tree, 'package.json', {
        name: '@acme/source',
        scripts: {
          'serve:web': 'nx serve web',
          'serve:web:uat': 'nx serve web -c uat',
          'build:web:prod': 'node tools/build.js web prod',
          'build:mobile:dev:android': 'node tools/build.js mobile dev android',
          'serve:webview': 'nx serve webview',
          lint: 'nx run-many -t lint',
        },
      });
      const ngTargets = {
        build: {
          executor: '@angular-devkit/build-angular:browser',
          configurations: { production: {}, uat: {}, development: {} },
        },
        serve: { executor: '@angular-devkit/build-angular:dev-server' },
      };
      writeJson(tree, 'apps/web/project.json', { name: 'web', targets: ngTargets });
      writeJson(tree, 'apps/mobile/project.json', {
        name: 'mobile',
        targets: { ...ngTargets, 'cap-sync': { executor: 'nx:run-commands' } },
      });
      tree.write('apps/mobile/capacitor.config.ts', 'export default {};');
      writeJson(tree, 'apps/flutter-app/project.json', {
        name: 'flutter-app',
        targets: {
          serve: { executor: 'nx:run-commands' },
          'build-web': { executor: 'nx:run-commands' },
        },
      });
      tree.write('apps/flutter-app/pubspec.yaml', 'name: flutter_app\n');
      writeJson(tree, 'apps/flutter-app/env/dev.json', {});
      writeJson(tree, 'apps/flutter-app/env/prod.json', {});
      return tree;
    }

    it('detects Flutter from pubspec.yaml and Ionic from capacitor.config', () => {
      const { apps } = scanWorkspace(handWritten());
      expect(apps.map((a) => [a.name, a.type])).toEqual([
        ['flutter-app', 'flutter'],
        ['mobile', 'ionic'],
        ['web', 'angular'],
      ]);
    });

    it('falls back to build configurations and Flutter env files for environments', () => {
      expect(scanWorkspace(handWritten()).environments).toEqual([
        'dev',
        'prod',
        'production',
        'uat',
      ]);
    });

    it('lists nx build / build-web commands when there is no release target', () => {
      const { apps } = scanWorkspace(handWritten());
      expect(apps[0].commands).toEqual([
        'npx nx serve flutter-app',
        'npx nx run flutter-app:build-web',
      ]);
      expect(apps[2].commands).toEqual(['npx nx serve web', 'npx nx build web -c <config>']);
    });

    it('lists the root npm scripts that belong to each app', () => {
      const ws = scanWorkspace(handWritten());
      const web = ws.apps.find((a) => a.name === 'web');
      expect(web?.scripts).toEqual(['build:web:prod', 'serve:web', 'serve:web:uat']);
      expect(ws.apps.find((a) => a.name === 'mobile')?.scripts).toEqual([
        'build:mobile:dev:android',
      ]);
      const block = renderBlock(ws);
      expect(block).toContain('### npm scripts');
      expect(block).toContain('- `web`: `build:web:prod`, `serve:web`, `serve:web:uat`');
      expect(block).not.toContain('serve:webview');
    });
  });

  it('lists libs with their type tag and the tsconfig paths alias inside their root', () => {
    expect(scanWorkspace(polystack()).libs).toEqual([
      {
        name: 'flutter-shared-core',
        type: 'flutter',
        root: 'libs/flutter/shared_core',
        aliases: [],
      },
      { name: 'shared-brand', type: undefined, root: 'libs/shared/brand', aliases: [] },
      { name: 'shared-ui', type: 'angular', root: 'libs/shared/ui', aliases: ['@acme/shared-ui'] },
      {
        name: 'shared-util',
        type: 'ts',
        root: 'libs/shared/util',
        aliases: ['@acme/shared-util'],
      },
    ]);
  });
});

describe('renderBlock', () => {
  const body = () => renderBlock(scanWorkspace(polystack()));

  it('names the plugin version and how to refresh', () => {
    expect(body()).toContain(`nx-polystack v${PLUGIN_VERSION}`);
    expect(body()).toContain('`pstack llm`');
  });

  it('renders the apps and libs tables', () => {
    const md = body();
    expect(md).toMatch(/\| `field` +\| ionic +\| `apps\/field` +\|/);
    expect(md).toMatch(
      /\| `shared-ui` +\| angular +\| `libs\/shared\/ui` +\| `@acme\/shared-ui` +\|/,
    );
    expect(md).toMatch(/\| `shared-brand` +\| — +\| `libs\/shared\/brand` +\| — +\|/);
    expect(md).toContain('`dev`, `prod`, `qa`, `staging`, `uat`');
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('is deterministic', () => {
    expect(body()).toBe(body());
  });

  it('says when there are no apps or libs yet', () => {
    const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    const md = renderBlock(scanWorkspace(tree));
    expect(md).toContain('No apps yet');
    expect(md).toContain('No libraries yet');
  });

  it.each([
    ['prettier defaults', {}],
    ['the workspace .prettierrc', { singleQuote: true, printWidth: 100, trailingComma: 'all' }],
  ])('is left unchanged by Prettier (%s)', (_name, config) => {
    for (const tree of [polystack(), createTreeWithEmptyWorkspace({ layout: 'apps-libs' })]) {
      const file = upsertBlock(null, renderBlock(scanWorkspace(tree)), target);
      expect(prettier.format(file, { ...config, parser: 'markdown' })).toBe(file);
    }
  });
});

describe('refreshLlmBlocks', () => {
  it('updates only the files that already have the markers', () => {
    const tree = polystack();
    tree.write('CLAUDE.md', `# Mine\n\n${LLM_START}\nstale\n${LLM_END}\n\nmy notes\n`);
    tree.write('AGENTS.md', '# Agents without a block\n');

    expect(refreshLlmBlocks(tree)).toEqual(['CLAUDE.md']);

    const claude = tree.read('CLAUDE.md', 'utf8') ?? '';
    expect(claude.startsWith('# Mine\n\n')).toBe(true);
    expect(claude.endsWith(`${LLM_END}\n\nmy notes\n`)).toBe(true);
    expect(claude).toContain('`shared-ui`');
    expect(tree.read('AGENTS.md', 'utf8')).toBe('# Agents without a block\n');
    expect(tree.exists('.github/copilot-instructions.md')).toBe(false);
  });

  it('changes nothing on an unchanged workspace', () => {
    const tree = polystack();
    tree.write('CLAUDE.md', `${LLM_START}\n${LLM_END}\n`);
    refreshLlmBlocks(tree);
    const once = tree.read('CLAUDE.md', 'utf8');
    expect(refreshLlmBlocks(tree)).toEqual([]);
    expect(tree.read('CLAUDE.md', 'utf8')).toBe(once);
  });

  it('skips a file with malformed markers instead of failing the generator', () => {
    const tree = polystack();
    tree.write('AGENTS.md', `${LLM_START}\nno end\n`);
    tree.write('.github/copilot-instructions.md', `${LLM_START}\n${LLM_END}\n`);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(refreshLlmBlocks(tree)).toEqual(['.github/copilot-instructions.md']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/AGENTS\.md has malformed/));
    warn.mockRestore();
    expect(tree.read('AGENTS.md', 'utf8')).toBe(`${LLM_START}\nno end\n`);
  });
});
