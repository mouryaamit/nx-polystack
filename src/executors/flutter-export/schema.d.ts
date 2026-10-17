export interface FlutterExportExecutorSchema {
  flutterfowProject: string;
  dest: string;
  branch?: string;
  flutterfowEnv?: 'Production' | 'Development';
}
