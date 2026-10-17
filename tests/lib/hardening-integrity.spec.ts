import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  hasWebpackSriRuntime,
  recordHashes,
  sha384Integrity,
  swapHashes,
} from '../../src/lib/hardening/integrity';

const integrityOf = (text: string) =>
  `sha384-${crypto.createHash('sha384').update(text).digest('base64')}`;

describe('integrity helpers', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-int-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('sha384Integrity matches the SRI format', () => {
    expect(sha384Integrity(Buffer.from('abc'))).toBe(integrityOf('abc'));
  });

  it('recordHashes covers js, mjs and css outside assets/', () => {
    write('main.js', 'a');
    write('chunk.mjs', 'b');
    write('styles.css', 'c');
    write('index.html', 'd');
    write('assets/x.js', 'e');
    const hashes = recordHashes(root);
    expect([...hashes.keys()].sort()).toEqual(['chunk.mjs', 'main.js', 'styles.css']);
    expect(hashes.get('main.js')).toBe(integrityOf('a'));
  });

  it('swaps the hash of a rewritten lazy chunk inside the runtime', () => {
    write('123.abc.js', 'lazy-original');
    write('runtime.abc.js', `r.sriHashes={123:"${integrityOf('lazy-original')}"};`);
    const before = recordHashes(root);
    write('123.abc.js', 'lazy-rewritten');

    const result = swapHashes(root, before);

    expect(read('runtime.abc.js')).toBe(`r.sriHashes={123:"${integrityOf('lazy-rewritten')}"};`);
    expect(result.swapped).toBe(1);
  });

  it('follows a chain: a file whose hash is referenced elsewhere and that itself changes by the swap', () => {
    write('a.js', 'A0');
    write('b.js', `ref("${integrityOf('A0')}")`);
    write('c.js', `ref("${integrityOf(`ref("${integrityOf('A0')}")`)}")`);
    const before = recordHashes(root);
    write('a.js', 'A1');

    const result = swapHashes(root, before);

    const b = `ref("${integrityOf('A1')}")`;
    expect(read('b.js')).toBe(b);
    expect(read('c.js')).toBe(`ref("${integrityOf(b)}")`);
    expect(result.rounds).toBeGreaterThanOrEqual(2);
  });

  it('does nothing when no file changed', () => {
    write('main.js', 'x');
    const before = recordHashes(root);
    expect(swapHashes(root, before)).toEqual({ swapped: 0, rounds: 1 });
  });

  it('fails when hashes reference each other in a cycle', () => {
    // a.js and b.js each hold the other's hash: every swap changes the other file again.
    write('a.js', 'A');
    write('b.js', `x("${integrityOf('A')}")`);
    const bHash = integrityOf(`x("${integrityOf('A')}")`);
    write('a.js', `y("${bHash}")`);
    const before = new Map([
      ['a.js', integrityOf('A')],
      ['b.js', bHash],
    ]);
    expect(() => swapHashes(root, before)).toThrow(/did not settle/);
  });

  it('fails when the runtime holds a hash that matches no file', () => {
    write('1.js', 'one');
    write('runtime.js', `o.sriHashes={1:"${integrityOf('something else')}"}`);
    const before = recordHashes(root);
    expect(() => swapHashes(root, before)).toThrow(/match no output file in runtime\.js \(1\)/);
  });

  it('hasWebpackSriRuntime spots the webpack runtime with sriHashes', () => {
    write('main.js', 'x');
    expect(hasWebpackSriRuntime(root)).toBe(false);
    write('runtime.js', 'o.sriHashes={}');
    expect(hasWebpackSriRuntime(root)).toBe(true);
  });
});
