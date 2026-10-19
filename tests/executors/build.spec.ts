import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import buildExecutor, { Runner } from '../../src/executors/build/executor';
import { BuildExecutorSchema } from '../../src/executors/build/schema.d';
import {
  combineShares,
  decodePstack,
  decryptGcm,
  deriveKey,
  factorText,
  keyInfo,
} from '../../src/lib/env-encryption/gcm';

// terser is a workspace devDependency, not bundled: tests that strip JS need it installed.
let hasTerser = true;
try {
  require.resolve('terser', { paths: [path.resolve(__dirname, '../..')] });
} catch {
  hasTerser = false;
}
const withTerser = hasTerser ? describe : describe.skip;

const makeContext = (projectName: string, root: string): ExecutorContext =>
  ({ projectName, root, isVerbose: false } as unknown as ExecutorContext);

describe('buildExecutor', () => {
  let tmpDir: string;
  let runner: jest.MockedFunction<Runner>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-build-'));
    fs.mkdirSync(path.join(tmpDir, 'tools', 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'tools', 'config', 'encrypt-keys.json'),
      JSON.stringify({ _default: ['password', 'key'], web: ['password', 'key'] }),
    );
    runner = jest.fn();
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const ctxFor = (project: string, target: string): ExecutorContext =>
    ({
      projectName: project,
      targetName: target,
      root: tmpDir,
      isVerbose: false,
    } as unknown as ExecutorContext);

  it('DEV build — calls nx build:development, skips encrypt and backup', async () => {
    const envDir = path.join(tmpDir, 'environments', 'web');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(
      path.join(envDir, 'environment.ts'),
      'export const environment = { production: false };',
    );

    const ctx = makeContext('web', tmpDir);
    const result = await buildExecutor(
      { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'DEV' },
      ctx,
      runner,
    );

    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('nx run web:build:development'),
      expect.any(Object),
    );
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('--outputPath=dist/apps/web'),
      expect.any(Object),
    );
    // No backup created for DEV
    expect(fs.existsSync(path.join(envDir, 'environment.ts.bak'))).toBe(false);
  });

  it('PROD build — encrypts env file, calls nx build:production, restores env file', async () => {
    const envDir = path.join(tmpDir, 'environments', 'web');
    fs.mkdirSync(envDir, { recursive: true });
    const originalContent = "export const environment = { production: true, password: 'secret' };";
    fs.writeFileSync(path.join(envDir, 'environment.prod.ts'), originalContent);

    const ctx = makeContext('web', tmpDir);
    const result = await buildExecutor(
      { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'PROD' },
      ctx,
      runner,
    );

    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('nx run web:build:production'),
      expect.any(Object),
    );
    // Env file restored to original content after build
    const restoredContent = fs.readFileSync(path.join(envDir, 'environment.prod.ts'), 'utf8');
    expect(restoredContent).toBe(originalContent);
    // Backup cleaned up
    expect(fs.existsSync(path.join(envDir, 'environment.prod.ts.bak'))).toBe(false);
  });

  it('UAT build — encrypts during the build with nx.json settings, skips the Nx cache, restores', async () => {
    fs.rmSync(path.join(tmpDir, 'tools'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'nx.json'),
      JSON.stringify({
        pstack: { envEncryption: { mode: 'all', metaName: 'x-app-build' } },
      }),
    );
    const envDir = path.join(tmpDir, 'environments', 'web');
    fs.mkdirSync(envDir, { recursive: true });
    const original =
      "export const environment = { production: true, apiUrl: 'https://api', token: '${TOKEN}' };";
    fs.writeFileSync(path.join(envDir, 'environment.uat.ts'), original);
    const distDir = path.join(tmpDir, 'dist', 'apps', 'web');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html><head></head><body></body></html>');
    process.env['TOKEN'] = 'tok-123';
    let during = '';
    runner.mockImplementation(() => {
      during = fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8');
    });
    try {
      await buildExecutor(
        { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'UAT' },
        makeContext('web', tmpDir),
        runner,
      );
    } finally {
      delete process.env['TOKEN'];
    }
    expect(runner).toHaveBeenCalledWith(
      expect.stringMatching(/nx run web:build:uat .*--skip-nx-cache$/),
      expect.any(Object),
    );
    expect(during).not.toContain('https://api');
    expect(during).not.toContain('tok-123');
    expect(fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8')).toBe(original);
    expect(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')).toContain(
      '<meta name="x-app-build"',
    );
  });

  it('UAT build — restores the env file when the Angular build fails', async () => {
    const envDir = path.join(tmpDir, 'environments', 'web');
    fs.mkdirSync(envDir, { recursive: true });
    const original = "export const environment = { password: 'secret' };";
    fs.writeFileSync(path.join(envDir, 'environment.uat.ts'), original);
    runner.mockImplementation(() => {
      throw new Error('ng build failed');
    });
    await expect(
      buildExecutor(
        { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'UAT' },
        makeContext('web', tmpDir),
        runner,
      ),
    ).rejects.toThrow('ng build failed');
    expect(fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8')).toBe(original);
  });

  it('DEV build — refuses placeholders in the dev env file before building', async () => {
    const envDir = path.join(tmpDir, 'environments', 'web');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(
      path.join(envDir, 'environment.ts'),
      "export const environment = { password: '${DEV_PASS}' };",
    );
    await expect(
      buildExecutor(
        { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'DEV' },
        makeContext('web', tmpDir),
        runner,
      ),
    ).rejects.toThrow(/dev env files must hold literal values/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it('secure: true — injects CSP nonce after build', async () => {
    const distDir = path.join(tmpDir, 'dist', 'apps', 'web');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'index.html'),
      '<html><head></head><body><script src="main.js"></script></body></html>',
    );

    const ctx = makeContext('web', tmpDir);
    const result = await buildExecutor(
      { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'DEV', secure: true },
      ctx,
      runner,
    );

    expect(result.success).toBe(true);
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    expect(html).toContain('nonce=');
  });

  it.each(['DEV', 'UAT', 'PROD'])(
    '%s build strips EXIF and leaves images without EXIF byte-identical',
    async (env) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
      const sharp = require('sharp') as any;
      const envDir = path.join(tmpDir, 'environments', 'web');
      fs.mkdirSync(envDir, { recursive: true });
      const file = env === 'DEV' ? 'environment.ts' : `environment.${env.toLowerCase()}.ts`;
      fs.writeFileSync(
        path.join(envDir, file),
        'export const environment = { production: false };',
      );
      const distDir = path.join(tmpDir, 'dist', 'apps', 'web', 'assets');
      fs.mkdirSync(distDir, { recursive: true });
      const img = () =>
        sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } });
      const plain = await img().png().toBuffer();
      fs.writeFileSync(path.join(distDir, 'plain.png'), plain);
      fs.writeFileSync(
        path.join(distDir, 'photo.jpg'),
        await img()
          .withExif({ IFD0: { Make: 'T' } })
          .jpeg()
          .toBuffer(),
      );
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const result = await buildExecutor(
          { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env },
          makeContext('web', tmpDir),
          runner,
        );
        expect(result.success).toBe(true);
        expect(log.mock.calls.flat().join('\n')).toContain(
          'strip-exif: 2 scanned, 1 stripped, 1 unchanged, 0 skipped',
        );
      } finally {
        log.mockRestore();
      }
      expect(fs.readFileSync(path.join(distDir, 'plain.png')).equals(plain)).toBe(true);
      const meta = await sharp(fs.readFileSync(path.join(distDir, 'photo.jpg'))).metadata();
      expect(meta.exif).toBeUndefined();
    },
  );

  it('secure: only the served index.html changes; assets/ pages stay byte-identical', async () => {
    const distDir = path.join(tmpDir, 'dist', 'apps', 'web');
    const pages: Record<string, string> = {
      'assets/inline-locale-files/de.html': '<script type="application/l10n">{"k":"v"}</script>',
      'assets/fonts/demo.html': '<html><head><style>a{}</style></head></html>',
      'assets/togetherjs/x.html': '<script src="t.js"></script>',
    };
    for (const [rel, text] of Object.entries(pages)) {
      fs.mkdirSync(path.dirname(path.join(distDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(distDir, rel), text);
    }
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html><head></head><body></body></html>');
    const result = await buildExecutor(
      { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'DEV', secure: true },
      makeContext('web', tmpDir),
      runner,
    );
    expect(result.success).toBe(true);
    for (const [rel, text] of Object.entries(pages)) {
      expect(fs.readFileSync(path.join(distDir, rel), 'utf8')).toBe(text);
    }
    expect(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')).toContain('csp-nonce');
  });

  it('secure with legacy nonce settings and stripHtmlComments (DEV too)', async () => {
    const distDir = path.join(tmpDir, 'dist', 'apps', 'web');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'index.html'),
      '<html><head><!-- note --><link rel="icon" href="f.ico">' +
        '<meta name="CSP-NONCE" content="random-csp-nonce"></head>' +
        '<body><script src="main.js"></script><script>go()</script></body></html>',
    );
    const P = "<!--#echo var='UNIQUE_ID' -->";
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'DEV',
        secure: true,
        stripHtmlComments: true,
        nonce: {
          placeholder: P,
          tags: 'legacy',
          position: 'after-tag-name',
          replaceTokens: ['random-csp-nonce'],
          addMeta: false,
        },
      },
      makeContext('web', tmpDir),
      runner,
    );
    const html = fs
      .readFileSync(path.join(distDir, 'index.html'), 'utf8')
      .replace(/\n\s*<meta name="x-build"[^>]*>/, ''); // the build meta is the intended difference
    expect(html).toBe(
      `<html><head><link nonce="${P}" rel="icon" href="f.ico">` +
        `<meta name="CSP-NONCE" content="${P}"></head>` +
        `<body><script src="main.js"></script><script nonce="${P}">go()</script></body></html>`,
    );
  });

  it('rejects invalid nonce options before building', async () => {
    await expect(
      buildExecutor(
        {
          type: 'angular',
          outputPath: 'dist/apps/web',
          envProject: 'web',
          env: 'DEV',
          nonce: { tags: 'some' as 'all' },
        },
        makeContext('web', tmpDir),
        runner,
      ),
    ).rejects.toThrow(/nonce.tags/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('sri: true — injects SRI hashes after build', async () => {
    const distDir = path.join(tmpDir, 'dist', 'apps', 'web');
    fs.mkdirSync(distDir, { recursive: true });
    const scriptContent = 'console.log("hello")';
    fs.writeFileSync(path.join(distDir, 'main.js'), scriptContent);
    fs.writeFileSync(
      path.join(distDir, 'index.html'),
      '<html><head></head><body><script src="main.js"></script></body></html>',
    );

    const ctx = makeContext('web', tmpDir);
    const result = await buildExecutor(
      { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'DEV', sri: true },
      ctx,
      runner,
    );

    expect(result.success).toBe(true);
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    expect(html).toContain('integrity="sha384-');
  });

  it('missing env file — encrypt skipped silently, runner still called', async () => {
    // No env file created
    const ctx = makeContext('web', tmpDir);
    const result = await buildExecutor(
      { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'PROD' },
      ctx,
      runner,
    );

    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('nx run web:build:production'),
      expect.any(Object),
    );
  });

  it('env missing at runtime — throws descriptive error', async () => {
    const ctx = makeContext('web', tmpDir);
    await expect(
      buildExecutor(
        { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web' },
        ctx,
        runner,
      ),
    ).rejects.toThrow(/env.*required/i);
  });

  it('build failure — env file restored in finally block', async () => {
    const envDir = path.join(tmpDir, 'environments', 'web');
    fs.mkdirSync(envDir, { recursive: true });
    const originalContent = "export const environment = { production: true, password: 'secret' };";
    fs.writeFileSync(path.join(envDir, 'environment.prod.ts'), originalContent);

    const failingRunner: Runner = jest.fn().mockImplementation(() => {
      throw new Error('Angular build failed');
    });

    const ctx = makeContext('web', tmpDir);
    await expect(
      buildExecutor(
        { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'PROD' },
        ctx,
        failingRunner,
      ),
    ).rejects.toThrow('Angular build failed');

    // Env file must be restored even after build failure
    const restoredContent = fs.readFileSync(path.join(envDir, 'environment.prod.ts'), 'utf8');
    expect(restoredContent).toBe(originalContent);
    expect(fs.existsSync(path.join(envDir, 'environment.prod.ts.bak'))).toBe(false);
  });

  it('runs the given buildTarget with buildConfiguration', async () => {
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'UAT',
        buildTarget: 'web:build',
        buildConfiguration: 'uat',
      },
      ctxFor('web', 'release'),
      runner,
    );
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('nx run web:build:uat --outputPath=dist/apps/web'),
      expect.any(Object),
    );
  });

  it('falls back to the env → configuration mapping when buildConfiguration is unset', async () => {
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'PROD',
        buildTarget: 'web:build',
      },
      ctxFor('web', 'release'),
      runner,
    );
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('nx run web:build:production'),
      expect.any(Object),
    );
  });

  it('refuses a buildTarget that points at itself', async () => {
    await expect(
      buildExecutor(
        { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'PROD' },
        ctxFor('web', 'build'),
        runner,
      ),
    ).rejects.toThrow(/points at this target.*pstack update/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('supports a custom env such as QA (environment.qa.ts)', async () => {
    const envDir = path.join(tmpDir, 'environments', 'web');
    fs.mkdirSync(envDir, { recursive: true });
    const original = "export const environment = { password: 'secret' };";
    fs.writeFileSync(path.join(envDir, 'environment.qa.ts'), original);
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'QA',
        buildTarget: 'web:build',
        buildConfiguration: 'qa',
      },
      ctxFor('web', 'release'),
      runner,
    );
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('nx run web:build:qa'),
      expect.any(Object),
    );
    expect(fs.readFileSync(path.join(envDir, 'environment.qa.ts'), 'utf8')).toBe(original);
  });

  it.each(['web', 'web:', ':build', 'a:b:c'])('rejects malformed buildTarget "%s"', async (bt) => {
    await expect(
      buildExecutor(
        {
          type: 'angular',
          outputPath: 'dist/apps/web',
          envProject: 'web',
          env: 'PROD',
          buildTarget: bt,
        },
        ctxFor('web', 'release'),
        runner,
      ),
    ).rejects.toThrow(/buildTarget.*<project>:<target>/);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('buildExecutor aes-gcm', () => {
  let tmpDir: string;
  let runner: jest.MockedFunction<Runner>;
  let envDir: string;
  let dist: string;
  let builtEnv: string;
  const savedCommit = process.env['GIT_COMMIT'];

  const ctx = (): ExecutorContext =>
    ({
      projectName: 'web',
      targetName: 'release',
      root: tmpDir,
      isVerbose: false,
    } as unknown as ExecutorContext);
  const writeConfig = (envEncryption: object) =>
    fs.writeFileSync(path.join(tmpDir, 'nx.json'), JSON.stringify({ pstack: { envEncryption } }));
  const readMeta = () => {
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    return JSON.parse(Buffer.from(/content="([^"]+)"/.exec(html)![1], 'base64').toString());
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-build-gcm-'));
    envDir = path.join(tmpDir, 'environments', 'web');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(
      path.join(envDir, 'environment.uat.ts'),
      "export const environment = { password: 'p' };",
    );
    dist = path.join(tmpDir, 'dist/apps/web');
    builtEnv = '';
    runner = jest.fn<void, Parameters<Runner>>(() => {
      builtEnv = fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8');
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, 'index.html'), '<html><head></head><body></body></html>');
    });
    process.env['GIT_COMMIT'] = 'abc1234';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (savedCommit === undefined) delete process.env['GIT_COMMIT'];
    else process.env['GIT_COMMIT'] = savedCommit;
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('meta carries the key share and build time; meta-bundle-asset writes the asset', async () => {
    writeConfig({ mode: 'all', cipher: 'aes-gcm' });
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'UAT',
        keySplit: 'meta-bundle-asset',
      },
      ctx(),
      runner,
    );
    const meta = readMeta();
    expect(meta.k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(meta.timestamp_utc).toMatch(/Z$/);
    const assets = fs.readdirSync(path.join(dist, 'assets'));
    expect(assets).toEqual([expect.stringMatching(/^pstack-k\.[0-9a-f]{8}\.bin$/)]);

    // The meta share, bundle share, asset and meta time rebuild the key that sealed the value.
    const field = decodePstack(/__pstack: '([^']+)'/.exec(builtEnv)![1]);
    expect(field.a).toBe(assets[0]);
    const r = combineShares([
      Buffer.from(meta.k, 'base64url'),
      Buffer.from(field.b, 'base64url'),
      fs.readFileSync(path.join(dist, 'assets', assets[0])),
    ]);
    const key = deriveKey(
      r,
      factorText(field.s, field.f),
      meta.timestamp_utc,
      keyInfo('web', 'UAT'),
    );
    const sealed = /password: '(ENC2\([^']+\))'/.exec(builtEnv)![1];
    expect(decryptGcm(key, sealed, 'password')).toBe('p');
  });

  it('sri lists third-party scripts the runtime check leaves to the CSP', async () => {
    writeConfig({ cipher: 'aes-gcm', keys: { web: ['password'] } });
    runner.mockImplementation(() => {
      builtEnv = fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8');
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(
        path.join(dist, 'index.html'),
        '<html><head><script async src="https://www.googletagmanager.com/gtm.js?id=X"></script>' +
          '<script src="//cdn.example.net/chat.js"></script></head><body></body></html>',
      );
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await buildExecutor(
      { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'UAT', sri: true },
      ctx(),
      runner,
    );
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain(
      'third-party scripts without integrity (www.googletagmanager.com, cdn.example.net)',
    );
  });

  it('meta-bundle writes no asset; domains reach __pstack', async () => {
    writeConfig({ mode: 'all', cipher: 'aes-gcm' });
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'UAT',
        domains: ['App.Example.com'],
        includeWww: false,
        onMismatch: 'warn',
      },
      ctx(),
      runner,
    );
    expect(readMeta().k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.existsSync(path.join(dist, 'assets'))).toBe(false);
    const field = decodePstack(/__pstack: '([^']+)'/.exec(builtEnv)![1]);
    expect(field.a).toBeUndefined();
    expect(field.d).toEqual({ h: ['app.example.com'], w: false, m: 'warn' });
  });

  it('application builder layout: meta and asset go to <outputPath>/browser', async () => {
    writeConfig({ mode: 'all', cipher: 'aes-gcm' });
    runner.mockImplementation(() => {
      fs.mkdirSync(path.join(dist, 'browser'), { recursive: true });
      fs.writeFileSync(
        path.join(dist, 'browser', 'index.html'),
        '<html><head></head><body></body></html>',
      );
    });
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'UAT',
        keySplit: 'meta-bundle-asset',
      },
      ctx(),
      runner,
    );
    const html = fs.readFileSync(path.join(dist, 'browser', 'index.html'), 'utf8');
    const meta = JSON.parse(Buffer.from(/content="([^"]+)"/.exec(html)![1], 'base64').toString());
    expect(meta.k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.readdirSync(path.join(dist, 'browser', 'assets'))).toEqual([
      expect.stringMatching(/^pstack-k\.[0-9a-f]{8}\.bin$/),
    ]);
    expect(fs.existsSync(path.join(dist, 'assets'))).toBe(false);
  });

  it('fails when no index.html can take the key share', async () => {
    writeConfig({ mode: 'all', cipher: 'aes-gcm' });
    runner.mockImplementation(() => fs.mkdirSync(dist, { recursive: true }));
    await expect(
      buildExecutor(
        { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'UAT' },
        ctx(),
        runner,
      ),
    ).rejects.toThrow(
      'aes-gcm build: index.html not found under dist/apps/web; the key share could not be written',
    );
    expect(fs.readFileSync(path.join(envDir, 'environment.uat.ts'), 'utf8')).toBe(
      "export const environment = { password: 'p' };",
    );
  });

  it('sri on a non-DEV build sets ri in __pstack', async () => {
    writeConfig({ cipher: 'aes-gcm', keys: { web: ['password'] } });
    await buildExecutor(
      { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env: 'UAT', sri: true },
      ctx(),
      runner,
    );
    const field = decodePstack(/__pstack: '([^']+)'/.exec(builtEnv)![1]);
    expect(field.ri).toBe(1);
  });

  it('cryptojs builds: meta has no k, no asset, no __pstack', async () => {
    writeConfig({ mode: 'all' });
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'UAT',
        keySplit: 'meta-bundle-asset',
      },
      ctx(),
      runner,
    );
    const meta = readMeta();
    expect(Object.keys(meta).sort()).toEqual(
      ['branch', 'build', 'commit', 'env', 'timestamp_ist', 'timestamp_utc'].sort(),
    );
    expect(fs.existsSync(path.join(dist, 'assets'))).toBe(false);
    expect(builtEnv).not.toContain('__pstack');
    expect(builtEnv).toMatch(/password: 'U2FsdGVkX1/);
  });
});

describe('buildExecutor release hardening', () => {
  const SECRET = 'pw-0123456789';
  let tmpDir: string;
  let dist: string;
  let runner: jest.MockedFunction<Runner>;
  let logs: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-harden-'));
    fs.writeFileSync(
      path.join(tmpDir, 'nx.json'),
      JSON.stringify({
        pstack: { envEncryption: { mode: 'listed', keys: { web: ['password'] } } },
      }),
    );
    const envDir = path.join(tmpDir, 'environments', 'web');
    fs.mkdirSync(envDir, { recursive: true });
    for (const env of ['uat', 'prod']) {
      fs.writeFileSync(
        path.join(envDir, `environment.${env}.ts`),
        `export const environment = { production: true, password: '${SECRET}' };`,
      );
    }
    fs.writeFileSync(
      path.join(envDir, 'environment.ts'),
      `export const environment = { production: false, password: '${SECRET}' };`,
    );
    dist = path.join(tmpDir, 'dist', 'apps', 'web');
    fs.mkdirSync(dist, { recursive: true });
    runner = jest.fn();
    logs = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.join(' '));
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), text);
  };
  const read = (rel: string) => fs.readFileSync(path.join(dist, rel), 'utf8');
  const sha384 = (text: string) =>
    `sha384-${crypto.createHash('sha384').update(text).digest('base64')}`;
  const run = (env: string, extra: Partial<BuildExecutorSchema> = {}) =>
    buildExecutor(
      { type: 'angular', outputPath: 'dist/apps/web', envProject: 'web', env, ...extra },
      makeContext('web', tmpDir),
      runner,
    );
  const INDEX =
    '<html><head><!-- note --><link rel="stylesheet" href="styles.css"></head>' +
    '<body><script src="main.js"></script></body></html>';

  it('fails on a leak, naming the file and key but never the value', async () => {
    write('index.html', INDEX);
    write('main.js', `const p = "${SECRET}";`);
    const err = await run('UAT', { leakCheck: 'fail' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^release checks failed/);
    expect((err as Error).message).toContain('main.js: plaintext of password');
    expect((err as Error).message).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(SECRET);
    // The env file was restored before the checks ran.
    expect(fs.readFileSync(path.join(tmpDir, 'environments/web/environment.uat.ts'), 'utf8')).toBe(
      `export const environment = { production: true, password: '${SECRET}' };`,
    );
  });

  it('only lists a leak in warn mode (and LEAK_CHECK overrides the option)', async () => {
    write('main.js', `const p = "${SECRET}";`);
    await expect(run('UAT', { leakCheck: 'warn' })).resolves.toEqual({ success: true });
    expect(logs.join('\n')).toContain('main.js: plaintext of password');
    process.env['LEAK_CHECK'] = 'warn';
    try {
      await expect(run('UAT', { leakCheck: 'fail' })).resolves.toEqual({ success: true });
    } finally {
      delete process.env['LEAK_CHECK'];
    }
  });

  it('fails on source maps after listing every check result', async () => {
    write('main.js', `const p = "${SECRET}";\n//# sourceMappingURL=main.js.map`);
    write('main.js.map', '{}');
    const err = (await run('PROD', { leakCheck: 'fail', sourceMaps: 'fail' }).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.message).toContain('main.js: plaintext of password');
    expect(err.message).toContain('source map file: main.js.map');
    expect(err.message).toContain('"sourceMap": false');
  });

  it('checks before stripping and hashes the stripped files (no JS: no terser needed)', async () => {
    write('index.html', INDEX.replace('<script src="main.js"></script>', ''));
    write('styles.css', 'a{}/* gone */');
    await run('UAT', { stripComments: true, sri: true });
    expect(read('styles.css')).toBe('a{}');
    const html = read('index.html');
    expect(html).not.toContain('note');
    expect(html).toContain(`integrity="${sha384('a{}')}"`);

    // The leak check sees the output before comments are stripped.
    write('styles.css', `a{}/* ${SECRET} */`);
    await expect(run('UAT', { leakCheck: 'fail', stripComments: true })).rejects.toThrow(
      /styles\.css: plaintext of password/,
    );
  });

  it('rejects an invalid option before building', async () => {
    await expect(run('UAT', { leakCheck: 'loud' as never })).rejects.toThrow(/leakCheck/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('recomputes the ngsw.json hashTable after every rewrite', async () => {
    write('index.html', INDEX.replace('<script src="main.js"></script>', ''));
    write('styles.css', 'a{}/* gone */');
    write(
      'ngsw.json',
      JSON.stringify({
        index: '/index.html',
        hashTable: { '/styles.css': 'stale', '/index.html': 'stale', '/missing.js': 'keep' },
      }),
    );
    await run('UAT', { stripComments: true, sri: true });
    const table = JSON.parse(read('ngsw.json')).hashTable;
    const sha1 = (t: string) => crypto.createHash('sha1').update(t).digest('hex');
    expect(table['/styles.css']).toBe(sha1('a{}'));
    expect(table['/index.html']).toBe(sha1(read('index.html')));
    expect(table['/missing.js']).toBe('keep');
    expect(logs.join('\n')).not.toContain('no longer matches');
  });

  it('sri passes --subresourceIntegrity to non-DEV Angular builds only', async () => {
    await run('UAT', { sri: true });
    expect(runner.mock.calls[0][0]).toContain('--subresourceIntegrity');
    runner.mockClear();
    await run('DEV', { sri: true });
    expect(runner.mock.calls[0][0]).not.toContain('--subresourceIntegrity');
    runner.mockClear();
    await run('UAT', {});
    expect(runner.mock.calls[0][0]).not.toContain('--subresourceIntegrity');
  });

  it('obfuscates, swaps lazy-chunk hashes in the runtime, then refreshes index.html integrity', async () => {
    const lazy = 'var lazy=1;';
    const main = 'var main=1;';
    const runtime = `r.sriHashes={42:"${sha384(lazy)}"};`;
    write(
      'index.html',
      `<html><body><script src="runtime.js" integrity="${sha384(
        runtime,
      )}" crossorigin="anonymous"></script>` +
        `<script src="main.js" integrity="${sha384(
          main,
        )}" crossorigin="anonymous"></script></body></html>`,
    );
    write('runtime.js', runtime);
    write('main.js', main);
    write('42.js', lazy);
    const obfuscator = {
      obfuscate: (code: string) => ({ getObfuscatedCode: () => `/*o*/${code}` }),
    };
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'UAT',
        sri: true,
        obfuscate: 'light',
      },
      makeContext('web', tmpDir),
      runner,
      { obfuscator },
    );
    expect(read('main.js')).toBe(`/*o*/${main}`);
    expect(read('42.js')).toBe(`/*o*/${lazy}`);
    const newRuntime = read('runtime.js');
    expect(newRuntime).toBe(`r.sriHashes={42:"${sha384(`/*o*/${lazy}`)}"};`);
    const html = read('index.html');
    expect(html).toContain(`src="runtime.js" integrity="${sha384(newRuntime)}"`);
    expect(html).toContain(`src="main.js" integrity="${sha384(`/*o*/${main}`)}"`);
    expect(logs.join('\n')).toMatch(/obfuscated 2 file\(s\)/);
  });

  it('refreshes integrity in browser/index.html (application builder layout)', async () => {
    write(
      'browser/index.html',
      `<link rel="stylesheet" href="styles-AB12.css" integrity="${sha384('x')}">`,
    );
    write('browser/styles-AB12.css', 'a{}/* gone */');
    await run('UAT', { sri: true, stripComments: true });
    expect(read('browser/index.html')).toContain(`integrity="${sha384('a{}')}"`);
  });

  it('keeps integrity Angular wrote (angular.json subresourceIntegrity) in step when sri is off', async () => {
    write(
      'index.html',
      `<link rel="stylesheet" href="styles.css" integrity="${sha384('a{}/* x */')}">`,
    );
    write('styles.css', 'a{}/* x */');
    await run('UAT', { stripComments: true });
    expect(read('index.html')).toContain(`integrity="${sha384('a{}')}"`);
  });

  it('passes the obfuscate level and obfuscateOptions to the obfuscator', async () => {
    write('main.js', 'var main=1;');
    const seen: Record<string, unknown>[] = [];
    const obfuscator = {
      obfuscate: (code: string, options: object) => {
        seen.push(options as Record<string, unknown>);
        return { getObfuscatedCode: () => code };
      },
    };
    await buildExecutor(
      {
        type: 'angular',
        outputPath: 'dist/apps/web',
        envProject: 'web',
        env: 'UAT',
        obfuscate: 'medium',
        obfuscateOptions: { stringArrayThreshold: 0.2 },
      },
      makeContext('web', tmpDir),
      runner,
      { obfuscator },
    );
    expect(seen[0]).toMatchObject({
      identifierNamesGenerator: 'hexadecimal',
      stringArrayThreshold: 0.2,
      target: 'browser-no-eval',
    });
    await expect(
      run('UAT', { obfuscate: 'light', obfuscateOptions: { domainLock: ['x'] } }),
    ).rejects.toThrow(/obfuscateOptions.domainLock cannot be set/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('obfuscate off never loads javascript-obfuscator; DEV never obfuscates', async () => {
    write('main.js', 'var a=1;');
    // tmpDir has no javascript-obfuscator: loading it would fail the build.
    await expect(run('UAT', { obfuscate: 'off' })).resolves.toEqual({ success: true });
    await expect(run('DEV', { obfuscate: 'light' })).resolves.toEqual({ success: true });
    expect(read('main.js')).toBe('var a=1;');
    await expect(run('UAT', { obfuscate: 'light' })).rejects.toThrow(
      /add javascript-obfuscator to devDependencies/,
    );
  });

  it('rejects an unknown obfuscate value before building', async () => {
    await expect(run('UAT', { obfuscate: 'heavy' as never })).rejects.toThrow(/obfuscate must be/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('warns that application-builder lazy chunks are not covered by SRI', async () => {
    write('index.html', '<html><body><script src="main-AB12.js"></script></body></html>');
    write('main-AB12.js', 'import("./chunk-CD34.js");');
    write('chunk-CD34.js', 'export const x=1;');
    await run('UAT', { sri: true });
    expect(logs.join('\n')).toContain('lazy chunks are not covered');
  });

  it('sri on a cryptojs build notes that the runtime check needs aes-gcm', async () => {
    await run('UAT', { sri: true });
    expect(logs.join('\n')).toContain('needs cipher aes-gcm');
  });

  it('DEV runs none of the steps', async () => {
    write('index.html', INDEX);
    write('styles.css', `a{}/* ${SECRET} */`);
    write('main.js.map', '{}');
    await expect(
      run('DEV', { leakCheck: 'fail', sourceMaps: 'fail', stripComments: true, harden: true }),
    ).resolves.toEqual({ success: true });
    expect(read('styles.css')).toBe(`a{}/* ${SECRET} */`);
    expect(read('index.html')).toContain('<!-- note -->');
    expect(logs.join('\n')).not.toContain('harden is replaced');
  });

  it('harden: true strips comments, warns about the replacement and runs no script', async () => {
    write('index.html', INDEX.replace('<script src="main.js"></script>', ''));
    write('styles.css', 'a{}/* gone */');
    await run('UAT', { harden: true });
    expect(read('styles.css')).toBe('a{}');
    expect(logs.join('\n')).toContain('harden is replaced by stripComments and dropConsole');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toMatch(/^npx nx run web:build:uat/);
  });

  withTerser('with terser', () => {
    it('drops console.log from main.js before SRI hashes it', async () => {
      write('index.html', INDEX);
      write('styles.css', 'a{}');
      write('main.js', 'console.log("x");\nconsole.error("e");\n');
      await run('PROD', { dropConsole: ['log'], stripComments: true, sri: true });
      const js = read('main.js');
      expect(js).not.toContain('console.log');
      expect(js).toContain('console.error');
      expect(read('index.html')).toContain(`integrity="${sha384(js)}"`);
    });
  });
});

describe('envFileFor', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { envFileFor } = require('../../src/executors/build/executor');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsm = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require('path');

  it('uses environment.dev.ts for DEV in the per-env layout', () => {
    const root = fsm.mkdtempSync(p.join(os.tmpdir(), 'envfile-'));
    const dir = p.join(root, 'environments', 'web');
    fsm.mkdirSync(dir, { recursive: true });
    fsm.writeFileSync(p.join(dir, 'environment.dev.ts'), '');
    expect(envFileFor(root, 'web', 'DEV')).toBe(p.join(dir, 'environment.dev.ts'));
    expect(envFileFor(root, 'web', 'UAT')).toBe(p.join(dir, 'environment.uat.ts'));
    fsm.writeFileSync(p.join(dir, 'environment.ts'), '');
    expect(envFileFor(root, 'web', 'DEV')).toBe(p.join(dir, 'environment.ts'));
  });
});
