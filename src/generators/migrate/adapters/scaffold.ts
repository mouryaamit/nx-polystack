import { logger, Tree, updateJson } from '@nx/devkit';

import { NAME_RE } from '../names';

import { adapterEntries, loadExternalAdapters, parseNxJson } from './external';

import { ADAPTERS } from './index';

/** `pstack migrate --new-adapter=<name>`: a starter adapter, its spec, and the nx.json entry. */

const DIR = 'tools/migrate';

const pascal = (id: string) =>
  id
    .split('-')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
const camel = (id: string) => {
  const p = pascal(id);
  return p[0].toLowerCase() + p.slice(1);
};

function adapterSource(id: string): string {
  const v = `${camel(id)}Adapter`;
  return `import {
  copyIntoTree,
  defineMigrationAdapter,
  emptyReportData,
  MIGRATE_API_VERSION,
  readSourceJson,
  recordCopy,
  setProjectTags,
  sourceExists,
  upTo,
} from '@mouryaamit/nx-polystack/migrate';

/**
 * ${id}: a starter :migrate adapter. As generated it imports a static web site (an index.html at
 * the source root) into apps/<name> with a project.json. Change detect() and migrate() for your
 * source shape; pstack migrate lists it with --detect and uses it with --adapter=${id}.
 */
export const ${v} = defineMigrationAdapter({
  apiVersion: MIGRATE_API_VERSION,
  id: '${id}',
  label: 'static web site (starter adapter)',

  /** 0–1. Stay below 0.8 for shapes a built-in adapter may also claim. */
  detect(sourceDir) {
    if (!sourceExists(sourceDir, 'index.html')) {
      return { confidence: 0, reasons: ['no index.html at the source root'] };
    }
    if (sourceExists(sourceDir, 'angular.json') || sourceExists(sourceDir, 'nx.json')) {
      return { confidence: 0, reasons: ['an Angular or Nx source: a built-in adapter handles it'] };
    }
    return { confidence: 0.6, reasons: ['index.html at the source root'] };
  },

  /** App name the source suggests: its package.json name, if any. */
  defaultName(sourceDir) {
    return readSourceJson<{ name?: string }>(sourceDir, 'package.json')?.name;
  },

  migrate(tree, ctx) {
    const data = emptyReportData();
    data.npmProject = false;
    const copy = copyIntoTree(
      tree,
      ctx.sourceDir,
      ctx.projectRoot,
      { anyDepth: ['node_modules', '.git'], topLevel: ['dist', 'coverage', 'package-lock.json'] },
      { maxFiles: ctx.maxFiles },
    );
    recordCopy(data, copy, '');
    tree.write(
      \`\${ctx.projectRoot}/project.json\`,
      JSON.stringify(
        {
          name: ctx.name,
          $schema: \`\${upTo(ctx.projectRoot)}node_modules/nx/schemas/project-schema.json\`,
          projectType: 'application',
          sourceRoot: ctx.projectRoot,
          tags: [],
          targets: {},
        },
        null,
        2,
      ) + '\\n',
    );
    setProjectTags(tree, ctx.projectRoot, ['scope:app', 'type:app', 'platform:web']);
    data.notes.push('Imported with the ${id} starter adapter: add build and serve targets.');
    return data;
  },
});

export default ${v};
`;
}

function specSource(id: string): string {
  const v = `${camel(id)}Adapter`;
  return `import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { ${v} } from './${id}.adapter';

/** Run with Jest and ts-jest (npm i -D jest ts-jest @types/jest): npx jest -c ${DIR}/jest.config.js */
describe('${id} adapter', () => {
  const made: string[] = [];
  const empty = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '${id}-'));
    made.push(dir);
    return dir;
  };
  const source = () => {
    const dir = empty();
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>\\n');
    return dir;
  };
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects an index.html source', () => {
    expect(${v}.detect(source()).confidence).toBe(0.6);
    expect(${v}.detect(empty()).confidence).toBe(0);
  });

  it('copies the site to the app folder with a project.json', () => {
    const tree = createTreeWithEmptyWorkspace();
    const data = ${v}.migrate(tree, {
      sourceDir: source(),
      name: 'site',
      projectRoot: 'apps/site',
      forceAngular: false,
    });
    expect(tree.read('apps/site/index.html', 'utf8')).toContain('hello');
    expect(JSON.parse(tree.read('apps/site/project.json', 'utf8') as string).name).toBe('site');
    expect(data.copied).toBe(1);
  });
});
`;
}

export function scaffoldAdapter(tree: Tree, name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`migrate: --new-adapter="${name}" must be kebab-case (it is the adapter id).`);
  }
  if (ADAPTERS.some((a) => a.id === name)) {
    throw new Error(
      `migrate: --new-adapter="${name}" is the id of a built-in adapter; pick another.`,
    );
  }
  const file = `${DIR}/${name}.adapter.ts`;
  const spec = `${DIR}/${name}.adapter.spec.ts`;
  for (const f of [file, spec]) {
    if (tree.exists(f)) throw new Error(`migrate: ${f} already exists.`);
  }
  if (!tree.exists('nx.json')) {
    throw new Error('migrate: --new-adapter needs an Nx workspace (no nx.json).');
  }
  // A malformed list is refused rather than replaced.
  const nxJson = parseNxJson(tree.read('nx.json', 'utf8'));
  adapterEntries(nxJson);
  // Ids of the adapters already listed (when they load; a broken one is reported by migrate).
  let listed: string[] = [];
  try {
    listed = loadExternalAdapters(tree.root, nxJson).map((a) => a.id);
  } catch {
    listed = [];
  }
  if (listed.includes(name)) {
    throw new Error(
      `migrate: --new-adapter="${name}" is the id of an adapter nx.json already lists; pick another.`,
    );
  }
  const entry = `./${file}`;
  updateJson(tree, 'nx.json', (json) => {
    const pstack = json.pstack && typeof json.pstack === 'object' ? json.pstack : {};
    const adapters: string[] = Array.isArray(pstack.migrateAdapters) ? pstack.migrateAdapters : [];
    if (!adapters.includes(entry)) adapters.push(entry);
    json.pstack = { ...pstack, migrateAdapters: adapters };
    return json;
  });
  tree.write(file, adapterSource(name));
  tree.write(spec, specSource(name));
  const jestConfig = `${DIR}/jest.config.js`;
  if (!tree.exists(jestConfig)) {
    tree.write(
      jestConfig,
      `/** Jest for the workspace's :migrate adapters: npx jest -c ${DIR}/jest.config.js */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  transform: { '^.+\\\\.ts$': ['ts-jest', { diagnostics: false, tsconfig: { esModuleInterop: true } }] },
};
`,
    );
  }
  logger.info(
    [
      `Added the ${name} adapter: ${file} (listed in nx.json pstack.migrateAdapters).`,
      `Try it: pstack migrate --source=<path> --detect, then --adapter=${name} (the starter ` +
        'detects at 0.60, below the 0.80 needed to be picked without --adapter or --min-confidence).',
      `Its spec (${spec}) runs with Jest and ts-jest: npm i -D jest ts-jest @types/jest, then ` +
        `npx jest -c ${DIR}/jest.config.js`,
    ].join('\n'),
  );
}
