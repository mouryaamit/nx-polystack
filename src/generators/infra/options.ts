/** Parts of `:infra`, in the order they are generated. */
export const INFRA_PARTS = ['docs', 'ci', 'quality', 'upgrades'] as const;
export type InfraPart = (typeof INFRA_PARTS)[number];

export const CI_PROVIDERS = ['github-actions', 'jenkins'] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];

/** Cron (UTC) per schedule: Monday 03:17, or the 1st of the month at 03:17. */
export const UPGRADE_CRON = {
  weekly: '17 3 * * 1',
  monthly: '17 3 1 * *',
} as const;
export type UpgradeSchedule = keyof typeof UPGRADE_CRON;

export const UPGRADE_SCOPES = ['polystack', 'nx-minor'] as const;
export type UpgradeScope = (typeof UPGRADE_SCOPES)[number];

/** Marks the line block :infra adds to .husky/pre-push, so it is added only once. */
export const PREPUSH_MARKER = '# nx-polystack:infra pre-push';

const list = (input: string): string[] =>
  input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * `--with` / `--infra`: a comma-separated list of parts, or `all` / `none`. Empty or missing
 * means all. Returns the parts in canonical order.
 */
export function parseParts(input: string | undefined, flag = '--with'): InfraPart[] {
  const given = list(input ?? '');
  if (given.length === 0 || (given.length === 1 && given[0] === 'all')) return [...INFRA_PARTS];
  if (given.includes('none')) {
    if (given.length > 1) {
      throw new Error(`"none" cannot be combined with other parts in ${flag}.`);
    }
    return [];
  }
  for (const p of given) {
    if (p === 'all' || !(INFRA_PARTS as readonly string[]).includes(p)) {
      throw new Error(
        `unknown part "${p}" in ${flag}. Supported: ${INFRA_PARTS.join(', ')} (or all, none).`,
      );
    }
  }
  return INFRA_PARTS.filter((p) => given.includes(p));
}

/** `--ci`: comma-separated providers; empty or missing means github-actions. */
export function parseCiProviders(input: string | undefined): CiProvider[] {
  const given = list(input ?? '');
  if (given.length === 0) return ['github-actions'];
  for (const p of given) {
    if (!(CI_PROVIDERS as readonly string[]).includes(p)) {
      throw new Error(`unknown CI provider "${p}" in --ci. Supported: ${CI_PROVIDERS.join(', ')}.`);
    }
  }
  return CI_PROVIDERS.filter((p) => given.includes(p));
}

export function parseUpgradeSchedule(input: string | undefined): UpgradeSchedule {
  const v = (input ?? '').trim() || 'weekly';
  if (!(v in UPGRADE_CRON)) {
    throw new Error(`--upgrade-schedule must be weekly or monthly (got "${input}").`);
  }
  return v as UpgradeSchedule;
}

export function parseUpgradeScope(input: string | undefined): UpgradeScope {
  const v = (input ?? '').trim() || 'polystack';
  if (!(UPGRADE_SCOPES as readonly string[]).includes(v)) {
    throw new Error(`--upgrade-scope must be polystack or nx-minor (got "${input}").`);
  }
  return v as UpgradeScope;
}

export const FLUTTER_MODES = ['auto', 'on', 'off'] as const;
export type FlutterMode = (typeof FLUTTER_MODES)[number];

/** `--flutter`: auto (set up Flutter in CI when the workspace has Flutter projects), on, off. */
export function parseFlutterMode(input: string | undefined): FlutterMode {
  const v = (input ?? '').trim() || 'auto';
  if (!(FLUTTER_MODES as readonly string[]).includes(v)) {
    throw new Error(`--flutter must be auto, on or off (got "${input}").`);
  }
  return v as FlutterMode;
}
