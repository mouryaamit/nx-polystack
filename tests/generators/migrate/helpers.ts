import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'migrate');

/** A fresh temp directory (the test's "source repo"). */
export function tmpSource(prefix = 'pstack-migrate-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A temp copy of tests/fixtures/migrate/<fixture>, so tests can add junk or edit files. */
export function fixtureCopy(
  fixture:
    | 'angular15-app'
    | 'angular15-workspace'
    | 'flutter-app'
    | 'nx16-workspace'
    | 'ionic7-app'
    | 'npm-workspace'
    | 'nx15-multi-app',
): string {
  const dir = tmpSource(`pstack-${fixture}-`);
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

export function put(dir: string, rel: string, content: string | Buffer): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function putJson(dir: string, rel: string, value: unknown): void {
  put(dir, rel, JSON.stringify(value, null, 2) + '\n');
}

export function readJsonFile<T = Record<string, unknown>>(dir: string, rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
}

/**
 * Every file under `dir` (relative, sorted), for "the source was not modified" checks. Git's own
 * lock files are left out: git can create and remove them in the background.
 */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(r);
      else if (/^\.git\/.*\.lock$/.test(r)) continue;
      else out[r] = fs.readFileSync(path.join(dir, r)).toString('base64');
    }
  };
  visit('');
  return out;
}
