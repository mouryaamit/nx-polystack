import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { listFiles } from './files';

const SKIP_DIRS = ['assets'];
/** Rounds of swapping after which hashes that keep changing each other fail the build. */
const MAX_ROUNDS = 5;

export function sha384Integrity(buf: Buffer | string): string {
  return `sha384-${crypto.createHash('sha384').update(buf).digest('base64')}`;
}

/** Integrity of every JS/CSS file under the served root (assets/ skipped), keyed by relative path. */
export function recordHashes(served: string): Map<string, string> {
  const root = path.resolve(served);
  const hashes = new Map<string, string>();
  for (const file of listFiles(root, ['js', 'mjs', 'css'], { skipDirs: SKIP_DIRS })) {
    hashes.set(path.relative(root, file), sha384Integrity(fs.readFileSync(file)));
  }
  return hashes;
}

export interface SwapResult {
  /** Hash values replaced in at least one file. */
  swapped: number;
  /** Rounds run, the last one finding nothing to do. */
  rounds: number;
}

/**
 * After strip/obfuscate: every recorded hash of a file that changed is replaced by its new value
 * inside the JS (the webpack runtime holds the lazy chunks' hashes). A file changed by the swap is
 * hashed again and swapped in turn, until nothing changes.
 */
export function swapHashes(served: string, before: Map<string, string>): SwapResult {
  const root = path.resolve(served);
  const referenced = new Map(before);
  const replaced = new Set<string>();
  let swapped = 0;

  for (let round = 1; ; round++) {
    const current = recordHashes(root);
    const changed = [...referenced].filter(
      ([rel, value]) => current.has(rel) && current.get(rel) !== value,
    );
    if (changed.length === 0) {
      assertNoOldHashes(root, replaced);
      verifyRuntimeHashes(root);
      return { swapped, rounds: round };
    }
    if (round > MAX_ROUNDS) {
      throw new Error(
        `SRI hashes did not settle after ${MAX_ROUNDS} rounds; files that keep changing: ` +
          changed.map(([rel]) => rel).join(', '),
      );
    }
    const jsFiles = listFiles(root, ['js', 'mjs'], { skipDirs: SKIP_DIRS });
    const texts = new Map(jsFiles.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    for (const [rel, oldValue] of changed) {
      const newValue = current.get(rel) as string;
      let found = false;
      for (const [file, text] of texts) {
        if (!text.includes(oldValue)) continue;
        texts.set(file, text.split(oldValue).join(newValue));
        found = true;
      }
      if (found) {
        swapped++;
        replaced.add(oldValue);
      }
      referenced.set(rel, newValue);
    }
    for (const file of jsFiles) {
      const text = texts.get(file) as string;
      if (text !== fs.readFileSync(file, 'utf8')) fs.writeFileSync(file, text);
    }
  }
}

const SHA384_TOKEN = /sha384-[A-Za-z0-9+/]{64}/g;

/**
 * Every sha384 value in a file holding webpack's sriHashes must be the hash of a served file:
 * a value that matches nothing would make the browser refuse that chunk.
 */
export function verifyRuntimeHashes(served: string): void {
  const root = path.resolve(served);
  const current = new Set(recordHashes(root).values());
  const bad: string[] = [];
  for (const file of listFiles(root, ['js', 'mjs'], { skipDirs: SKIP_DIRS })) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('sriHashes')) continue;
    const stale = (text.match(SHA384_TOKEN) ?? []).filter((t) => !current.has(t));
    if (stale.length > 0) bad.push(`${path.relative(root, file)} (${stale.length})`);
  }
  if (bad.length > 0) {
    throw new Error(
      `SRI: chunk hashes that match no output file in ${bad.join(', ')}; the browser would ` +
        'refuse those chunks',
    );
  }
}

function assertNoOldHashes(root: string, replaced: Set<string>): void {
  if (replaced.size === 0) return;
  const left = listFiles(root, ['js', 'mjs'], { skipDirs: SKIP_DIRS }).filter((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return [...replaced].some((v) => text.includes(v));
  });
  if (left.length > 0) {
    throw new Error(
      `SRI: replaced hashes still present in ${left.map((f) => path.relative(root, f)).join(', ')}`,
    );
  }
}

/** Whether the build has a webpack runtime with per-chunk SRI hashes. */
export function hasWebpackSriRuntime(served: string): boolean {
  return listFiles(path.resolve(served), ['js', 'mjs'], { skipDirs: SKIP_DIRS }).some((f) =>
    fs.readFileSync(f, 'utf8').includes('sriHashes'),
  );
}
