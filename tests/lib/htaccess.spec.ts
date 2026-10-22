import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Tree, readJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import {
  findHtaccessFiles,
  htaccessSourcePath,
  placeHtaccess,
  removeHtaccessFiles,
  requireHtaccessSource,
} from '../../src/lib/release/htaccess';
import { adoptHtaccess, htaccessNote } from '../../src/lib/release/htaccess-adopt';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-htaccess-'));
}

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

describe('htaccess helpers', () => {
  it('names environments/<envProject>/htaccess.<env>, env lower-cased', () => {
    expect(htaccessSourcePath('portal', 'UAT')).toBe('environments/portal/htaccess.uat');
  });

  it('requireHtaccessSource names the app, env and file when it is missing', () => {
    const root = tmp();
    expect(() => requireHtaccessSource(root, 'portal', 'portal', 'PPD')).toThrow(
      'portal: the ppd build needs environments/portal/htaccess.ppd (htaccess is on)',
    );
    write(root, 'environments/portal/htaccess.ppd', '# ppd\n');
    expect(requireHtaccessSource(root, 'portal', 'portal', 'PPD')).toBe(
      path.join(root, 'environments/portal/htaccess.ppd'),
    );
  });

  it('finds and removes every .htaccess-like file', () => {
    const root = tmp();
    for (const f of ['.htaccess', 'a/.htaccess.prod', 'b/htaccess.uat', 'keep.txt']) {
      write(root, f, 'x');
    }
    expect(findHtaccessFiles(root)).toEqual(['.htaccess', 'a/.htaccess.prod', 'b/htaccess.uat']);
    expect(removeHtaccessFiles(root)).toHaveLength(3);
    expect(findHtaccessFiles(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'keep.txt'))).toBe(true);
  });

  it('placeHtaccess leaves exactly one .htaccess in the served folder', () => {
    const root = tmp();
    const out = path.join(root, 'dist');
    write(root, 'src.ht', '# uat\n');
    write(out, '.htaccess', '# stale\n');
    write(out, 'browser/assets/htaccess.prod', '# copied by a glob\n');
    const removed = placeHtaccess(path.join(root, 'src.ht'), out, path.join(out, 'browser'));
    expect(removed).toEqual(['.htaccess', 'browser/assets/htaccess.prod']);
    expect(findHtaccessFiles(out)).toEqual(['browser/.htaccess']);
    expect(fs.readFileSync(path.join(out, 'browser/.htaccess'), 'utf8')).toBe('# uat\n');
  });
});

describe('adoptHtaccess', () => {
  let tree: Tree;
  const pjPath = 'apps/portal/project.json';
  const project = (assets: unknown[], release: Record<string, unknown> = {}) => ({
    name: 'portal',
    targets: {
      build: {
        executor: '@angular-devkit/build-angular:browser',
        options: { assets },
        configurations: { production: { assets: ['apps/portal/src/.htaccess'] } },
      },
      release: {
        executor: '@mouryaamit/nx-polystack:build',
        options: { buildTarget: 'portal:build' },
        configurations: { dev: { env: 'DEV' }, uat: { env: 'UAT' }, prod: { env: 'PROD' } },
        ...release,
      },
    },
  });

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  });

  it('copies the built .htaccess to every release env and drops it from the assets', () => {
    tree.write('apps/portal/src/.htaccess', '# rules\n');
    tree.write(
      pjPath,
      JSON.stringify(project(['apps/portal/src/favicon.ico', 'apps/portal/src/.htaccess'])),
    );
    tree.write('environments/portal/htaccess.prod', '# hand-written prod\n');
    const r = adoptHtaccess(tree, pjPath);
    expect(r.source).toBe('apps/portal/src/.htaccess');
    expect(r.written).toEqual([
      'environments/portal/htaccess.dev',
      'environments/portal/htaccess.uat',
    ]);
    expect(r.kept).toEqual(['environments/portal/htaccess.prod']);
    expect(tree.read('environments/portal/htaccess.uat', 'utf-8')).toBe('# rules\n');
    expect(tree.read('environments/portal/htaccess.prod', 'utf-8')).toBe('# hand-written prod\n');
    expect(tree.exists('apps/portal/src/.htaccess')).toBe(false);
    const pj = readJson(tree, pjPath);
    expect(pj.targets.build.options.assets).toEqual(['apps/portal/src/favicon.ico']);
    expect(pj.targets.build.configurations.production.assets).toEqual([]);
    expect(pj.targets.release.options.htaccess).toBeUndefined();
    const notes: string[] = [];
    htaccessNote(r, 'portal', notes);
    expect(notes[0]).toContain('`apps/portal/src/.htaccess` became the env files');
  });

  it('handles a glob asset and the release envProject', () => {
    tree.write('apps/portal/src/.htaccess', '# rules\n');
    tree.write(
      pjPath,
      JSON.stringify(
        project([{ glob: '.htaccess', input: 'apps/portal/src/', output: '/' }], {
          options: { buildTarget: 'portal:build', envProject: 'shared' },
          configurations: { prod: { env: 'PROD' } },
        }),
      ),
    );
    const r = adoptHtaccess(tree, pjPath);
    expect(r.written).toEqual(['environments/shared/htaccess.prod']);
    expect(readJson(tree, pjPath).targets.build.options.assets).toEqual([]);
  });

  it('sets htaccess: false when the app built no .htaccess', () => {
    tree.write(pjPath, JSON.stringify(project(['apps/portal/src/favicon.ico'])));
    const r = adoptHtaccess(tree, pjPath);
    expect(r).toMatchObject({ disabled: true, written: [] });
    expect(readJson(tree, pjPath).targets.release.options.htaccess).toBe(false);
    const notes: string[] = [];
    htaccessNote(r, 'portal', notes);
    expect(notes[0]).toContain('release builds make no `.htaccess`');
  });

  it('keeps apps already on env files, and names the envs that have none', () => {
    tree.write(pjPath, JSON.stringify(project(['apps/portal/src/favicon.ico'])));
    tree.write('environments/portal/htaccess.dev', '# dev\n');
    tree.write('environments/portal/htaccess.prod', '# prod\n');
    const r = adoptHtaccess(tree, pjPath);
    expect(r).toMatchObject({ disabled: false, written: [], missing: ['uat'] });
    expect(readJson(tree, pjPath).targets.release.options.htaccess).toBeUndefined();
    const notes: string[] = [];
    htaccessNote(r, 'portal', notes);
    expect(notes[0]).toContain('no `htaccess.uat`');
  });

  it("reads the assets of the release target's buildTarget", () => {
    tree.write('apps/portal/src/.htaccess', '# rules\n');
    const pj = project([]);
    (pj.targets as Record<string, unknown>)['ng-build'] = {
      executor: '@angular-devkit/build-angular:browser',
      options: { assets: ['apps/portal/src/.htaccess'] },
    };
    (pj.targets.release.options as Record<string, unknown>).buildTarget = 'portal:ng-build';
    tree.write(pjPath, JSON.stringify(pj));
    const r = adoptHtaccess(tree, pjPath);
    expect(r.source).toBe('apps/portal/src/.htaccess');
    expect(readJson(tree, pjPath).targets['ng-build'].options.assets).toEqual([]);
  });

  it('leaves apps without a release target, or already set to false, alone', () => {
    tree.write(pjPath, JSON.stringify({ name: 'portal', targets: { build: {} } }));
    expect(adoptHtaccess(tree, pjPath)).toEqual({
      written: [],
      kept: [],
      disabled: false,
      missing: [],
    });
    tree.write(pjPath, JSON.stringify(project([], { options: { htaccess: false } })));
    expect(adoptHtaccess(tree, pjPath)).toEqual({
      written: [],
      kept: [],
      disabled: false,
      missing: [],
    });
  });
});
