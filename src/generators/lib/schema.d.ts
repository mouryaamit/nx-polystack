export type LibType =
  | 'ts'
  | 'angular'
  | 'ionic'
  | 'flutter'
  | 'assets'
  | 'styles'
  | 'state'
  | 'design-tokens'
  | 'session'
  | 'pii'
  | 'android-native'
  | 'ios-native';

export interface LibGeneratorSchema {
  /** Library name (kebab-case). */
  name: string;
  type: LibType;
  /** Folder under libs/ and project-name prefix. Default depends on the type. */
  scope?: string;
  /** Folders under libs/<scope>/ (kebab-case, at most 2): the lib goes to libs/<scope>/<dir>/<name>. */
  dir?: string;
  /**
   * angular/ionic: internal | buildable | publishable (default buildable).
   * state: simple-service | ngrx (default simple-service); state libs are always buildable.
   */
  variant?: string;
  /** angular/ionic: component selector prefix (default lib). */
  prefix?: string;
  tags?: string[];
}
