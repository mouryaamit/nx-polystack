import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import adoptGenerator from '../../src/generators/adopt/generator';
import { classifyToolScript, replaceToolScripts } from '../../src/lib/old-scripts/tool-scripts';

// Generic workspace scripts, named so the name says nothing about what they do.
const CLEAN_IMAGES = `const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const DIRS = ['apps/web/src/assets', 'libs/shared/assets'];
const check = process.argv.includes('--check');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
(async () => {
  for (const file of DIRS.flatMap(walk).filter((f) => /\\.(jpe?g|png|webp)$/i.test(f))) {
    const meta = await sharp(file).metadata();
    if (!meta.exif) continue;
    if (check) { console.log('EXIF:', file); process.exitCode = 1; continue; }
    fs.writeFileSync(file, await sharp(file).rotate().toBuffer()); // strip EXIF metadata
  }
})();
`;
const THUMBS = CLEAN_IMAGES.replace('.rotate()', '.rotate().resize(200)');
const CHECK = `const { execSync } = require('child_process');
const fs = require('fs');
const angularOnly = process.argv.includes('--angular');
for (const app of fs.readdirSync('apps')) {
  const tsconfig = \`apps/\${app}/tsconfig.app.json\`;
  if (!fs.existsSync(tsconfig)) continue;
  execSync(\`npx tsc -p \${tsconfig} --noEmit\`, { stdio: 'inherit' });
}
`;
const VERIFY = `${CHECK}
for (const file of ['apps/web/src/main.ts']) {
  const text = require('fs').readFileSync(file, 'utf8');
  if (/import .* from '\\.\\.\\/\\.\\.\\/libs/.test(text)) throw new Error('deep import in ' + file);
}
`;

function workspace(tree: Tree): void {
  const ng = (root: string, name: string, extra: Record<string, unknown> = {}) => {
    tree.write(
      `${root}/project.json`,
      JSON.stringify({
        name,
        projectType: 'application',
        tags: ['type:app'],
        targets: {
          build: {
            executor: '@angular-devkit/build-angular:browser',
            options: { assets: [`${root}/src/assets`, ...((extra['assets'] as string[]) ?? [])] },
          },
          release: {
            executor: '@mouryaamit/nx-polystack:build',
            options: { buildTarget: `${name}:build` },
          },
          typecheck: {
            executor: 'nx:run-commands',
            options: { command: `tsc --noEmit -p ${root}/tsconfig.app.json` },
          },
        },
      }),
    );
    tree.write(`${root}/tsconfig.app.json`, '{ "extends": "./tsconfig.json" }');
    tree.write(`${root}/tsconfig.json`, '{ "angularCompilerOptions": {} }');
    tree.write(`${root}/src/assets/logo.png`, 'png');
  };
  ng('apps/web', 'web', { assets: ['libs/shared/assets'] });
  ng('apps/mobile', 'mobile');
  tree.write(
    'libs/shared/assets/project.json',
    JSON.stringify({ name: 'shared-assets', tags: ['type:assets'] }),
  );
  tree.write('libs/shared/assets/bg.jpg', 'jpg');
  tree.write(
    'libs/util/project.json',
    JSON.stringify({ name: 'util', projectType: 'library', targets: {} }),
  );
  tree.write('libs/util/tsconfig.lib.json', '{}');
  tree.write('tools/scripts/clean-images.js', CLEAN_IMAGES);
  tree.write('tools/scripts/thumbs.js', THUMBS);
  tree.write('tools/scripts/check.js', CHECK);
  tree.write('tools/scripts/verify.js', VERIFY);
  tree.write(
    'package.json',
    JSON.stringify(
      {
        name: 'ws',
        scripts: {
          'assets:strip-exif': 'node tools/scripts/clean-images.js',
          'images:check': 'node tools/scripts/clean-images.js --check',
          thumbs: 'node tools/scripts/thumbs.js',
          'validate:imports': 'node tools/scripts/check.js',
          'validate:imports:angular': 'node tools/scripts/check.js --angular',
          'lint:imports': 'node tools/scripts/verify.js',
        },
        'lint-staged': { '*.{png,jpg}': ['node tools/scripts/clean-images.js'] },
      },
      null,
      2,
    ),
  );
  tree.write('.husky/pre-push', 'npm run lint\nnode tools/scripts/check.js && echo ok\n');
  tree.write(
    '.github/workflows/ci.yml',
    'jobs:\n  a:\n    steps:\n      - run: npm ci\n      - run: node ./tools/scripts/check.js\n',
  );
}

describe('adopt: workspace scripts pstack does now (NX-110, NX-111)', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    workspace(tree);
  });
  afterEach(() => jest.restoreAllMocks());

  it('tells the jobs apart by what the scripts do', () => {
    expect(classifyToolScript(tree, 'tools/scripts/clean-images.js')).toMatchObject({
      job: 'strip-exif',
      more: [],
      dirs: ['apps/web/src/assets', 'libs/shared/assets'],
      flags: ['--check'],
    });
    expect(classifyToolScript(tree, 'tools/scripts/thumbs.js')?.more).toEqual(['resizes images']);
    expect(classifyToolScript(tree, 'tools/scripts/check.js')).toMatchObject({
      job: 'typecheck',
      more: [],
      walks: ['app'],
      flags: ['--angular'],
    });
    expect(classifyToolScript(tree, 'tools/scripts/verify.js')?.more).toEqual([
      'checks import statements itself',
    ]);
    tree.write('tools/scripts/other.js', "console.log('hello');");
    expect(classifyToolScript(tree, 'tools/scripts/other.js')).toBeNull();
  });

  it('points every call at pstack; scripts that do more are left', () => {
    const out = replaceToolScripts(tree);
    const scripts = readJson(tree, 'package.json').scripts;
    expect(scripts).toEqual({
      'assets:strip-exif': 'pstack assets strip-exif --app=web',
      'images:check': 'pstack assets strip-exif --app=web --check',
      thumbs: 'node tools/scripts/thumbs.js',
      'validate:imports': 'nx run-many -t typecheck --projects=tag:type:app',
      'validate:imports:angular': 'nx run-many -t typecheck --projects=tag:type:app',
      'lint:imports': 'node tools/scripts/verify.js',
    });
    expect(readJson(tree, 'package.json')['lint-staged']).toEqual({
      '*.{png,jpg}': ['pstack assets strip-exif'],
    });
    expect(tree.read('.husky/pre-push', 'utf8')).toBe(
      'npm run lint\nnx run-many -t typecheck --projects=tag:type:app && echo ok\n',
    );
    expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain(
      '      - run: nx run-many -t typecheck --projects=tag:type:app\n',
    );
    expect(out.map((o) => [o.script, o.replaced])).toEqual([
      ['tools/scripts/check.js', true],
      ['tools/scripts/clean-images.js', true],
      ['tools/scripts/thumbs.js', false],
      ['tools/scripts/verify.js', false],
    ]);
    // Layout of package.json kept (2 spaces, same order).
    expect(tree.read('package.json', 'utf8')).toContain(
      '\n  "scripts": {\n    "assets:strip-exif"',
    );
  });

  it('--remove-old-scripts deletes the replaced scripts, keeps the others, reports both', async () => {
    await adoptGenerator(tree, { removeOldScripts: true });
    expect(tree.exists('tools/scripts/clean-images.js')).toBe(false);
    expect(tree.exists('tools/scripts/check.js')).toBe(false);
    expect(tree.exists('tools/scripts/thumbs.js')).toBe(true);
    expect(tree.exists('tools/scripts/verify.js')).toBe(true);
    const report = tree.read('docs/migrations/adopt.md', 'utf8') ?? '';
    expect(report).toContain('## Workspace scripts pstack does now');
    expect(report).toContain('- Replaced `tools/scripts/clean-images.js` (EXIF in source images):');
    expect(report).toContain(
      '- Left as they are: tools/scripts/verify.js (type checking): does more than type-check: checks import statements itself',
    );
    expect(report).toContain(
      'Removed (nothing uses them any more): `tools/scripts/check.js`, `tools/scripts/clean-images.js`.',
    );
  });

  it('docs name the new command; note folders are left and listed (NX-110)', async () => {
    tree.write(
      'README.md',
      [
        'Check images with `node tools/scripts/clean-images.js --check`.',
        'Type checks: tools/scripts/check.js.',
        '',
        '```sh',
        'node tools/scripts/clean-images.js',
        '```',
        '',
      ].join('\n'),
    );
    const note = '.ai-context/tickets/notes/T-1.md';
    tree.write(note, 'Added tools/scripts/clean-images.js.\n');
    tree.write('apps/web/.ai-context/T-2.md', 'Wrote tools/scripts/check.js.\n');
    await adoptGenerator(tree, { removeOldScripts: true });
    expect(tree.read('README.md', 'utf8')).toBe(
      [
        'Check images with `pstack assets strip-exif`.',
        // Every call of check.js now runs the same command, so the docs name it.
        'Type checks: `nx run-many -t typecheck --projects=tag:type:app`.',
        '',
        '```sh',
        'pstack assets strip-exif',
        '```',
        '',
      ].join('\n'),
    );
    expect(tree.read(note, 'utf8')).toBe('Added tools/scripts/clean-images.js.\n');
    expect(tree.read('apps/web/.ai-context/T-2.md', 'utf8')).toBe(
      'Wrote tools/scripts/check.js.\n',
    );
    const report = tree.read('docs/migrations/adopt.md', 'utf8') ?? '';
    expect(report).toContain('`README.md:1`: now names `pstack assets strip-exif`');
    expect(report).toContain(
      '`README.md:2`: now names `nx run-many -t typecheck --projects=tag:type:app`',
    );
    expect(report).toContain(
      `Not changed (historical notes): \`${note}\`, \`apps/web/.ai-context/T-2.md\`.`,
    );
  });

  it('a later run names the command an earlier report recorded', async () => {
    await adoptGenerator(tree, {});
    tree.write('docs/build.md', 'Run tools/scripts/clean-images.js first.\n');
    await adoptGenerator(tree, { removeOldScripts: true });
    expect(tree.read('docs/build.md', 'utf8')).toBe('Run `pstack assets strip-exif` first.\n');
  });

  it('without --remove-old-scripts the scripts stay; a later run removes them', async () => {
    await adoptGenerator(tree, {});
    expect(tree.exists('tools/scripts/check.js')).toBe(true);
    expect(readJson(tree, 'package.json').scripts['validate:imports']).toBe(
      'nx run-many -t typecheck --projects=tag:type:app',
    );
    await adoptGenerator(tree, { removeOldScripts: true });
    expect(tree.exists('tools/scripts/check.js')).toBe(false);
    expect(tree.exists('tools/scripts/clean-images.js')).toBe(false);
    expect(tree.exists('tools/scripts/verify.js')).toBe(true);
  });

  it('leaves a script with a call it cannot map, and its other calls', () => {
    const pkg = readJson(tree, 'package.json');
    pkg.scripts['images:some'] = 'node tools/scripts/clean-images.js --quality=80';
    tree.write('package.json', JSON.stringify(pkg, null, 2));
    const out = replaceToolScripts(tree).find((o) => o.script === 'tools/scripts/clean-images.js');
    expect(out?.replaced).toBe(false);
    expect(out?.left).toEqual([
      'package.json scripts.images:some: passes --quality=80, which pstack cannot map',
    ]);
    expect(readJson(tree, 'package.json').scripts['assets:strip-exif']).toBe(
      'node tools/scripts/clean-images.js',
    );
  });

  it('maps folders to --all, --dir and apps; dist only is left', () => {
    const exif = (dirs: string[]) => {
      tree.write(
        'tools/scripts/clean-images.js',
        CLEAN_IMAGES.replace(
          "['apps/web/src/assets', 'libs/shared/assets']",
          JSON.stringify(dirs).replace(/"/g, "'"),
        ),
      );
      replaceToolScripts(tree);
      const v = readJson(tree, 'package.json').scripts['assets:strip-exif'];
      workspace(tree);
      return v;
    };
    expect(exif(['apps/web/src/assets', 'apps/mobile/src/assets', 'libs/shared/assets'])).toBe(
      'pstack assets strip-exif --all',
    );
    expect(exif(['apps/mobile/src/assets', 'libs/shared/assets'])).toBe(
      'pstack assets strip-exif --dir=apps/mobile/src/assets,libs/shared/assets',
    );
    tree.write('dist/apps/web/x.jpg', 'x');
    expect(exif(['dist/apps/web'])).toBe('node tools/scripts/clean-images.js');
  });

  it('typecheck: one app, named apps, untyped projects', () => {
    const pkg = readJson(tree, 'package.json');
    pkg.scripts = {
      a: 'node tools/scripts/check.js web',
      b: 'node tools/scripts/check.js --app=web,mobile',
    };
    tree.write('package.json', JSON.stringify(pkg));
    replaceToolScripts(tree);
    expect(readJson(tree, 'package.json').scripts).toEqual({
      a: 'nx run web:typecheck',
      b: 'nx run-many -t typecheck --projects=tag:type:app',
    });
  });

  it('TypeScript API and ngc scripts; templates map to -c templates', () => {
    tree.write(
      'tools/scripts/api.js',
      `const ts = require('typescript');
for (const f of ['apps/web/tsconfig.app.json', 'apps/mobile/tsconfig.app.json']) {
  const cfg = ts.getParsedCommandLineOfConfigFile(f, {}, ts.sys);
  const program = ts.createProgram(cfg.fileNames, cfg.options);
  if (ts.getPreEmitDiagnostics(program).length) process.exit(1);
}
`,
    );
    tree.write(
      'tools/scripts/tpl.js',
      "require('child_process').execSync('npx ngc -p apps/web/tsconfig.app.json --noEmit');\n",
    );
    tree.write(
      'package.json',
      JSON.stringify({
        scripts: { a: 'node tools/scripts/api.js', b: 'node tools/scripts/tpl.js' },
      }),
    );
    expect(classifyToolScript(tree, 'tools/scripts/api.js')).toMatchObject({
      job: 'typecheck',
      tsconfigs: ['apps/mobile/tsconfig.app.json', 'apps/web/tsconfig.app.json'],
    });
    expect(classifyToolScript(tree, 'tools/scripts/tpl.js')?.templates).toBe(true);
    replaceToolScripts(tree);
    expect(readJson(tree, 'package.json').scripts).toEqual({
      a: 'nx run-many -t typecheck --projects=tag:type:app',
      b: 'nx run web:typecheck:templates',
    });
    // The templates configuration the command runs was added to web's typecheck.
    expect(readJson(tree, 'apps/web/project.json').targets.typecheck.configurations).toEqual({
      templates: { command: 'ngc --noEmit -p apps/web/tsconfig.app.json' },
    });
  });
});

// Shaped like the scripts of a real workspace (Angular app on the application builder + a Flutter
// app), names made generic.
const IMAGES_DEFAULT_DIR = `// Removes EXIF metadata from .jpg/.jpeg/.png files under a directory.
// Usage: node tools/scripts/images.js [dir]   (default: apps/web/src/assets)
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '../../apps/web/src/assets'));
function listImages(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return listImages(p);
    return /\\.(jpe?g|png)$/i.test(e.name) ? [p] : [];
  });
}
async function strip(file) {
  const meta = await sharp(file).metadata();
  if (!meta.exif) return false;
  // sharp drops all metadata unless .withMetadata() is used
  const data = await sharp(file).jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(file, data);
  return true;
}
(async () => { for (const f of listImages(dir)) await strip(f); })();
`;
const TYPES_PER_APP = `// Type-checks every app that has a tsconfig.app.json (tsc --noEmit) without a full build.
// Usage: node tools/scripts/types.js [app ...]   (default: all apps)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
process.chdir(path.resolve(__dirname, '../..'));
const TARGETS = Object.fromEntries(
  fs.readdirSync('apps').filter((a) => fs.existsSync(\`apps/\${a}/tsconfig.app.json\`)).sort()
    .map((a) => [a, \`apps/\${a}/tsconfig.app.json\`]),
);
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);
for (const name of wanted) execSync(\`npx tsc -p \${TARGETS[name]} --noEmit\`, { stdio: 'pipe' });
`;

describe('adopt on a workspace shaped like the acceptance one (NX-110, NX-111)', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    tree.write(
      'apps/web/project.json',
      JSON.stringify({
        name: 'web',
        projectType: 'application',
        tags: [],
        targets: {
          build: {
            executor: '@angular/build:application',
            options: {
              assets: [
                'apps/web/src/favicon.ico',
                'apps/web/src/assets',
                'apps/web/src/robots.txt',
              ],
            },
          },
          release: {
            executor: '@mouryaamit/nx-polystack:build',
            options: { buildTarget: 'web:build' },
          },
        },
      }),
    );
    tree.write('apps/web/tsconfig.app.json', '{ "extends": "./tsconfig.json" }');
    tree.write(
      'apps/web/tsconfig.json',
      '{ "angularCompilerOptions": { "strictTemplates": true } }',
    );
    tree.write('apps/web/src/assets/a.jpg', 'x');
    tree.write(
      'apps/notes/project.json',
      JSON.stringify({
        name: 'notes',
        projectType: 'application',
        tags: [],
        targets: {
          'build-web': {
            executor: '@mouryaamit/nx-polystack:flutter-build',
            options: { target: 'web' },
          },
        },
      }),
    );
    tree.write(
      'apps/notes/pubspec.yaml',
      'name: notes\nflutter:\n  assets:\n    - assets/images/\n',
    );
    tree.write('apps/notes/assets/images/b.png', 'x');
    tree.write('apps/notes/web/icons/c.png', 'x');
    tree.write('tools/scripts/images.js', IMAGES_DEFAULT_DIR);
    tree.write('tools/scripts/types.js', TYPES_PER_APP);
    tree.write(
      'package.json',
      JSON.stringify(
        {
          name: 'ws',
          scripts: {
            'validate:imports': 'node tools/scripts/types.js',
            'validate:imports:angular': 'node tools/scripts/types.js web',
            'assets:strip-exif': 'node tools/scripts/images.js apps/web/src/assets',
          },
        },
        null,
        2,
      ),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads what the code does, not its comments', () => {
    expect(classifyToolScript(tree, 'tools/scripts/images.js')).toMatchObject({
      job: 'strip-exif',
      more: [],
      dirs: ['apps/web/src/assets'],
    });
    expect(classifyToolScript(tree, 'tools/scripts/types.js')).toMatchObject({
      job: 'typecheck',
      more: [],
      walks: ['app'],
    });
  });

  it('pstack adopt --remove-old-scripts: npm scripts run pstack, tools/scripts is empty', async () => {
    await adoptGenerator(tree, { removeOldScripts: true });
    expect(readJson(tree, 'package.json').scripts).toEqual({
      'validate:imports': 'nx run-many -t typecheck',
      'validate:imports:angular': 'nx run web:typecheck',
      'assets:strip-exif': 'pstack assets strip-exif --app=web',
    });
    expect(tree.exists('tools/scripts/images.js')).toBe(false);
    expect(tree.exists('tools/scripts/types.js')).toBe(false);
    // The target the scripts run now exists (with the templates configuration).
    expect(
      readJson(tree, 'apps/web/project.json').targets.typecheck.configurations.templates,
    ).toEqual({
      command: 'ngc --noEmit -p apps/web/tsconfig.app.json',
    });
  });
});
