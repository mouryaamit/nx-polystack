#!/usr/bin/env node
/**
 * scripts/build.js
 *
 * Compiles @mouryaamit/nx-polystack into dist/ so it can be consumed as an
 * installed package (npm registry, git URL, or local file: link).
 *
 *   dist/src/**            compiled JS + .d.ts, plus schemas and generator templates
 *   dist/bin/cli.js        `pstack` CLI (shebang ensured, chmod 755)
 *   dist/*.json            generators/executors/migrations manifests ("./src/..." paths resolve inside dist)
 *
 * Runs automatically on `npm install` of a git dependency via the `prepare` script.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MANIFESTS = ['generators.json', 'executors.json', 'migrations.json'];

// ── 1. Clean ────────────────────────────────────────────────────────────────
fs.rmSync(DIST, { recursive: true, force: true });

// ── 2. Compile ──────────────────────────────────────────────────────────────
console.log('▶  Compiling TypeScript...');
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.lib.json'], {
  stdio: 'inherit',
  cwd: ROOT,
});

// ── 3. Copy assets (schemas, templates, hand-written .d.ts) ──────────────────
// Everything under a generator's files/ dir is a template and is copied verbatim.
copyAssets(path.join(ROOT, 'src'), path.join(DIST, 'src'));
for (const file of MANIFESTS) {
  fs.copyFileSync(path.join(ROOT, file), path.join(DIST, file));
}

// ── 4. CLI shebang ──────────────────────────────────────────────────────────
// TypeScript strips shebang lines during compilation; add it back here.
const cliBin = path.join(DIST, 'bin', 'cli.js');
let cli = fs.readFileSync(cliBin, 'utf8');
if (!cli.startsWith('#!/usr/bin/env node')) {
  cli = '#!/usr/bin/env node\n' + cli;
  fs.writeFileSync(cliBin, cli, 'utf8');
}
fs.chmodSync(cliBin, 0o755);

// ── 5. CommonJS copies of runtime ES modules (for Jest and other require() users) ────
const ts = require('typescript');
fs.mkdirSync(path.join(DIST, 'runtime'), { recursive: true });
for (const name of fs.readdirSync(path.join(ROOT, 'runtime')).filter((f) => f.endsWith('.mjs'))) {
  const source = fs.readFileSync(path.join(ROOT, 'runtime', name), 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true,
    },
  }).outputText;
  fs.writeFileSync(path.join(DIST, 'runtime', name.replace(/\.mjs$/, '.cjs')), out, 'utf8');
}

console.log('✔  Build complete → dist/');

function copyAssets(src, dest, inTemplates = false) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyAssets(srcPath, destPath, inTemplates || entry.name === 'files');
      continue;
    }
    const isSource = entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts');
    if (inTemplates || !isSource) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
