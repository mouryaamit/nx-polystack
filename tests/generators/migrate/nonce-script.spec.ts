import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import * as fs from 'fs';
import * as path from 'path';

import migrateGenerator from '../../../src/generators/migrate/generator';
import { nonceFromScript } from '../../../src/generators/migrate/nonce-script';

import { fixtureCopy, put } from './helpers';

/** A post-build nonce script like those Angular CLI repos carry (written for these tests). */
const SCRIPT = (body: string) => `const fs = require('fs');
const file = 'dist/' + process.argv[2] + '/index.html';
// The server fills this per request (Apache SSI).
const nonceValue = "<!--#echo var='UNIQUE_ID' -->";
let html = fs.readFileSync(file, 'utf-8');
${body}
fs.writeFileSync(file, html);
`;
const LEGACY =
  SCRIPT(`html = html.replace(/<script(?![^>]*\\bsrc=)(?![^>]*\\bnonce=)([^>]*)>/gi, \`<script nonce="\${nonceValue}"$1>\`);
// html = html.replace(/<script>/g, \`<script nonce="\${nonceValue}">\`);
html = html.replace(/<link(?![^>]*nonce=)([^>]*)>/g, \`<link nonce="\${nonceValue}"$1>\`);
html = html.replace(/<style(?![^>]*\\bnonce=)([^>]*)>/gi, \`<style nonce="\${nonceValue}"$1>\`);
html = html.replace(/random-csp-nonce/g, \`\${nonceValue}\`);`);

describe('post-build nonce scripts', () => {
  it('reads placeholder, tags, position and tokens; commented-out lines do not count', () => {
    expect(nonceFromScript(LEGACY, '<meta name="CSP-NONCE" content="random-csp-nonce">')).toEqual({
      placeholder: "<!--#echo var='UNIQUE_ID' -->",
      tags: 'legacy',
      position: 'after-tag-name',
      replaceTokens: ['random-csp-nonce'],
      addMeta: false,
      unsure: [],
    });
  });

  it('every script (not only inline), attribute at the end, no meta in the page', () => {
    const every =
      SCRIPT(`html = html.replace(/<script([^>]*)>/g, \`<script$1 nonce="\${nonceValue}">\`);
html = html.replace(/<link([^>]*)>/g, \`<link$1 nonce="\${nonceValue}">\`);
html = html.replace(/<style([^>]*)>/g, \`<style$1 nonce="\${nonceValue}">\`);`);
    expect(nonceFromScript(every, '<html></html>')).toEqual({
      placeholder: "<!--#echo var='UNIQUE_ID' -->",
      tags: 'every',
      position: 'end',
      unsure: [],
    });
  });

  it("only some tags: pstack's default set, and it says so", () => {
    const scriptsOnly = SCRIPT(
      'html = html.replace(/<script([^>]*)>/g, `<script nonce="${nonceValue}"$1>`);',
    );
    const r = nonceFromScript(scriptsOnly);
    expect(r?.tags).toBeUndefined();
    expect(r?.unsure[0]).toContain('only to scripts');
  });

  it('a script without an SSI echo, or without nonce, is not a nonce script', () => {
    expect(nonceFromScript("const v = 'random-csp-nonce';\nconsole.log(v);\n")).toBeUndefined();
    expect(nonceFromScript('const banner = "<!--#echo var=\'DATE_LOCAL\' -->";\n')).toBeUndefined();
  });

  describe('migrate (Angular CLI app)', () => {
    let tree: Tree;
    beforeEach(() => {
      jest.spyOn(logger, 'info').mockImplementation(() => undefined);
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
      tree.write('package.json', JSON.stringify({ name: '@acme/ws', scripts: {} }));
    });
    afterEach(() => jest.restoreAllMocks());

    const withScript = (postName = 'postbuild:prod') => {
      const src = fixtureCopy('angular15-app');
      const pkgFile = path.join(src, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      pkg.scripts = { ...pkg.scripts, [postName]: "node inject-nonce.js '/'" };
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
      put(src, 'inject-nonce.js', LEGACY);
      return src;
    };

    it('sets secure and the nonce options on the release target, and reports it', async () => {
      await migrateGenerator(tree, { source: withScript(), name: 'portal' });
      const release = readJson(tree, 'apps/portal/project.json').targets.release;
      expect(release.options.secure).toBe(true);
      expect(release.options.nonce).toEqual({
        placeholder: "<!--#echo var='UNIQUE_ID' -->",
        tags: 'legacy',
        position: 'after-tag-name',
        replaceTokens: ['random-csp-nonce'],
      });
      expect(tree.read('docs/migrations/portal.md', 'utf8')).toContain(
        "CSP nonce: the source's post-build script `inject-nonce.js` (`postbuild:prod`)",
      );
    });

    it('a post script that is not about nonces changes nothing', async () => {
      const src = withScript();
      put(src, 'inject-nonce.js', "console.log('done');\n");
      await migrateGenerator(tree, { source: src, name: 'portal' });
      const release = readJson(tree, 'apps/portal/project.json').targets.release;
      expect(release.options.secure).toBeUndefined();
      expect(release.options.nonce).toBeUndefined();
    });
  });
});
