import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import infraGenerator from '../../src/generators/infra/generator';
import { addExifScripts, parseExifMode, setExifMode } from '../../src/lib/utils/exif-checks';
import assetsExifScripts from '../../src/migrations/assets-exif-scripts/assets-exif-scripts';

const GH = `jobs:
  main:
    steps:
      - run: npm ci
      - run: npx nx affected -t lint typecheck test build --parallel=3
      - run: npm run check:cycles
`;
const JENKINS = `pipeline {
  stages {
    stage('Lint') {
      steps {
        sh 'npx nx affected -t lint typecheck test build --parallel=3 --base="\${NX_BASE}" --head=HEAD'
      }
    }
  }
}
`;

describe('source-image EXIF checks (NX-110)', () => {
  let tree: Tree;
  const pkg = () => readJson(tree, 'package.json');

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({
        name: 'ws',
        scripts: { lint: 'nx run-many -t lint' },
        'lint-staged': { '*.ts': ['eslint --fix'] },
      }),
    );
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('fix: scripts, lint-staged step and CI steps (GitHub and Jenkins), idempotent', () => {
    tree.write('.github/workflows/ci.yml', GH);
    tree.write('Jenkinsfile', JENKINS);
    const r = setExifMode(tree, 'fix');
    expect(r).toEqual({
      scripts: ['assets:strip-exif', 'assets:check-exif'],
      lintStaged: 'set',
      ci: { changed: ['.github/workflows/ci.yml', 'Jenkinsfile'], unknown: [] },
    });
    expect(pkg()['lint-staged']['*.{jpg,jpeg,png,webp}']).toEqual(['pstack assets strip-exif']);
    expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain(
      '      - run: npx nx affected -t lint typecheck test build --parallel=3\n      - run: npm run assets:check-exif\n',
    );
    expect(tree.read('Jenkinsfile', 'utf8')).toContain(
      "--head=HEAD'\n        sh 'npm run assets:check-exif'\n",
    );
    const files = ['package.json', '.github/workflows/ci.yml', 'Jenkinsfile'].map((f) =>
      tree.read(f, 'utf8'),
    );
    expect(setExifMode(tree, 'fix')).toEqual({
      scripts: [],
      lintStaged: 'unchanged',
      ci: { changed: [], unknown: [] },
    });
    expect(
      ['package.json', '.github/workflows/ci.yml', 'Jenkinsfile'].map((f) => tree.read(f, 'utf8')),
    ).toEqual(files);
  });

  it('check switches the lint-staged step; off removes the steps, keeps the scripts', () => {
    tree.write('.github/workflows/ci.yml', GH);
    setExifMode(tree, 'fix');
    expect(setExifMode(tree, 'check').lintStaged).toBe('set');
    expect(pkg()['lint-staged']['*.{jpg,jpeg,png,webp}']).toEqual([
      'pstack assets strip-exif --check',
    ]);
    expect(setExifMode(tree, 'off')).toEqual({
      scripts: [],
      lintStaged: 'removed',
      ci: { changed: ['.github/workflows/ci.yml'], unknown: [] },
    });
    expect(pkg()['lint-staged']).toEqual({ '*.ts': ['eslint --fix'] });
    expect(tree.read('.github/workflows/ci.yml', 'utf8')).toBe(GH);
    expect(pkg().scripts['assets:strip-exif']).toBe('pstack assets strip-exif --all');
  });

  it('leaves an images glob that runs something else, other lint-staged configs and unknown CI', () => {
    tree.write(
      'package.json',
      JSON.stringify({ 'lint-staged': { '*.{jpg,jpeg,png,webp}': ['imagemin-lint-staged'] } }),
    );
    tree.write('.github/workflows/ci.yml', 'jobs:\n  a:\n    steps:\n      - run: npm test\n');
    const r = setExifMode(tree, 'fix');
    expect(r.lintStaged).toBe('other-config');
    expect(r.ci.unknown).toEqual(['.github/workflows/ci.yml']);
    expect(pkg()['lint-staged']).toEqual({ '*.{jpg,jpeg,png,webp}': ['imagemin-lint-staged'] });
    tree.write('package.json', JSON.stringify({ name: 'ws' }));
    tree.write('.lintstagedrc.json', '{}');
    expect(setExifMode(tree, 'fix').lintStaged).toBe('other-config');
  });

  it('scripts: only where missing, none when a script already runs pstack assets', () => {
    tree.write('package.json', JSON.stringify({ scripts: { 'assets:strip-exif': 'node x.js' } }));
    expect(addExifScripts(tree)).toEqual(['assets:check-exif']);
    expect(pkg().scripts['assets:strip-exif']).toBe('node x.js');
    tree.write(
      'package.json',
      JSON.stringify({ scripts: { images: 'pstack assets strip-exif --app=web' } }),
    );
    expect(addExifScripts(tree)).toEqual([]);
  });

  it('pstack infra --exif=check on an existing workspace; bad values refused', async () => {
    tree.write('.github/workflows/ci.yml', GH);
    await infraGenerator(tree, { with: 'none', exif: 'check', skipFormat: true });
    expect(pkg()['lint-staged']['*.{jpg,jpeg,png,webp}']).toEqual([
      'pstack assets strip-exif --check',
    ]);
    expect(tree.read('.github/workflows/ci.yml', 'utf8')).toContain('npm run assets:check-exif');
    expect(() => parseExifMode('strip')).toThrow('--exif must be fix, check, off (got "strip")');
    expect(parseExifMode(undefined)).toBeUndefined();
  });

  it('migration assets-exif-scripts adds the scripts once', async () => {
    await assetsExifScripts(tree);
    expect(pkg().scripts).toEqual({
      lint: 'nx run-many -t lint',
      'assets:strip-exif': 'pstack assets strip-exif --all',
      'assets:check-exif': 'pstack assets strip-exif --all --check',
    });
    const text = tree.read('package.json', 'utf8');
    await assetsExifScripts(tree);
    expect(tree.read('package.json', 'utf8')).toBe(text);
  });
});
