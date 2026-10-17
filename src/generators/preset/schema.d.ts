export interface PresetGeneratorSchema {
  npmScope?: string;
  baseBranch?: string;
  apps?: string;
  /** CI providers for :infra's ci part: github-actions | jenkins (default: github-actions). */
  ci?: string;
  /** :infra parts: docs,ci,quality,upgrades | all | none (default: all). */
  infra?: string;
  ciCache?: boolean;
  flutter?: string;
  upgradeSchedule?: string;
  upgradeScope?: string;
  llm?: string;
  projectDescription?: string;
  lintCommand?: string;
  skipFormat?: boolean;
  skipInstall?: boolean;
  /** nx-polystack version to pin in the generated package.json (default: this plugin's version). */
  pluginVersion?: string;
}
