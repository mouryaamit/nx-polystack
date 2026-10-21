import * as fs from 'fs';

import type { GenInfo } from './build-gen';

export interface InjectMetaOptions {
  indexHtmlPath: string;
  env: string;
  branch: string;
  commit: string;
  buildNumber: string;
  /** Meta tag name (default x-build). */
  metaName?: string;
  /** Build time (default now); the aes-gcm key uses the same instant. */
  now?: Date;
  /** Extra payload fields (aes-gcm key share `k`). */
  extra?: Record<string, string>;
  /** Tool and versions that made the build (gen, ng, nx); omitted when undefined. */
  gen?: GenInfo;
}

export function injectBuildMeta(opts: InjectMetaOptions): void {
  const { indexHtmlPath, env, branch, commit, buildNumber } = opts;
  const metaName = opts.metaName ?? 'x-build';
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`injectBuildMeta: index.html not found: ${indexHtmlPath}`);
  }

  const now = opts.now ?? new Date();
  const istFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // Extra fields first: they never replace the built-in ones.
  const payload = {
    ...(opts.extra ?? {}),
    env,
    timestamp_utc: now.toISOString(),
    timestamp_ist: istFormatter.format(now),
    branch,
    commit,
    build: buildNumber,
    ...(opts.gen ?? {}),
  };

  const base64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const tag = `<meta name="${metaName}" content="${base64}">`;
  const existing = new RegExp(
    `<meta name="${metaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`,
  );

  let html = fs.readFileSync(indexHtmlPath, 'utf8');
  if (existing.test(html)) {
    html = html.replace(existing, tag);
  } else if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>\n  ${tag}`);
  } else {
    html = tag + '\n' + html;
  }

  fs.writeFileSync(indexHtmlPath, html, 'utf8');
}
