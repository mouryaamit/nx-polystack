import * as fs from 'fs';
import * as path from 'path';

import { FoundMeta, findBuildMeta, GEN_PREFIX } from '../../lib/helpers/build-gen';
import { flagBoolean } from '../args';
import { CliError, CommandContext } from '../types';

const TIMEOUT_MS = 15000;

/** index.html of a dist folder (its root, or browser/ for the application builder) or a file. */
function localIndex(target: string): string {
  if (!fs.existsSync(target)) throw new CliError(`inspect: ${target} does not exist.`);
  if (fs.statSync(target).isFile()) return target;
  for (const rel of ['index.html', path.join('browser', 'index.html')]) {
    const file = path.join(target, rel);
    if (fs.existsSync(file)) return file;
  }
  throw new CliError(`inspect: no index.html in ${target} or ${path.join(target, 'browser')}.`);
}

async function fetchPage(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new CliError(`inspect: could not fetch ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new CliError(`inspect: ${url} answered ${res.status} ${res.statusText}.`);
  return res.text();
}

/** The payload as printed: the aes-gcm key share is never shown. */
function safePayload(p: Record<string, unknown>): Record<string, unknown> {
  const out = { ...p };
  if ('k' in out) out['k'] = '(aes-gcm key share, not shown)';
  return out;
}

function describe(meta: FoundMeta): string[] {
  const p = meta.payload;
  const gen = typeof p['gen'] === 'string' ? p['gen'] : undefined;
  const lines: string[] = [];
  if (gen?.startsWith(GEN_PREFIX)) {
    const versions = [
      typeof p['ng'] === 'string' ? `Angular ${p['ng']}` : undefined,
      typeof p['nx'] === 'string' ? `Nx ${p['nx']}` : undefined,
    ].filter(Boolean);
    lines.push(`Built by pstack: ${gen}${versions.length ? ` (${versions.join(', ')})` : ''}`);
  } else {
    lines.push(
      'pstack build meta without the tool fields: built by pstack before 1.2.8, or with ' +
        'buildMeta.gen set to false.',
    );
  }
  lines.push(`  meta:      <meta name="${meta.name}">`);
  const row = (label: string, key: string) => {
    if (p[key] !== undefined && p[key] !== '')
      lines.push(`  ${label.padEnd(10)} ${String(p[key])}`);
  };
  row('env:', 'env');
  row('built:', 'timestamp_utc');
  row('built IST:', 'timestamp_ist');
  row('branch:', 'branch');
  row('commit:', 'commit');
  row('build:', 'build');
  if ('k' in p) lines.push('  cipher:    aes-gcm (key share in the meta, not shown)');
  return lines;
}

/** pstack inspect <dist folder | index.html | URL> [--json] */
export async function runInspect(ctx: CommandContext): Promise<number> {
  const target = ctx.positionals[0];
  if (!target) {
    throw new CliError(
      'inspect: give a dist folder, an index.html or a URL, e.g. pstack inspect dist/apps/web',
    );
  }
  const isUrl = /^https?:\/\//i.test(target);
  const source = isUrl ? target : localIndex(path.resolve(ctx.cwd, target));
  const html = isUrl ? await fetchPage(target) : fs.readFileSync(source, 'utf8');
  const metas = findBuildMeta(html);
  const nonce = /<meta\b[^>]*property\s*=\s*["']csp-nonce["']/i.test(html);

  if (flagBoolean(ctx.flags, 'json')) {
    console.log(
      JSON.stringify(
        {
          source,
          pstack: metas.some((m) => String(m.payload['gen'] ?? '').startsWith(GEN_PREFIX)),
          buildMeta: metas.map((m) => ({ name: m.name, payload: safePayload(m.payload) })),
          cspNonceMeta: nonce,
        },
        null,
        2,
      ),
    );
    return metas.length > 0 ? 0 : 1;
  }

  console.log(`Inspecting ${source}`);
  if (metas.length === 0) {
    console.log(
      'No pstack build meta found: not built by a pstack release build, or the meta was removed.',
    );
    return 1;
  }
  for (const m of metas) console.log(describe(m).join('\n'));
  if (nonce) console.log('  csp nonce: <meta property="csp-nonce"> present (secure build)');
  return 0;
}
