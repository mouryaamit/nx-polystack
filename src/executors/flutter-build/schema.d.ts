export interface FlutterBuildExecutorSchema {
  target?: 'web' | 'apk' | 'ios';
  /** Env name (dev, uat, prod or a custom one): environments/<envProject>/environment.<env>.json. */
  env?: string;
  /** Folder under environments/ with this app's env files (default: the project name). */
  envProject?: string;
  /** Web builds: copy environments/<envProject>/htaccess.<env> as .htaccess (default true). */
  htaccess?: boolean;
  dist?: string;
  baseHref?: string;
  serve?: boolean;
  /** Web server port when serving (default 4200). */
  port?: number;
  obfuscate?: boolean;
  /** Web builds: strip EXIF from images in dist (default true; only images with EXIF change). */
  stripExif?: boolean;
  /** Web: `gen: false` leaves the tool and its versions out of the build meta. */
  buildMeta?: { gen?: boolean };
}
