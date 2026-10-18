export interface FlutterBuildExecutorSchema {
  target?: 'web' | 'apk' | 'ios';
  env?: 'dev' | 'uat' | 'prod';
  dist?: string;
  baseHref?: string;
  serve?: boolean;
  /** Web server port when serving (default 4200). */
  port?: number;
  obfuscate?: boolean;
  /** Web builds: strip EXIF from images in dist (default true; only images with EXIF change). */
  stripExif?: boolean;
}
