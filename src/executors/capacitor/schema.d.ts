export type CapacitorCommand = 'sync' | 'open' | 'add' | 'copy';
export type CapacitorPlatform = 'android' | 'ios';

export interface CapacitorExecutorSchema {
  command: CapacitorCommand;
  /** Pass on the command line: nx run <app>:cap-sync --platform=android */
  platform: CapacitorPlatform;
  /** Web build output, relative to the workspace root. Default: dist/apps/<project>. */
  webDir?: string;
}
