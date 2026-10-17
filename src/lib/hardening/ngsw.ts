import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface NgswManifest {
  index?: string;
  hashTable?: Record<string, string>;
}

/**
 * Recomputes the Angular service worker's hashTable (sha1 hex) for files under the served root, so
 * rewritten files (strip, obfuscate, SRI, meta, nonce) are not rejected. Keys are URLs below the
 * directory of the manifest's index URL; entries without a file are left alone. Returns the number
 * of entries updated; ngsw.json is only written when one changed.
 */
export function refreshNgswHashes(served: string): number {
  const root = path.resolve(served);
  const file = path.join(root, 'ngsw.json');
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(text) as NgswManifest;
  const table = manifest.hashTable;
  if (!table) return 0;

  const index = manifest.index ?? '/index.html';
  const base = index.slice(0, index.lastIndexOf('/') + 1) || '/';
  let updated = 0;
  for (const url of Object.keys(table)) {
    if (!url.startsWith(base)) continue;
    let rel: string;
    try {
      rel = decodeURIComponent(url.slice(base.length).split(/[?#]/)[0]);
    } catch {
      continue;
    }
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) continue;
    if (!fs.statSync(target).isFile()) continue;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(target)).digest('hex');
    if (table[url] !== hash) {
      table[url] = hash;
      updated++;
    }
  }
  if (updated > 0) {
    const trailing = text.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + trailing);
  }
  return updated;
}
