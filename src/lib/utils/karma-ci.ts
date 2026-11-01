import { Tree } from '@nx/devkit';

import { TargetChange, updateProjectJson } from './quality';

type Json = Record<string, unknown>;

/**
 * Karma watches by default, so `nx run-many -t test` and CI never finish on a Karma target, and CI
 * agents have no display for Chrome. Karma test targets get a `ci` configuration (one run, headless
 * Chrome) that pstack's generated CI selects with `-c ci`; `nx test <app>` still watches.
 */
export const KARMA_CI_CONFIGURATION = { watch: false, browsers: 'ChromeHeadless' } as const;

/** A Karma test target (Angular's builder, either package). */
export function isKarmaTarget(target: unknown): target is Json {
  if (typeof target !== 'object' || target === null) return false;
  const t = target as Json;
  const executor = t['executor'] ?? t['builder'];
  return (
    typeof executor === 'string' &&
    /^@angular(-devkit\/build-angular|\/build):karma$/.test(executor)
  );
}

/** The target with the `ci` configuration added when it is a Karma target without one. */
export function withKarmaCi<T>(target: T): T {
  if (!isKarmaTarget(target)) return target;
  const configs = (target['configurations'] ?? {}) as Json;
  if (configs['ci'] !== undefined) return target;
  return { ...target, configurations: { ...configs, ci: { ...KARMA_CI_CONFIGURATION } } };
}

/** Adds the `ci` configuration to the Karma test targets of the project at `root`. */
export function karmaCiChange(tree: Tree, root: string): TargetChange {
  return updateProjectJson(tree, root, (json) => {
    const targets = (json['targets'] ?? {}) as Json;
    let found = false;
    let added = false;
    for (const [name, target] of Object.entries(targets)) {
      if (!isKarmaTarget(target)) continue;
      found = true;
      const next = withKarmaCi(target);
      if (next !== target) {
        targets[name] = next;
        added = true;
      }
    }
    return added ? 'added' : found ? 'exists' : 'none';
  });
}

/** `-c ci` on a generated `npx nx affected -t …` line that names no configuration. */
export function affectedWithCiConfiguration(line: string): string {
  if (!/npx nx affected -t /.test(line) || /\s(-c|--configuration)[ =]/.test(line)) return line;
  return line.replace(/(npx nx affected -t(?: [a-z][\w:-]*)+)/, '$1 -c ci');
}
