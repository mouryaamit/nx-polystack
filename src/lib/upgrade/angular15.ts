import * as fs from 'fs';
import * as path from 'path';

/**
 * The 14 → 15 step's fix-ups. Angular 14 and 15 both run on Nx 17.0, so the step is
 * `nx migrate @angular/core@15` with no Nx migrations: what Angular's CLI migrations and Nx's
 * Angular 15 migrations would have done is done here.
 */

type Json = Record<string, unknown>;

/** Files under dir (no node_modules, no dot folders) whose name matches. */
function walk(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (match(e.name)) out.push(p);
    }
  };
  go(dir);
  return out;
}

const OLD_TARGET = /("target"\s*:\s*)"(es5|es2015|es2016|es2017|es2018|es2019|es2020|es2021)"/i;

/**
 * Angular 15 compiles for ES2022 with `useDefineForClassFields: false` (its CLI forces both and
 * warns otherwise). Rewrites older `target`s in the workspace's tsconfig files as Angular's own
 * migration does, adding `useDefineForClassFields: false` where the file does not set it. Text
 * edits, so comments and layout stay. Returns the files changed (workspace-relative).
 */
export function es2022Targets(root: string): string[] {
  const files = [
    ...fs
      .readdirSync(root)
      .filter((f) => /^tsconfig.*\.json$/.test(f))
      .map((f) => path.join(root, f)),
    ...walk(path.join(root, 'apps'), (n) => /^tsconfig.*\.json$/.test(n)),
    ...walk(path.join(root, 'libs'), (n) => /^tsconfig.*\.json$/.test(n)),
  ];
  const changed: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const m = OLD_TARGET.exec(text);
    if (!m || m.index === undefined) continue;
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '  ';
    const defineFields = /"useDefineForClassFields"/.test(text)
      ? ''
      : `,\n${indent}"useDefineForClassFields": false`;
    const out =
      text.slice(0, m.index) + `${m[1]}"es2022"${defineFields}` + text.slice(m.index + m[0].length);
    fs.writeFileSync(file, out);
    changed.push(path.relative(root, file));
  }
  return changed;
}

/** The file's code with comments and blank lines removed. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** A polyfills file that only loads zone.js (what Angular 15's `["zone.js"]` does). */
function onlyZone(text: string): boolean {
  const lines = code(text).split('\n');
  return (
    lines.length > 0 && lines.every((l) => /^import\s+['"]zone\.js(\/dist\/zone)?['"];?$/.test(l))
  );
}

/**
 * Apps whose build loads zone.js from a polyfills file that does nothing else (Angular 14's
 * `polyfills: "<app>/src/polyfills.ts"`) get Angular 15's `polyfills: ["zone.js"]`; the file goes,
 * and so does its entry in the app's tsconfig `files`. A polyfills file with anything else in it
 * stays (Angular 15 still takes a file). Returns what changed (workspace-relative).
 */
export function polyfillsToArray(root: string): string[] {
  const changed: string[] = [];
  for (const pjFile of walk(path.join(root, 'apps'), (n) => n === 'project.json')) {
    const original = fs.readFileSync(pjFile, 'utf8');
    let pj = original;
    const seen = new Set<string>();
    for (const m of pj.matchAll(/"polyfills"\s*:\s*"([^"]+\.ts)"/g)) seen.add(m[1]);
    for (const rel of seen) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file) || !onlyZone(fs.readFileSync(file, 'utf8'))) continue;
      const esc = rel.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      pj = pj.replace(
        new RegExp(`"polyfills"(\\s*):(\\s*)"${esc}"`, 'g'),
        '"polyfills"$1:$2["zone.js"]',
      );
      fs.rmSync(file);
      changed.push(rel);
      // The app's tsconfig files that list it (tsconfig.app.json, tsconfig.spec.json).
      for (const ts of walk(path.dirname(pjFile), (n) => /^tsconfig.*\.json$/.test(n))) {
        const entry = path.relative(path.dirname(ts), file).split(path.sep).join('/');
        const e = entry.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        const text = fs.readFileSync(ts, 'utf8');
        const out = text
          .replace(new RegExp(`,\\s*"(\\./)?${e}"`), '')
          .replace(new RegExp(`"(\\./)?${e}"\\s*,\\s*`), '');
        if (out !== text) {
          fs.writeFileSync(ts, out);
          changed.push(path.relative(root, ts));
        }
      }
    }
    if (pj !== original) {
      fs.writeFileSync(pjFile, pj);
      changed.push(path.relative(root, pjFile));
    }
  }
  return [...new Set(changed)];
}

/** zone.js and NgRx for Angular 15 (`pkg@range`), for the declared ones that are older. */
export function angular15RuntimeSpecs(pkg: Json): string[] {
  const deps: Record<string, string> = {
    ...((pkg['devDependencies'] as Record<string, string> | undefined) ?? {}),
    ...((pkg['dependencies'] as Record<string, string> | undefined) ?? {}),
  };
  const out: string[] = [];
  const zone = deps['zone.js'];
  const zm = zone ? /(\d+)\.(\d+)/.exec(zone) : null;
  if (zm && Number(zm[1]) === 0 && Number(zm[2]) < 12) out.push('zone.js@~0.12.0');
  for (const [name, spec] of Object.entries(deps)) {
    const major = /(\d+)/.exec(spec)?.[1];
    if (name.startsWith('@ngrx/') && major !== undefined && Number(major) < 15) {
      out.push(`${name}@~15.4.0`);
    }
  }
  return out.sort();
}
