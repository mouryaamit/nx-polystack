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
  /** Angular major to add now (14–21); without it Angular 15 is added by the first Angular app. */
  angular?: number;
  /** New Angular and Ionic apps and libraries use standalone components (nx.json pstack.angular.style). */
  standalone?: boolean;
  /** nx-polystack version to pin in the generated package.json (default: this plugin's version). */
  pluginVersion?: string;
}
