import { POLYSTACK_BUILD_EXECUTOR } from './angular-project';

const FLUTTER_BUILD_EXECUTOR = '@mouryaamit/nx-polystack:flutter-build';

type Target = {
  executor?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, Record<string, unknown>>;
};

/**
 * A base href is a path: "/" or "/seg/…/seg/" with URL-safe segments (letters, digits, . _ ~ % -).
 * No host (`//x/`), no `..`, nothing a shell would read (it ends up on the build command line).
 */
export function checkBaseHref(href: string): string {
  const ok =
    /^\/(?:[A-Za-z0-9._~%-]+\/)*$/.test(href) &&
    !href.split('/').some((s) => s === '..' || s === '.');
  if (!ok) {
    throw new Error(
      `base href "${href}" must start and end with "/" and hold only letters, digits, . _ ~ % - ` +
        'between the slashes (e.g. /portal/)',
    );
  }
  return href;
}

/**
 * The target whose configurations carry the base href: the polystack release target of an
 * Angular/Ionic app, else a Flutter app's build-web.
 */
export function baseHrefTarget(
  projectJson: Record<string, unknown>,
): { name: string; target: Target } | undefined {
  const targets = (projectJson['targets'] ?? {}) as Record<string, Target>;
  const release = Object.entries(targets).find(([, t]) => t.executor === POLYSTACK_BUILD_EXECUTOR);
  if (release) return { name: release[0], target: release[1] };
  const web = targets['build-web'];
  if (web?.executor === FLUTTER_BUILD_EXECUTOR) return { name: 'build-web', target: web };
  return undefined;
}

/**
 * Whether a configuration builds DEV: its env, else the target's env option, else the executor's
 * default (dev for Flutter builds), else its name.
 */
export function isDevConfiguration(target: Target, name: string): boolean {
  const env =
    target.configurations?.[name]?.['env'] ??
    target.options?.['env'] ??
    (target.executor === FLUTTER_BUILD_EXECUTOR ? 'dev' : name);
  return ['dev', 'development'].includes(String(env).toLowerCase());
}

/** Sets (or, with undefined, removes) baseHref on the given configurations; returns their names. */
export function setBaseHref(
  target: Target,
  configurations: string[],
  href: string | undefined,
): string[] {
  target.configurations ??= {};
  for (const name of configurations) {
    const conf = { ...(target.configurations[name] ?? {}) };
    if (href === undefined) delete conf['baseHref'];
    else conf['baseHref'] = href;
    target.configurations[name] = conf;
  }
  return configurations;
}
