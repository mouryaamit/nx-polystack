import * as fs from 'fs';
import * as path from 'path';

import { logger } from '@nx/devkit';

import { runAdopt } from '../../src/cli/commands/adopt';

import { makeCtx, tmpDir, writeJson } from './helpers';

const BUILD_JS = `// tools/scripts/build.js
const { getBuildInfo } = require('./build-info');
const BASE_HREF = {
  portal: { uat: '/portal/', prod: '/portal/' },
  admin: { uat: '/adm/', prod: '/adm/' },
};
function buildOne(project) {
  run(\`npx nx build \${project} --configuration=\${CONFIGS[env]} --base-href \${baseHref}\`);
  run(\`node tools/scripts/inject-nonce.js \${project}\`);
  if (env === 'prod' || env === 'uat') {
    run(\`node tools/scripts/strip-comments.js \${dist}\`);
    run(\`node tools/scripts/obfuscate.js \${dist}\`);
  }
}
`;

const INJECT_NONCE_JS = `const NONCE = "<!--#echo var='UNIQUE_ID' -->";
let html = fs.readFileSync(distPath, 'utf8');
html = html.replace(/<!--(?!#)[\\s\\S]*?-->/g, '');
html = html.replace(/<script(?![^>]*\\bsrc=)(?![^>]*\\bnonce=)([^>]*)>/gi, \`<script nonce="\${NONCE}"$1>\`);
html = html.replace(/<link(?![^>]*\\bnonce=)([^>]*)>/gi, \`<link nonce="\${NONCE}"$1>\`);
html = html.replace(/random-csp-nonce/g, NONCE);
`;

const ENCRYPT_ENV_JS = `const PUBLIC_ENV_KEYS = ['production', 'envName'];
const ENC_OPEN = 'ENC(';
`;

function app(ws: string, name: string): void {
  writeJson(path.join(ws, 'apps', name, 'project.json'), {
    name,
    projectType: 'application',
    sourceRoot: `apps/${name}/src`,
    targets: {
      build: {
        executor: '@angular-devkit/build-angular:browser',
        options: {
          outputPath: `dist/apps/${name}`,
          main: `apps/${name}/src/main.ts`,
          assets: [
            `apps/${name}/src/favicon.ico`,
            { glob: '.htaccess', input: `apps/${name}/src/`, output: './' },
          ],
        },
        configurations: Object.fromEntries(
          [
            ['production', 'prod'],
            ['uat', 'uat'],
            ['development', 'dev'],
          ].map(([cfg, env]) => [
            cfg,
            {
              fileReplacements: [
                {
                  replace: 'environments/environment.ts',
                  with: `environments/${name}/environment.${env}.ts`,
                },
              ],
            },
          ]),
        ),
      },
      serve: { executor: '@angular-devkit/build-angular:dev-server' },
    },
  });
  fs.writeFileSync(path.join(ws, 'apps', name, 'src', '.htaccess'), `# ${name} rules\n`);
  for (const env of ['dev', 'uat', 'prod']) {
    fs.mkdirSync(path.join(ws, 'environments', name), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'environments', name, `environment.${env}.ts`),
      `export const environment = { production: ${
        env === 'prod'
      }, envName: '${env}', apiUrl: 'x' };\n`,
    );
  }
}

/** A workspace laid out like one that builds through its own tools/scripts/build.js. */
function workspace(): string {
  const ws = tmpDir();
  writeJson(path.join(ws, 'nx.json'), { npmScope: 'acme' });
  const scripts: Record<string, string> = {
    'build:all:prod': 'node tools/scripts/build-all.js prod',
    lint: 'eslint .',
    'validate:imports': 'node tools/scripts/validate-imports.js',
  };
  for (const a of ['admin', 'portal']) {
    for (const env of ['dev', 'uat', 'prod']) {
      scripts[`build:${a}:${env}`] = `node tools/scripts/build.js --project=${a} --env=${env}`;
    }
  }
  // One package per line, the way the repo keeps it: adopt must not reformat the file.
  const pkg =
    '{\n  "name": "@acme/source",\n  "scripts": {\n' +
    Object.entries(scripts)
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(',\n') +
    '\n  },\n  "overrides": {\n    "a": { "x": "1" },\n    "b": { "y": "2" }\n  }\n}\n';
  fs.writeFileSync(path.join(ws, 'package.json'), pkg);
  fs.mkdirSync(path.join(ws, 'tools', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'tools/scripts/build.js'), BUILD_JS);
  fs.writeFileSync(path.join(ws, 'tools/scripts/inject-nonce.js'), INJECT_NONCE_JS);
  fs.writeFileSync(path.join(ws, 'tools/scripts/encrypt-env.js'), ENCRYPT_ENV_JS);
  fs.writeFileSync(
    path.join(ws, 'tools/scripts/obfuscate.js'),
    [
      "const OPTIONS = { identifierNamesGenerator: 'hexadecimal', stringArray: true, stringArrayThreshold: 0.75 };",
      'const PROFILES = {',
      '  light: { stringArrayEncoding: [], stringArrayWrappersCount: 0 },',
      "  full: { stringArrayEncoding: ['base64'], stringArrayWrappersCount: 1 },",
      '};',
      "const profile = process.env.OBFUSCATE_PROFILE || 'light';",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(ws, 'tools/scripts/build-info.js'),
    "const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata' });\n",
  );
  fs.writeFileSync(path.join(ws, 'tools/scripts/strip-comments.js'), '// strip\n');
  fs.writeFileSync(
    path.join(ws, 'tools/scripts/build-all.js'),
    "spawnSync(npm, ['run', `build:${app}:${env}`]);\n" +
      "spawnSync(process.execPath, [path.join('tools', 'scripts', 'timestamp.js'), '--restore']);\n",
  );
  fs.writeFileSync(path.join(ws, 'tools/scripts/timestamp.js'), "require('./build-info');\n");
  fs.writeFileSync(path.join(ws, 'tools/scripts/validate-imports.js'), "require('./ts-helper');\n");
  fs.writeFileSync(path.join(ws, 'tools/scripts/ts-helper.js'), '// helper\n');
  fs.writeFileSync(path.join(ws, 'tools/scripts/csp-patch.js'), '// not started by anything\n');
  fs.mkdirSync(path.join(ws, 'apps', 'admin', 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'apps', 'portal', 'src'), { recursive: true });
  app(ws, 'admin');
  app(ws, 'portal');
  return ws;
}

const readJsonFile = (ws: string, rel: string) =>
  JSON.parse(fs.readFileSync(path.join(ws, rel), 'utf8'));

describe('pstack adopt', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('gives apps on their own build script the release target, env htaccess files and scripts', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));

    const pj = readJsonFile(ws, 'apps/portal/project.json');
    const release = pj.targets.release;
    expect(release.executor).toBe('@mouryaamit/nx-polystack:build');
    expect(release.options).toMatchObject({
      type: 'angular',
      envProject: 'portal',
      outputPath: 'dist/apps/portal',
      secure: true,
      stripHtmlComments: true,
      nonce: {
        placeholder: "<!--#echo var='UNIQUE_ID' -->",
        tags: 'legacy',
        position: 'after-tag-name',
        replaceTokens: ['random-csp-nonce'],
        addMeta: false,
      },
    });
    expect(release.configurations.uat).toMatchObject({
      baseHref: '/portal/',
      obfuscate: 'medium',
      obfuscateOptions: { stringArrayWrappersCount: 0 },
      stripComments: true,
    });
    expect(release.configurations.uat.dropConsole).toBeUndefined();
    expect(release.configurations.prod.baseHref).toBe('/portal/');
    expect(release.configurations.dev.baseHref).toBeUndefined();
    expect(release.configurations.dev.obfuscate).toBeUndefined();
    expect(
      readJsonFile(ws, 'apps/admin/project.json').targets.release.configurations.prod.baseHref,
    ).toBe('/adm/');

    // .htaccess: one file per env, out of the build assets.
    for (const env of ['dev', 'uat', 'prod']) {
      expect(fs.readFileSync(path.join(ws, `environments/portal/htaccess.${env}`), 'utf8')).toBe(
        '# portal rules\n',
      );
    }
    expect(fs.existsSync(path.join(ws, 'apps/portal/src/.htaccess'))).toBe(false);
    expect(pj.targets.build.options.assets).toEqual(['apps/portal/src/favicon.ico']);

    // Env encryption mirrored from tools/scripts/encrypt-env.js.
    const nx = readJsonFile(ws, 'nx.json');
    expect(nx.pstack.envEncryption.stamp.timezone).toBe('Asia/Kolkata');
    expect(nx.pstack.envEncryption).toMatchObject({
      mode: 'all',
      format: 'enc',
      publicKeys: ['production', 'envName'],
    });

    // npm scripts point at the release target; nothing else in package.json moved.
    const text = fs.readFileSync(path.join(ws, 'package.json'), 'utf8');
    const pkg = JSON.parse(text);
    expect(pkg.scripts['build:portal:uat']).toBe('nx run portal:release:uat');
    expect(pkg.scripts['build:portal:prod:secure']).toBe('nx run portal:release:prod --secure');
    expect(pkg.scripts['build:admin:prod:secure:sri']).toBe(
      'nx run admin:release:prod --secure --sri',
    );
    expect(pkg.scripts['build:all:prod']).toBe('nx run-many -t release -c prod');
    expect(text).toContain('    "a": { "x": "1" },\n    "b": { "y": "2" }');
    expect(Object.keys(pkg.scripts).indexOf('build:admin:prod:secure')).toBe(
      Object.keys(pkg.scripts).indexOf('build:admin:prod') + 1,
    );

    // Old scripts kept; report written.
    expect(fs.existsSync(path.join(ws, 'tools/scripts/build.js'))).toBe(true);
    const report = fs.readFileSync(path.join(ws, 'docs/migrations/adopt.md'), 'utf8');
    expect(report).toContain('Apps moved to the polystack `release` target: `admin`, `portal`.');
    expect(report).toContain('compare');
  });

  it('writes release options the build executor schema accepts', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    const schema = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../src/executors/build/schema.json'), 'utf8'),
    ).properties as Record<string, { type?: string; enum?: unknown[] }>;
    const release = readJsonFile(ws, 'apps/portal/project.json').targets.release;
    const typeOf = (v: unknown) => (Array.isArray(v) ? 'array' : typeof v);
    for (const opts of [release.options, ...Object.values(release.configurations)] as Record<
      string,
      unknown
    >[]) {
      for (const [key, value] of Object.entries(opts)) {
        const prop = schema[key];
        expect({ key, known: prop !== undefined }).toEqual({ key, known: true });
        if (prop.type && prop.type !== 'number') {
          expect({ key, type: typeOf(value) }).toEqual({ key, type: prop.type });
        }
        if (prop.enum) expect(prop.enum).toContain(value);
      }
    }
  });

  it('keeps the layout of the project.json it edits', async () => {
    const ws = workspace();
    const file = path.join(ws, 'apps/admin/project.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const assets = json.targets.build.options.assets;
    json.targets.build.options.assets = '__ASSETS__';
    fs.writeFileSync(
      file,
      JSON.stringify(json, null, 2).replace(
        '"__ASSETS__"',
        `[\n          ${assets
          .map((a: unknown) => JSON.stringify(a).replace(/,/g, ', '))
          .join(',\n          ')}\n        ]`,
      ),
    );
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('"assets": [\n          "apps/admin/src/favicon.ico"\n        ]');
    expect(text).toContain(
      '\n    "release": {\n      "executor": "@mouryaamit/nx-polystack:build",',
    );
    expect(JSON.parse(text).targets.release.configurations.prod.baseHref).toBe('/adm/');
  });

  it('removes the old build scripts nothing uses, with the apps or later on its own', async () => {
    const old = [
      'build-all.js',
      'build-info.js',
      'build.js',
      'inject-nonce.js',
      'obfuscate.js',
      'strip-comments.js',
      'timestamp.js',
    ].map((f) => `tools/scripts/${f}`);
    const kept = ['validate-imports.js', 'ts-helper.js', 'encrypt-env.js', 'csp-patch.js'];

    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: { removeOldScripts: true } }));
    for (const f of old)
      expect({ f, exists: fs.existsSync(path.join(ws, f)) }).toEqual({ f, exists: false });
    for (const f of kept) expect(fs.existsSync(path.join(ws, 'tools/scripts', f))).toBe(true);
    const report = fs.readFileSync(path.join(ws, 'docs/migrations/adopt.md'), 'utf8');
    expect(report).toContain('Removed (nothing uses them any more): `tools/scripts/build-all.js`');
    expect(report).toContain('`tools/scripts/csp-patch.js`, `tools/scripts/encrypt-env.js`');

    const later = workspace();
    await runAdopt(makeCtx({ cwd: later, flags: {} }));
    expect(fs.existsSync(path.join(later, 'tools/scripts/build.js'))).toBe(true);
    await runAdopt(makeCtx({ cwd: later, flags: { removeOldScripts: true } }));
    for (const f of old) expect(fs.existsSync(path.join(later, f))).toBe(false);
    // A later run with nothing left refreshes the section instead of keeping the old list.
    await runAdopt(makeCtx({ cwd: later, flags: { removeOldScripts: true } }));
    const again = fs.readFileSync(path.join(later, 'docs/migrations/adopt.md'), 'utf8');
    expect(again).toContain('Nothing starts these, but they are not part of the old build');
    expect(again).not.toContain('Removed (nothing uses them any more)');
    expect(fs.existsSync(path.join(later, 'tools/scripts/csp-patch.js'))).toBe(true);
    expect(fs.readFileSync(path.join(later, 'docs/migrations/adopt.md'), 'utf8')).toContain(
      'Apps moved to the polystack `release` target',
    );
  });

  it('--remove-old-scripts also removes or rewrites what still names the removed scripts', async () => {
    const ws = workspace();
    const file = (f: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
      fs.writeFileSync(path.join(ws, f), text);
    };
    const read = (f: string) => fs.readFileSync(path.join(ws, f), 'utf8');
    file('.prettierignore', 'dist\ntools/scripts/build.js\n/coverage\n');
    file('knip.json', '{\n  "ignore": ["tools/scripts/obfuscate.js", "tools/other/**"]\n}\n');
    file(
      'apps/portal/src/main.ts',
      "// Built by tools/scripts/build.js (see there for the nonce).\nimport './app';\n" +
        'const x = 1; // stamped by ./tools/scripts/timestamp.js\n/**\n * Old: tools/scripts/inject-nonce.js\n * Keeps this.\n */\nexport { x };\n',
    );
    file(
      'README.md',
      '# App\n\nBuild with `node tools/scripts/build.js --app=portal --env=prod`.\n\n' +
        '```bash\nnode tools/scripts/build.js --app=portal --env=uat\n```\n\n' +
        'The nonce is set by tools/scripts/inject-nonce.js.\n',
    );
    file('CHANGELOG.md', '# Changes\n\n- added tools/scripts/build.js\n');
    file('apps/portal/src/index.html', '<!-- tools/scripts/inject-nonce.js fills this -->\n');

    await runAdopt(makeCtx({ cwd: ws, flags: { removeOldScripts: true } }));

    expect(read('.prettierignore')).toBe('dist\n/coverage\n');
    expect(JSON.parse(read('knip.json'))).toEqual({ ignore: ['tools/other/**'] });
    expect(read('apps/portal/src/main.ts')).toBe(
      "import './app';\nconst x = 1;\n/**\n * Keeps this.\n */\nexport { x };\n",
    );
    expect(read('README.md')).toBe(
      '# App\n\nBuild with `nx run <app>:release:<env>`.\n\n' +
        '```bash\nnpx nx run <app>:release:<env>\n```\n\n' +
        'The nonce is set by the release target (`nx run <app>:release:<env>`).\n',
    );
    // History and HTML comments are left; the HTML mention is reported.
    expect(read('CHANGELOG.md')).toContain('tools/scripts/build.js');
    expect(read('apps/portal/src/index.html')).toContain('inject-nonce.js');
    const report = read('docs/migrations/adopt.md');
    expect(report).toContain('References to them that were removed or rewritten:');
    expect(report).toContain('`.prettierignore:2`: entry removed');
    expect(report).toContain('`apps/portal/src/main.ts:1`: comment line removed');
    expect(report).toContain('Still named here (not edited): `apps/portal/src/index.html:1`.');
    // The report still records what was removed.
    expect(report).toContain('`tools/scripts/build.js`');
  });

  it('moves build:all to nx run-many in a workspace adopted app by app, then removes its script', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: { app: 'admin,portal' } }));
    expect(readJsonFile(ws, 'package.json').scripts['build:all:prod']).toBe(
      'node tools/scripts/build-all.js prod',
    );
    await runAdopt(makeCtx({ cwd: ws, flags: { removeOldScripts: true } }));
    const text = fs.readFileSync(path.join(ws, 'package.json'), 'utf8');
    expect(JSON.parse(text).scripts['build:all:prod']).toBe('nx run-many -t release -c prod');
    expect(text).toContain('    "a": { "x": "1" },\n    "b": { "y": "2" }');
    for (const f of ['build-all.js', 'timestamp.js', 'build-info.js', 'build.js'])
      expect({ f, exists: fs.existsSync(path.join(ws, 'tools/scripts', f)) }).toEqual({
        f,
        exists: false,
      });
    expect(fs.existsSync(path.join(ws, 'tools/scripts/validate-imports.js'))).toBe(true);
    const report = fs.readFileSync(path.join(ws, 'docs/migrations/adopt.md'), 'utf8');
    expect(report).toContain('- `build:all:prod`: `nx run-many -t release -c prod`');
  });

  it('keeps a tools/ script an app imports at runtime, and does not list it as unused', async () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, 'tools/scripts/nonce-patch.js'), '// runtime patch\n');
    fs.writeFileSync(
      path.join(ws, 'apps/admin/src/main.ts'),
      "import '../../../tools/scripts/nonce-patch';\n",
    );
    const result = await runAdopt(makeCtx({ cwd: ws, flags: { removeOldScripts: true } }));
    expect(result).toBe(0);
    expect(fs.existsSync(path.join(ws, 'tools/scripts/nonce-patch.js'))).toBe(true);
    const report = fs.readFileSync(path.join(ws, 'docs/migrations/adopt.md'), 'utf8');
    expect(report).not.toContain('nonce-patch');
  });

  it('writes the report where --report says, saves it in nx.json and moves an earlier one', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: { app: 'admin' } }));
    expect(fs.existsSync(path.join(ws, 'docs/migrations/adopt.md'))).toBe(true);
    const nxBefore = fs.readFileSync(path.join(ws, 'nx.json'), 'utf8');

    await runAdopt(makeCtx({ cwd: ws, flags: { report: '.ai-context/context/modules/misc/' } }));
    const file = path.join(ws, '.ai-context/context/modules/misc/pstack-adopt.md');
    expect(fs.existsSync(path.join(ws, 'docs/migrations/adopt.md'))).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toContain('`portal`');
    const nx = JSON.parse(fs.readFileSync(path.join(ws, 'nx.json'), 'utf8'));
    expect(nx.pstack.adopt.report).toBe('.ai-context/context/modules/misc/pstack-adopt.md');
    expect(nx.npmScope).toBe(JSON.parse(nxBefore).npmScope);

    // Later runs use the saved path.
    await runAdopt(makeCtx({ cwd: ws, flags: { removeOldScripts: true } }));
    expect(fs.existsSync(path.join(ws, 'docs/migrations/adopt.md'))).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toContain('## Old scripts');
  });

  it('writes no report with --no-report, and refuses a path outside the workspace', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: { noReport: true } }));
    expect(fs.existsSync(path.join(ws, 'docs/migrations/adopt.md'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(ws, 'nx.json'), 'utf8')).pstack.adopt.report).toBe(
      false,
    );
    await expect(
      runAdopt(makeCtx({ cwd: workspace(), flags: { report: '../elsewhere.md' } })),
    ).rejects.toThrow(/inside the workspace/);
    await expect(runAdopt(makeCtx({ cwd: workspace(), flags: { report: true } }))).rejects.toThrow(
      /needs a path/,
    );
  });

  it('says none are left when a later --remove-old-scripts finds nothing', async () => {
    const ws = workspace();
    for (const f of ['csp-patch.js', 'encrypt-env.js'])
      fs.rmSync(path.join(ws, 'tools/scripts', f));
    await runAdopt(makeCtx({ cwd: ws, flags: { removeOldScripts: true } }));
    await runAdopt(makeCtx({ cwd: ws, flags: { removeOldScripts: true } }));
    const report = fs.readFileSync(path.join(ws, 'docs/migrations/adopt.md'), 'utf8');
    expect(report).toContain('None left: no old build script is still in the workspace.');
    expect(report).not.toContain('Removed (nothing uses them any more)');
  });

  it('pins @nx/devkit to the installed nx, keeping the package.json layout', async () => {
    const ws = workspace();
    writeJson(path.join(ws, 'node_modules/nx/package.json'), { name: 'nx', version: '17.0.6' });
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    const text = fs.readFileSync(path.join(ws, 'package.json'), 'utf8');
    expect(JSON.parse(text).devDependencies).toEqual({ '@nx/devkit': '17.0.6' });
    expect(text).toContain('    "a": { "x": "1" },\n    "b": { "y": "2" }');
    expect(fs.readFileSync(path.join(ws, 'docs/migrations/adopt.md'), 'utf8')).toContain(
      '`@nx/devkit` pinned to 17.0.6',
    );
  });

  it('adopts only the named apps, and leaves the scripts with --no-scripts', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: { app: 'admin', noScripts: true } }));
    expect(readJsonFile(ws, 'apps/admin/project.json').targets.release).toBeDefined();
    expect(readJsonFile(ws, 'apps/portal/project.json').targets.release).toBeUndefined();
    expect(readJsonFile(ws, 'package.json').scripts['build:admin:uat']).toBe(
      'node tools/scripts/build.js --project=admin --env=uat',
    );
  });

  it('refuses an app that is not a candidate, and does nothing a second time', async () => {
    const ws = workspace();
    await expect(runAdopt(makeCtx({ cwd: ws, flags: { app: 'nope' } }))).rejects.toThrow(
      '"nope" is not an app that builds without the plugin (candidates: admin, portal)',
    );
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    const before = fs.readFileSync(path.join(ws, 'apps/portal/project.json'), 'utf8');
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    expect(fs.readFileSync(path.join(ws, 'apps/portal/project.json'), 'utf8')).toBe(before);
  });

  it('moves the .htaccess of an app already on the plugin whose build still copies it', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    // A new app made by copying an adopted app's project.json, with its own .htaccess asset.
    const pj = readJsonFile(ws, 'apps/portal/project.json');
    const text = JSON.stringify(pj, null, 2)
      .replace(/portal/g, 'fresh')
      .replace(
        '"apps/fresh/src/favicon.ico"',
        '"apps/fresh/src/favicon.ico",\n          { "glob": ".htaccess", "input": "apps/fresh/src/", "output": "./" }',
      );
    fs.mkdirSync(path.join(ws, 'apps/fresh/src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'apps/fresh/project.json'), `${text}\n`);
    fs.writeFileSync(path.join(ws, 'apps/fresh/src/.htaccess'), '# fresh rules\n');
    const portalBefore = fs.readFileSync(path.join(ws, 'apps/portal/project.json'), 'utf8');
    const adminBefore = fs.readFileSync(path.join(ws, 'apps/admin/project.json'), 'utf8');

    await runAdopt(makeCtx({ cwd: ws, flags: {} }));

    for (const env of ['dev', 'uat', 'prod']) {
      expect(fs.readFileSync(path.join(ws, `environments/fresh/htaccess.${env}`), 'utf8')).toBe(
        '# fresh rules\n',
      );
    }
    expect(fs.existsSync(path.join(ws, 'apps/fresh/src/.htaccess'))).toBe(false);
    const fresh = readJsonFile(ws, 'apps/fresh/project.json');
    expect(fresh.targets.build.options.assets).toEqual(['apps/fresh/src/favicon.ico']);
    expect(fresh.targets.release.options.htaccess).toBeUndefined();
    // Only the asset entry left the file: the release target is not written a second time.
    const freshText = fs.readFileSync(path.join(ws, 'apps/fresh/project.json'), 'utf8');
    expect(freshText.match(/"release":/g)).toHaveLength(1);
    expect(freshText).toBe(`${text.replace(/,\n\s*\{ "glob": "\.htaccess"[^}]*\}/, '')}\n`);
    expect(fs.readFileSync(path.join(ws, 'apps/portal/project.json'), 'utf8')).toBe(portalBefore);
    expect(fs.readFileSync(path.join(ws, 'apps/admin/project.json'), 'utf8')).toBe(adminBefore);
    expect(jest.mocked(logger.info).mock.calls.flat().join('\n')).toContain('adopt: fresh:');

    // A second run changes nothing.
    jest.mocked(logger.info).mockClear();
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    expect(fs.readFileSync(path.join(ws, 'apps/fresh/project.json'), 'utf8')).toBe(freshText);
    expect(fs.readFileSync(path.join(ws, 'environments/fresh/htaccess.dev'), 'utf8')).toBe(
      '# fresh rules\n',
    );
    expect(jest.mocked(logger.info).mock.calls.flat().join('\n')).toContain('nothing to do');
  });

  it('leaves apps with htaccess: false alone, and finds a .htaccess copied by a configuration only', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: {} }));
    const add = (app: string, edit: (pj: ReturnType<typeof readJsonFile>) => void) => {
      const file = path.join(ws, `apps/${app}/project.json`);
      const pj = JSON.parse(fs.readFileSync(file, 'utf8'));
      edit(pj);
      fs.writeFileSync(file, `${JSON.stringify(pj, null, 2)}\n`);
      fs.mkdirSync(path.join(ws, `apps/${app}/src`), { recursive: true });
      fs.writeFileSync(path.join(ws, `apps/${app}/src/.htaccess`), `# ${app} again\n`);
      return file;
    };
    const asset = (app: string) => ({ glob: '.htaccess', input: `apps/${app}/src/`, output: './' });
    // portal: release builds make no .htaccess on purpose; its build copies one itself.
    const portal = add('portal', (pj) => {
      pj.targets.release.options.htaccess = false;
      pj.targets.build.options.assets.push(asset('portal'));
    });
    const portalBefore = fs.readFileSync(portal, 'utf8');
    // admin: only the production configuration copies it.
    add('admin', (pj) => {
      pj.targets.build.configurations.production.assets = [asset('admin')];
    });
    for (const env of ['dev', 'uat', 'prod']) {
      fs.rmSync(path.join(ws, `environments/admin/htaccess.${env}`), { force: true });
    }

    await runAdopt(makeCtx({ cwd: ws, flags: {} }));

    expect(fs.readFileSync(portal, 'utf8')).toBe(portalBefore);
    expect(fs.existsSync(path.join(ws, 'apps/portal/src/.htaccess'))).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'environments/admin/htaccess.prod'), 'utf8')).toBe(
      '# admin again\n',
    );
    expect(
      readJsonFile(ws, 'apps/admin/project.json').targets.build.configurations.production.assets,
    ).toEqual([]);
  });

  it('--app names an app already on the plugin that still copies its .htaccess', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: { app: 'admin' } }));
    const pjPath = path.join(ws, 'apps/admin/project.json');
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    pj.targets.build.options.assets.push({
      glob: '.htaccess',
      input: 'apps/admin/src/',
      output: './',
    });
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2));
    fs.mkdirSync(path.join(ws, 'apps/admin/src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'apps/admin/src/.htaccess'), '# admin v2\n');
    fs.rmSync(path.join(ws, 'environments/admin/htaccess.uat'));

    await runAdopt(makeCtx({ cwd: ws, flags: { app: 'admin' } }));

    // Existing env files are kept; the missing one is written from the app's .htaccess.
    expect(fs.readFileSync(path.join(ws, 'environments/admin/htaccess.uat'), 'utf8')).toBe(
      '# admin v2\n',
    );
    expect(fs.readFileSync(path.join(ws, 'environments/admin/htaccess.prod'), 'utf8')).toBe(
      '# admin rules\n',
    );
    expect(fs.existsSync(path.join(ws, 'apps/admin/src/.htaccess'))).toBe(false);
    // portal was not named: not adopted.
    expect(readJsonFile(ws, 'apps/portal/project.json').targets.release).toBeUndefined();
  });

  it('--dry-run writes nothing', async () => {
    const ws = workspace();
    await runAdopt(makeCtx({ cwd: ws, flags: {}, dryRun: true }));
    expect(readJsonFile(ws, 'apps/portal/project.json').targets.release).toBeUndefined();
    expect(fs.existsSync(path.join(ws, 'apps/portal/src/.htaccess'))).toBe(true);
  });
});
