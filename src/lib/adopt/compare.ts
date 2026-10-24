import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/**
 * Compares two builds of the same app: the workspace's own build script (before adopt) and the
 * release target. Hashed file names, the build stamp and the obfuscator's random output differ on
 * every build, so the checks look at what must match, not at bytes.
 */

export type CheckStatus = 'same' | 'differs' | 'info';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Content hashes in Angular file names (main.1a2b3c4d5e6f7a8b.js → main.HASH.js). */
const normalize = (rel: string) => rel.replace(/\.[0-9a-f]{16,20}\./g, '.HASH.');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel));

/** The app's own chunks (main and lazy), not vendor, polyfills, runtime, scripts or styles. */
const isAppChunk = (rel: string) =>
  /\.m?js$/.test(rel) &&
  !rel.includes('/') &&
  !/^(vendor|polyfills|runtime|scripts|styles)[.-]/.test(rel);

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function exifImages(dir: string, files: string[]): number {
  let n = 0;
  for (const f of files) {
    if (!/\.(jpe?g|png)$/i.test(f)) continue;
    const buf = read(dir, f);
    const jpeg = /\.jpe?g$/i.test(f) && buf.includes(Buffer.from('Exif\0\0'));
    const png = /\.png$/i.test(f) && buf.includes(Buffer.from('eXIf'));
    if (jpeg || png) n++;
  }
  return n;
}

function nonceCounts(html: string): string {
  const tags = ['script', 'link', 'style', 'meta'];
  return tags
    .map((t) => `${t} ${count(html, new RegExp(`<${t}\\b[^>]*\\bnonce=`, 'gi'))}`)
    .join(', ');
}

function buildMeta(html: string): Record<string, unknown> | null {
  const m = /<meta[^>]*name="x-build"[^>]*content="([^"]+)"/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

/** The checks for one env: `oldDir` built by the old script, `newDir` by the release target. */
export function compareBuilds(oldDir: string, newDir: string): Check[] {
  const checks: Check[] = [];
  const oldFiles = listFiles(oldDir);
  const newFiles = listFiles(newDir);
  const oldSet = new Map(oldFiles.map((f) => [normalize(f), f]));
  const newSet = new Map(newFiles.map((f) => [normalize(f), f]));
  const onlyOld = [...oldSet.keys()].filter((k) => !newSet.has(k));
  const onlyNew = [...newSet.keys()].filter((k) => !oldSet.has(k));
  checks.push({
    name: 'Files',
    status: onlyOld.length + onlyNew.length === 0 ? 'same' : 'differs',
    detail:
      onlyOld.length + onlyNew.length === 0
        ? `${oldSet.size} files, the same set (hashed names aside)`
        : [
            onlyOld.length ? `only in the old build: ${onlyOld.join(', ')}` : '',
            onlyNew.length ? `only in the new build: ${onlyNew.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
  });

  const ht = '.htaccess';
  const oldHt = oldFiles.includes(ht) ? read(oldDir, ht) : null;
  const newHt = newFiles.includes(ht) ? read(newDir, ht) : null;
  checks.push({
    name: '.htaccess',
    status: oldHt && newHt && oldHt.equals(newHt) ? 'same' : !oldHt && !newHt ? 'same' : 'differs',
    detail:
      oldHt && newHt
        ? oldHt.equals(newHt)
          ? 'identical'
          : `different content (${oldHt.length} → ${newHt.length} bytes)`
        : `${oldHt ? 'old has one' : 'old has none'}, ${newHt ? 'new has one' : 'new has none'}`,
  });

  const differing: string[] = [];
  let identical = 0;
  for (const [key, of] of oldSet) {
    const nf = newSet.get(key);
    if (!nf || isAppChunk(of) || of === 'index.html' || /\.(jpe?g|png)$/i.test(of)) continue;
    if (read(oldDir, of).equals(read(newDir, nf))) identical++;
    else differing.push(key);
  }
  checks.push({
    name: 'Other files',
    status: 'info',
    detail:
      `${identical} byte-identical` +
      (differing.length ? `; different: ${differing.join(', ')}` : '') +
      ' (app chunks, index.html and images are checked below; vendor, polyfills and runtime can ' +
      'differ only in module paths, as the old build runs from a worktree)',
  });

  const oldHtml = oldFiles.includes('index.html') ? read(oldDir, 'index.html').toString() : '';
  const newHtml = newFiles.includes('index.html') ? read(newDir, 'index.html').toString() : '';
  const on = nonceCounts(oldHtml);
  const nn = nonceCounts(newHtml);
  const placeholders = (h: string) =>
    [...new Set([...h.matchAll(/\bnonce="([^"]*)"/g)].map((m) => m[1]))].sort().join(' | ');
  checks.push({
    name: 'CSP nonce (index.html)',
    status: on === nn && placeholders(oldHtml) === placeholders(newHtml) ? 'same' : 'differs',
    detail: `tags with a nonce: old ${on}; new ${nn}; value ${placeholders(newHtml) || 'none'}`,
  });

  const om = buildMeta(oldHtml);
  const nm = buildMeta(newHtml);
  checks.push({
    name: 'Build meta (x-build)',
    status: (om?.['commit'] !== undefined) === (nm?.['commit'] !== undefined) ? 'same' : 'differs',
    detail: `commit: old ${om?.['commit'] ? 'yes' : 'no'}, new ${
      nm?.['commit'] ? 'yes' : 'no'
    }; keys old ${om ? Object.keys(om).join(',') : 'none'}, new ${
      nm ? Object.keys(nm).join(',') : 'none'
    }`,
  });

  const chunks = (dir: string, files: string[]) =>
    files.filter(isAppChunk).map((f) => read(dir, f).toString());
  const oldChunks = chunks(oldDir, oldFiles);
  const newChunks = chunks(newDir, newFiles);
  const enc = (texts: string[]) => texts.reduce((n, t) => n + count(t, /ENC\(/g), 0);
  checks.push({
    name: 'Encrypted env values',
    status: enc(oldChunks) === enc(newChunks) ? 'same' : 'differs',
    detail: `ENC(…) values in the app chunks: old ${enc(oldChunks)}, new ${enc(newChunks)}`,
  });

  const names = (texts: string[]) =>
    texts.reduce((n, t) => n + count(t, /_0x[0-9a-f]{4,6}(?![\w$])/g), 0);
  const gz = (texts: string[]) => texts.reduce((n, t) => n + zlib.gzipSync(t).length, 0);
  const on2 = names(oldChunks);
  const nn2 = names(newChunks);
  const close = on2 === 0 ? nn2 === 0 : Math.abs(nn2 - on2) / on2 <= 0.05;
  checks.push({
    name: 'Obfuscation',
    status: close ? 'same' : 'differs',
    detail: `obfuscated names in the app chunks: old ${on2}, new ${nn2}; gzip ${kb(
      gz(oldChunks),
    )} → ${kb(gz(newChunks))}`,
  });

  const oe = exifImages(oldDir, oldFiles);
  const ne = exifImages(newDir, newFiles);
  checks.push({
    name: 'Image metadata',
    status: ne <= oe ? (ne === oe ? 'same' : 'info') : 'differs',
    detail: `images with EXIF: old ${oe}, new ${ne}`,
  });
  return checks;
}

export function renderReport(app: string, base: string, byEnv: Record<string, Check[]>): string {
  const mark = { same: 'same', differs: '**differs**', info: 'note' } as const;
  const lines = [
    `# pstack adopt --compare: ${app}`,
    '',
    `Old build: ${
      /[\\/]/.test(base) ? `\`${base}\`` : `the workspace's own script at \`${base}\``
    }. New build: \`nx run ${app}:release:<env>\`.`,
    '',
  ];
  for (const [env, checks] of Object.entries(byEnv)) {
    lines.push(`## ${env}`, '', '| Check | Result | Detail |', '| --- | --- | --- |');
    for (const c of checks) lines.push(`| ${c.name} | ${mark[c.status]} | ${c.detail} |`);
    lines.push('');
  }
  return lines.join('\n');
}
