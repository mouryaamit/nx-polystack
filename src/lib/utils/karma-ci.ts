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

/**
 * Removes the Karma targets of a project.json (in place) when the source does not install karma:
 * such a target could not run before the migration either. Returns the removed target names.
 */
export function dropKarmaTargetsWithoutKarma(projectJson: Json, karmaInstalled: boolean): string[] {
  if (karmaInstalled) return [];
  const targets = projectJson['targets'];
  if (typeof targets !== 'object' || targets === null) return [];
  const t = targets as Json;
  const dropped = Object.keys(t).filter((name) => isKarmaTarget(t[name]));
  for (const name of dropped) delete t[name];
  return dropped;
}

/** The migrate report line for targets dropped by dropKarmaTargetsWithoutKarma. */
export function karmaDroppedNote(dropped: string[]): string {
  return (
    `${dropped.map((n) => `\`${n}\``).join(', ')} target dropped: it runs Karma, and karma is ` +
    "not in the source's package.json, so it could not run there either. The Karma files " +
    '(karma.conf.js, src/test.ts) are copied; add karma, karma-jasmine, karma-chrome-launcher and ' +
    'jasmine-core plus a test target to run the unit tests.'
  );
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

/**
 * A Karma config from Angular CLI 1.x (`'@angular/cli'` framework and plugin, `angularCli` block),
 * which no Angular since 6 can load ("Cannot find module '@angular/cli/plugins/karma'"), as
 * Angular's own v6 migration rewrites it. Other configs are returned unchanged.
 */
export function modernKarmaConfig(text: string): string {
  if (!/@angular\/cli\/plugins\/karma|['"]@angular\/cli['"]\s*[,\]]/.test(text)) return text;
  return text
    .replace(
      /(['"])@angular\/cli\/plugins\/karma\1/g,
      '$1@angular-devkit/build-angular/plugins/karma$1',
    )
    .replace(/(['"])@angular\/cli\1(?=\s*[,\]])/g, '$1@angular-devkit/build-angular$1')
    .replace(/^[ \t]*angularCli\s*:\s*\{[^{}]*\},?[ \t]*\r?\n/m, '');
}

/** Rewrites the Angular CLI 1.x Karma configs of a project's Karma targets; returns the files. */
export function modernizeKarmaConfigs(tree: Tree, projectJson: Json): string[] {
  const changed: string[] = [];
  for (const target of Object.values((projectJson['targets'] ?? {}) as Json)) {
    if (!isKarmaTarget(target)) continue;
    const file = (target['options'] as Json | undefined)?.['karmaConfig'];
    if (typeof file !== 'string') continue;
    const text = tree.read(file, 'utf8');
    if (text === null) continue;
    const out = modernKarmaConfig(text);
    if (out !== text) {
      tree.write(file, out);
      changed.push(file);
    }
  }
  return [...new Set(changed)];
}

/** The migration report note for modernizeKarmaConfigs. */
export function karmaNote(files: string[]): string {
  return (
    'Karma config from Angular CLI 1.x (`@angular/cli/plugins/karma`, which no Angular since 6 ' +
    `loads) now uses \`@angular-devkit/build-angular\`: ${files.map((f) => `\`${f}\``).join(', ')}.`
  );
}
