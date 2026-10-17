import { webcrypto } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../runtime/env-secret.mjs'), 'utf8');

export type Runtime = {
  getBuildMeta(name?: string): Record<string, unknown> | null;
  isEncryptedValue(v: unknown): boolean;
  decryptEnvValue(v: string, commit?: string | null): string;
  decryptTree(o: object, commit?: string | null): string[];
  envReadySync(env: object, opts?: Record<string, unknown>): string[];
  envReady(env: object, opts?: Record<string, unknown>): Promise<string[]>;
  envSecret(key: string): string;
  envSecretAsync(key: string): Promise<string>;
  isHostAllowed(host: string, hosts: string[], www: boolean): boolean;
  decryptTreeAsync(obj: object): Promise<string[]>;
};

export interface LoadExtra {
  hostname?: string;
  protocol?: string;
  fetch?: (
    url: string,
    init?: unknown,
  ) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
  console?: Partial<Console>;
  /** The page's `crypto` (default Node's webcrypto); pass undefined for a page without it. */
  crypto?: unknown;
  /**
   * <script src> elements on the page: an integrity value (null: none) for a same-origin script
   * (main.js), or { src, integrity }. Default: no scripts.
   */
  scripts?: (string | null | { src: string; integrity: string | null })[];
}

/**
 * atob as strict as a browser about the alphabet, and stricter about padding (length must be a
 * multiple of 4), so the runtime's base64url decoder has to pad what Node writes unpadded.
 */
export function strictAtob(s: string): string {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new Error('InvalidCharacterError');
  }
  return Buffer.from(s, 'base64').toString('binary');
}

/** Loads a fresh copy of the ES module (transpiled to CommonJS) with fake browser globals. */
export function load(
  meta: Record<string, unknown> | null,
  metaName = 'x-build',
  extra: LoadExtra = {},
): Runtime {
  const js = ts.transpileModule(SOURCE, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const content = meta ? Buffer.from(JSON.stringify(meta)).toString('base64') : null;
  const document = {
    baseURI: 'https://app.example.com/portal/',
    querySelector: (sel: string) =>
      sel === `meta[name="${metaName}"]` && content ? { getAttribute: () => content } : null,
    querySelectorAll: (sel: string) =>
      sel === 'script[src]'
        ? (extra.scripts ?? []).map((entry) => {
            const s =
              entry !== null && typeof entry === 'object'
                ? entry
                : { src: 'main.js', integrity: entry };
            return {
              getAttribute: (name: string) =>
                name === 'integrity' ? s.integrity : name === 'src' ? s.src : null,
            };
          })
        : [],
  };
  const location = {
    hostname: extra.hostname ?? 'localhost',
    protocol: extra.protocol ?? 'https:',
    origin: 'https://app.example.com',
  };
  const mod = { exports: {} as Runtime };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    'exports',
    'require',
    'module',
    'document',
    'atob',
    'console',
    'location',
    'fetch',
    'crypto',
    'TextEncoder',
    'TextDecoder',
    js,
  )(
    mod.exports,
    (id: string) => require(id),
    mod,
    document,
    strictAtob,
    { warn: jest.fn(), error: jest.fn(), ...(extra.console ?? {}) },
    location,
    extra.fetch ?? (() => Promise.reject(new Error('no fetch'))),
    'crypto' in extra ? extra.crypto : webcrypto,
    TextEncoder,
    TextDecoder,
  );
  return mod.exports;
}
