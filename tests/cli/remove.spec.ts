import * as fs from 'fs';
import * as path from 'path';

import { planRemoval, runRemove } from '../../src/cli/commands/remove';
import { UpgradeDeps } from '../../src/cli/commands/upgrade';
import { scriptedPrompter } from '../../src/cli/prompt';

import { makeCtx, tmpDir, writeJson } from './helpers';

/** A workspace with apps web and legacy (+ legacy-e2e), libs ui and legacy-ui. */
function workspace(): string {
  const ws = tmpDir('pstack-remove-');
  const file = (f: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), text);
  };
  writeJson(path.join(ws, 'nx.json'), {
    pstack: { envEncryption: { keys: { default: [], legacy: ['apiKey'], web: ['apiKey'] } } },
  });
  writeJson(path.join(ws, 'tsconfig.base.json'), {
    compilerOptions: {
      paths: {
        '@acme/web': ['apps/web/src'],
        '@acme/legacy': ['apps/legacy/src'],
        '@acme/ui': ['libs/ui/src/index.ts'],
        '@acme/legacy-ui': ['libs/legacy-ui/src/index.ts'],
      },
    },
  });
  writeJson(path.join(ws, 'package.json'), {
    name: 'ws',
    scripts: {
      'serve:legacy': 'nx serve legacy',
      'release:legacy:prod': 'nx run legacy:release:prod',
      'open:android': 'nx run legacy:cap-open --platform=android',
      'serve:web': 'nx serve web',
      'build:all': 'nx run legacy:build && nx run web:build',
    },
    dependencies: {
      '@angular/core': '~21.2.0',
      'chart.js': '^4.0.0',
      leaflet: '^1.9.0',
      lodash: '^4.17.0',
    },
    devDependencies: { jest: '^29.0.0' },
  });
  const release = (name: string) => ({
    executor: '@mouryaamit/nx-polystack:build',
    options: { type: 'angular', envProject: name },
  });
  writeJson(path.join(ws, 'apps/legacy/project.json'), {
    name: 'legacy',
    projectType: 'application',
    targets: {
      build: { options: { styles: ['node_modules/leaflet/dist/leaflet.css'] } },
      release: release('legacy'),
    },
  });
  file(
    'apps/legacy/src/main.ts',
    "import { Chart } from 'chart.js';\nimport { map } from 'lodash';\nimport { Ui } from '@acme/ui';\nimport { Old } from '@acme/legacy-ui';\n",
  );
  writeJson(path.join(ws, 'apps/legacy-e2e/project.json'), { name: 'legacy-e2e' });
  writeJson(path.join(ws, 'apps/web/project.json'), {
    name: 'web',
    projectType: 'application',
    targets: { release: release('web') },
  });
  file('apps/web/src/main.ts', "import { map } from 'lodash';\nimport { Ui } from '@acme/ui';\n");
  writeJson(path.join(ws, 'libs/ui/project.json'), { name: 'ui', projectType: 'library' });
  file('libs/ui/src/index.ts', 'export const Ui = 1;\n');
  writeJson(path.join(ws, 'libs/legacy-ui/project.json'), {
    name: 'legacy-ui',
    projectType: 'library',
  });
  file('libs/legacy-ui/src/index.ts', 'export const Old = 1;\n');
  file('environments/legacy/environment.ts', 'export const environment = {};\n');
  file('environments/web/environment.ts', 'export const environment = {};\n');
  file('docs/migrations/legacy.md', '# legacy\n');
  file('dist/apps/legacy/index.html', '<html></html>\n');
  file('README.md', '# ws\n\n- legacy: the old portal\n- web: the site\n');
  return ws;
}

function deps(ws: string, calls: string[], out: string[], answers?: string[]): UpgradeDeps {
  return {
    exec: (cmd, args) => void calls.push(`${cmd} ${args.join(' ')}`),
    capture: () => '',
    gitStatus: () => '',
    nodeMajor: () => 22,
    interactive: answers !== undefined,
    prompter: () => scriptedPrompter(answers ?? []),
    log: (l) => void out.push(l),
  };
}

describe('pstack remove', () => {
  it('plans what goes, what stays and what to check by hand', () => {
    const plan = planRemoval(workspace(), ['legacy']);
    expect(plan.apps).toEqual([
      expect.objectContaining({
        name: 'legacy',
        root: 'apps/legacy',
        extraDirs: ['apps/legacy-e2e', 'environments/legacy'],
        files: ['docs/migrations/legacy.md'],
        aliases: ['@acme/legacy'],
        dist: ['dist/apps/legacy'],
      }),
    ]);
    expect(Object.keys(plan.scripts).sort()).toEqual([
      'open:android',
      'release:legacy:prod',
      'serve:legacy',
    ]);
    expect(plan.sharedScripts).toEqual(['build:all']);
    expect(plan.packages.map((p) => p.name)).toEqual(['chart.js', 'leaflet']);
    expect(plan.keptPackages).toEqual([
      { name: 'lodash', why: 'also named in apps/web/src/main.ts' },
    ]);
    expect(plan.libsOnlyHere).toEqual(['legacy-ui']);
    expect(plan.dependents).toEqual([]);
    expect(plan.mentions).toEqual(['README.md:3: - legacy: the old portal']);
  });

  it('removes the app in one commit after a retired/<app> tag; libs stay', async () => {
    const ws = workspace();
    const calls: string[] = [];
    const out: string[] = [];
    expect(
      await runRemove(
        makeCtx({ cwd: ws, positionals: [], flags: { app: 'legacy', yes: true } }),
        deps(ws, calls, out),
      ),
    ).toBe(0);
    for (const gone of [
      'apps/legacy',
      'apps/legacy-e2e',
      'environments/legacy',
      'docs/migrations/legacy.md',
      'dist/apps/legacy',
    ]) {
      expect(fs.existsSync(path.join(ws, gone))).toBe(false);
    }
    for (const kept of ['apps/web', 'libs/ui', 'libs/legacy-ui', 'environments/web']) {
      expect(fs.existsSync(path.join(ws, kept))).toBe(true);
    }
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ws, f), 'utf8'));
    expect(read('tsconfig.base.json').compilerOptions.paths['@acme/legacy']).toBeUndefined();
    expect(read('tsconfig.base.json').compilerOptions.paths['@acme/legacy-ui']).toBeDefined();
    expect(Object.keys(read('package.json').scripts).sort()).toEqual(['build:all', 'serve:web']);
    expect(read('nx.json').pstack.envEncryption.keys).toEqual({ default: [], web: ['apiKey'] });
    expect(calls).toEqual([
      'git tag retired/legacy',
      'npm uninstall chart.js leaflet',
      'git add -A',
      expect.stringMatching(/^git commit -m chore: remove app legacy \(pstack remove\) -m /),
    ]);
    expect(calls[3]).toContain('The app is at tag retired/legacy.');
  });

  it('--dry-run changes nothing', async () => {
    const ws = workspace();
    const calls: string[] = [];
    const out: string[] = [];
    await runRemove(
      makeCtx({ cwd: ws, positionals: [], flags: { app: 'legacy' }, dryRun: true }),
      deps(ws, calls, out),
    );
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(ws, 'apps/legacy'))).toBe(true);
    expect(out).toContain('Remove app legacy:');
    expect(out).toContain('  chart.js (only legacy use it)');
  });

  it('refuses when another project depends on the app, unless --force', async () => {
    const ws = workspace();
    fs.appendFileSync(path.join(ws, 'apps/web/src/main.ts'), "import { X } from '@acme/legacy';\n");
    const calls: string[] = [];
    const out: string[] = [];
    await expect(
      runRemove(
        makeCtx({ cwd: ws, positionals: [], flags: { app: 'legacy', yes: true } }),
        deps(ws, calls, out),
      ),
    ).rejects.toThrow('other projects depend on these apps');
    expect(out.join('\n')).toContain('web → legacy (imports it in apps/web/src/main.ts)');
    expect(calls).toEqual([]);
    await runRemove(
      makeCtx({ cwd: ws, positionals: [], flags: { app: 'legacy', yes: true, force: true } }),
      deps(ws, calls, out),
    );
    expect(fs.existsSync(path.join(ws, 'apps/legacy'))).toBe(false);
  });

  it('asks in a terminal; anything but yes removes nothing; needs --yes elsewhere', async () => {
    const ws = workspace();
    const calls: string[] = [];
    const out: string[] = [];
    expect(
      await runRemove(
        makeCtx({ cwd: ws, positionals: [], flags: { app: 'legacy' } }),
        deps(ws, calls, out, ['no']),
      ),
    ).toBe(1);
    expect(calls).toEqual([]);
    await expect(
      runRemove(
        makeCtx({ cwd: ws, positionals: [], flags: { app: 'legacy' } }),
        deps(ws, calls, out),
      ),
    ).rejects.toThrow('pass --yes');
  });

  it('refuses unknown names, libraries and a dirty tree', async () => {
    const ws = workspace();
    expect(() => planRemoval(ws, ['nope'])).toThrow(
      'no app named "nope". Apps: legacy, legacy-e2e, web',
    );
    expect(() => planRemoval(ws, ['ui'])).toThrow('ui: not an app');
    const d = deps(ws, [], []);
    d.gitStatus = () => ' M README.md\n';
    await expect(
      runRemove(makeCtx({ cwd: ws, positionals: [], flags: { app: 'legacy', yes: true } }), d),
    ).rejects.toThrow('commit or stash your changes first');
  });
});
