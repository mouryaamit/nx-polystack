import {
  appFieldInScript,
  baseHrefsInScript,
  readBuildScripts,
} from '../../../src/generators/migrate/nx/build-scripts';

import { put, tmpSource } from './helpers';

describe('build script reading', () => {
  it('reads fields of per-app config maps (NX-108)', () => {
    const text = [
      'const APPS = {',
      "  web: { type: 'angular', dist: 'dist/site', baseHref: '/', envFiles: { dev: 'a.ts' } },",
      "  res: { type: 'flutter', dist: \"dist/res\", baseHref: '/res/' },",
      '};',
    ].join('\n');
    expect(appFieldInScript(text, 'res', 'dist')).toBe('dist/res');
    expect(appFieldInScript(text, 'web', 'dist')).toBe('dist/site');
    expect(appFieldInScript(text, 'web', 'dev')).toBeUndefined();
    expect(appFieldInScript(text, 'other', 'dist')).toBeUndefined();
    expect(baseHrefsInScript(text, 'res')).toEqual({ '*': '/res/' });
    expect(baseHrefsInScript(text, 'web')).toEqual({ '*': '/' });
  });

  it('reads base href maps', () => {
    const text =
      `const OUT = { web: '/dist/web' };\n` +
      `const BASE_HREF = {\n  web: { uat: '/w/', production: "/w/" },\n  'admin-ui': '/admin/',\n};`;
    expect(baseHrefsInScript(text, 'web')).toEqual({ uat: '/w/', prod: '/w/' });
    expect(baseHrefsInScript(text, 'admin-ui')).toEqual({ '*': '/admin/' });
    expect(baseHrefsInScript(text, 'other')).toBeUndefined();
    // Only maps named for base hrefs count; two that disagree are not guessed between.
    expect(baseHrefsInScript(`const OUT = { web: '/dist/web' };`, 'web')).toBeUndefined();
    expect(
      baseHrefsInScript(
        `const baseHrefs = { web: '/a/' }; const BASE_HREF_OLD = { web: '/b/' };`,
        'web',
      ),
    ).toBeUndefined();
  });

  it('finds custom build scripts, nx flags and unreadable apps', () => {
    const src = tmpSource();
    put(src, 'tools/build.js', "const BASE_HREF = { web: { uat: '/w/' } };\n");
    const info = readBuildScripts(
      src,
      {
        'build:web:uat': 'node tools/build.js --project=web --env=uat',
        'build:api:prod': 'node ./tools/build.js --project=api --env=prod',
        'build:ui': 'nx run ui:build:production --base-href=/ui/',
        'build:all': 'node tools/build-all.js prod',
        start: 'nx serve web',
      },
      ['web', 'api', 'ui'],
    );
    expect(info.baseHrefs.get('web')).toEqual({ uat: '/w/' });
    expect(info.baseHrefs.get('ui')).toEqual({ prod: '/ui/' });
    expect(info.customScripts).toEqual(['tools/build.js']);
    expect(Object.keys(info.customBuilds).sort()).toEqual(['build:api:prod', 'build:web:uat']);
    expect(info.unread).toEqual(['api']);
  });
});
