export interface CleanExecutorSchema {
  /** Workspace-relative folders or files to remove. */
  paths?: string[];
  /** Also run `flutter clean` in the project folder. */
  flutter?: boolean;
}
