import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Env file backups and locks for the release build, kept in node_modules/.cache:
 * - `<id>.lock`: { pid, token } while a release build uses the env file. Builds that share an env
 *   file wait for each other; a lock whose process is gone is stale.
 * - `<id>.json`: { file, content, written? }: the original text, and the hash of the text the
 *   build wrote, so a killed build is repaired by the next one without overwriting later edits.
 */
export const BACKUP_DIR = 'node_modules/.cache/nx-polystack/env-backup';

const dirOf = (repoRoot: string) => path.join(repoRoot, ...BACKUP_DIR.split('/'));
const relOf = (repoRoot: string, file: string) =>
  path.relative(repoRoot, file).split(path.sep).join('/');
const idFor = (rel: string) => crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16);
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const backupPath = (repoRoot: string, file: string) =>
  path.join(dirOf(repoRoot), `${idFor(relOf(repoRoot, file))}.json`);
const lockPath = (repoRoot: string, file: string) =>
  path.join(dirOf(repoRoot), `${idFor(relOf(repoRoot, file))}.lock`);

interface Backup {
  file: string;
  content: string;
  written?: string;
}

/** Writes via a temporary file and rename, so a crash never leaves a half-written backup. */
function writeAtomic(p: string, text: string): void {
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function readBackup(p: string): Backup | undefined {
  try {
    const b = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof b?.content === 'string' ? b : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Tokens of the locks this process holds (a lock with this pid but another token is stale). */
const HELD = new Set<string>();
const HOST = os.hostname();

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export interface LockOptions {
  /** How long to wait for another build using the same env file (default 60 minutes). */
  timeoutMs?: number;
  pollMs?: number;
  /** Called once when the build starts waiting. */
  onWait?: () => void;
}

/** Takes the env file's lock (waiting while another live build holds it); returns a release. */
export function lockEnvFile(repoRoot: string, file: string, opts: LockOptions = {}): () => void {
  const dir = dirOf(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const lock = lockPath(repoRoot, file);
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000);
  let waited = false;
  for (;;) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: HOST, token }), {
        flag: 'wx',
      });
      HELD.add(token);
      return () => {
        HELD.delete(token);
        try {
          const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
          if (held.token === token) fs.unlinkSync(lock);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let holder: { pid?: number; host?: string; token?: string } = {};
    let readable = true;
    try {
      holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
    } catch {
      readable = false;
    }
    const shown = relOf(repoRoot, file);
    const lockShown = relOf(repoRoot, lock);
    let stale: boolean;
    if (!readable || typeof holder.pid !== 'number') {
      // Being written right now, or left empty by a crash: stale once it is a few seconds old.
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      stale = age > 5_000;
    } else if (holder.host !== undefined && holder.host !== HOST) {
      // Written on another machine or container (e.g. an aborted CI job): its process is gone.
      stale = true;
    } else if (holder.pid === process.pid) {
      if (holder.token !== undefined && HELD.has(holder.token)) {
        throw new Error(
          `env encryption: another release build in this process is using ${shown}; run release ` +
            `builds that share an env folder one at a time (lock: ${lockShown}).`,
        );
      }
      stale = true;
    } else {
      stale = !processAlive(holder.pid);
    }
    if (stale) {
      removeStaleLock(lock, readable ? holder.token : undefined);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `env encryption: another release build (pid ${
          holder.pid ?? '?'
        }) is still using ${shown}. ` + `If none is running, delete ${lockShown}.`,
      );
    }
    if (!waited) {
      waited = true;
      opts.onWait?.();
    }
    sleep(opts.pollMs ?? 500);
  }
}

/**
 * Removes a stale lock without racing another build that found it stale too: the lock is moved
 * aside (atomic) and checked; if what was moved is not the stale lock (another build already
 * replaced it with a live one), it is put back with a link, which never overwrites.
 */
export function removeStaleLock(lock: string, staleToken: string | undefined): void {
  const aside = `${lock}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return; // Already moved or removed by another build.
  }
  let moved: { token?: string } = {};
  try {
    moved = JSON.parse(fs.readFileSync(aside, 'utf8'));
  } catch {
    // Empty or corrupt: it was the stale one.
  }
  if (moved.token !== undefined && moved.token !== staleToken) {
    try {
      fs.linkSync(aside, lock);
    } catch {
      // A newer lock exists already; the moved one's build keeps running without its file.
    }
  }
  fs.rmSync(aside, { force: true });
}

export function backupEnvFile(repoRoot: string, file: string): void {
  fs.mkdirSync(dirOf(repoRoot), { recursive: true });
  const b: Backup = { file: relOf(repoRoot, file), content: fs.readFileSync(file, 'utf8') };
  writeAtomic(backupPath(repoRoot, file), JSON.stringify(b));
}

/** Records the text the build wrote, so recovery can tell whether the file changed since. */
export function markWritten(repoRoot: string, file: string, text: string): void {
  const p = backupPath(repoRoot, file);
  const b = readBackup(p);
  if (b) writeAtomic(p, JSON.stringify({ ...b, written: sha(text) }));
}

/** Writes the backed-up content back and removes the backup (kept when it cannot be read). */
export function restoreEnvFile(repoRoot: string, file: string): void {
  const p = backupPath(repoRoot, file);
  if (!fs.existsSync(p)) return;
  const b = readBackup(p);
  if (!b) {
    throw new Error(
      `env encryption: the backup of ${relOf(repoRoot, file)} (${relOf(repoRoot, p)}) cannot be ` +
        'read; check the env file against git before building again.',
    );
  }
  fs.writeFileSync(file, b.content);
  fs.unlinkSync(p);
}

export interface RecoverResult {
  /** The file was restored from the backup of an unfinished build. */
  restored: boolean;
  /** The file changed after that build, so the backup was dropped and the file kept. */
  kept: boolean;
}

/**
 * Repairs the env file after a build that did not finish (call with the lock held): restores the
 * backup when the file still holds what that build wrote; keeps the file (and drops the backup)
 * when it was edited since. A legacy `<file>.bak` is restored the same way as before v0.25.0.
 */
export function recoverEnvFile(repoRoot: string, file: string): RecoverResult {
  const result: RecoverResult = { restored: false, kept: false };
  const p = backupPath(repoRoot, file);
  if (fs.existsSync(p)) {
    const b = readBackup(p);
    if (!b) {
      throw new Error(
        `env encryption: the backup of ${relOf(repoRoot, file)} left by an unfinished build ` +
          `(${relOf(repoRoot, p)}) cannot be read; check the env file against git, then delete it.`,
      );
    }
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    if (b.written === undefined || (current !== undefined && sha(current) === b.written)) {
      if (current !== b.content) {
        fs.writeFileSync(file, b.content);
        result.restored = true;
      }
    } else {
      result.kept = true;
    }
    fs.unlinkSync(p);
  }
  const bak = `${file}.bak`;
  if (fs.existsSync(bak)) {
    if (!result.restored && !result.kept) {
      fs.copyFileSync(bak, file);
      result.restored = true;
    }
    fs.unlinkSync(bak);
  }
  return result;
}
