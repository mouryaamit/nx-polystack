export interface InfraGeneratorSchema {
  /** Comma-separated parts: docs | ci | quality | upgrades, or all | none (default: all). */
  with?: string;
  /** Comma-separated CI providers: github-actions | jenkins (default: github-actions). */
  ci?: string;
  /** GitHub Actions: cache the Nx cache directory between runs. */
  ciCache?: boolean;
  /** Set up Flutter in CI: auto (when a pubspec.yaml is under apps/ or libs/) | on | off. */
  flutter?: string;
  /** Dependency-upgrade workflow schedule: weekly | monthly (default: weekly). */
  upgradeSchedule?: string;
  /** What the upgrade workflow upgrades: polystack | nx-minor (default: polystack). */
  upgradeScope?: string;
  /** lint-staged ESLint step: warn (report, never block the commit) | block. Unset: unchanged. */
  lintStaged?: string;
  /** Overwrite files that already exist (never .husky/pre-push, which is appended to). */
  force?: boolean;
  skipFormat?: boolean;
}
