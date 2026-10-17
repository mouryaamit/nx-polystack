export interface SharedLibsGeneratorSchema {
  /** Angular/Ionic apps to wire. Either this or all. */
  projects?: string[];
  /** Wire every Angular/Ionic app. */
  all?: boolean;
}
