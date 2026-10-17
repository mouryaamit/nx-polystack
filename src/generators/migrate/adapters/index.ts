import { angularCliAdapter, ionicSignals } from './angular-cli';
import { angularWorkspaceAdapter } from './angular-workspace';
import { flutterAdapter } from './flutter';
import { detectIonic, ionicAdapter } from './ionic';
import { npmWorkspacesAdapter } from './npm-workspaces';
import { nxWorkspaceAdapter } from './nx-workspace';
import { AnyMigrationAdapter, Detection } from './types';

/** All adapters, in the order they are listed and tried. */
export const ADAPTERS: readonly AnyMigrationAdapter[] = [
  angularCliAdapter,
  flutterAdapter,
  nxWorkspaceAdapter,
  angularWorkspaceAdapter,
  ionicAdapter,
  npmWorkspacesAdapter,
];

/** Adapter ids, in registry order. */
export const ADAPTER_IDS: readonly string[] = ADAPTERS.map((a) => a.id);

/** Lowest confidence at which the best adapter is used without --adapter. */
export const MIN_CONFIDENCE = 0.8;

/** Lowest value --min-confidence accepts: below it, pick an adapter with --adapter. */
export const MIN_CONFIDENCE_FLOOR = 0.5;

/** --min-confidence as a number from 0.5 to 1; MIN_CONFIDENCE when not given. */
export function parseMinConfidence(value: unknown): number {
  if (value === undefined) return MIN_CONFIDENCE;
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*(0|1|[01]?\.\d+)\s*$/.test(value)
      ? Number(value)
      : NaN;
  if (!Number.isFinite(n) || n < MIN_CONFIDENCE_FLOOR || n > 1) {
    throw new Error(
      `migrate: --min-confidence must be a number from 0.50 to 1.00 (got ${String(value)}).`,
    );
  }
  return n;
}

export interface DetectionRow extends Detection {
  adapter: AnyMigrationAdapter;
}

/** The built-in adapters followed by the workspace's external ones (built-ins win ties). */
export function allAdapters(extra: readonly AnyMigrationAdapter[] = []): AnyMigrationAdapter[] {
  return [...ADAPTERS, ...extra];
}

export function findAdapter(
  id: string,
  extra: readonly AnyMigrationAdapter[] = [],
): AnyMigrationAdapter {
  const all = allAdapters(extra);
  const adapter = all.find((a) => a.id === id);
  if (!adapter) {
    throw new Error(
      `migrate: unknown --adapter="${id}". Supported: ${all.map((a) => a.id).join(', ')}.`,
    );
  }
  return adapter;
}

/** One adapter's detection; an external adapter that throws scores 0 with the error as reason. */
function safeDetect(adapter: AnyMigrationAdapter, sourceDir: string): Detection {
  if (ADAPTERS.includes(adapter)) return adapter.detect(sourceDir);
  try {
    const d = adapter.detect(sourceDir);
    const confidence =
      typeof d?.confidence === 'number' && Number.isFinite(d.confidence)
        ? Math.min(1, Math.max(0, d.confidence))
        : 0;
    const reasons = Array.isArray(d?.reasons) ? d.reasons.map(String) : [];
    return { confidence, reasons };
  } catch (err) {
    return {
      confidence: 0,
      reasons: [`detect() failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/** Every adapter's detection, best first (ties keep registry order). */
export function detectAll(
  sourceDir: string,
  extra: readonly AnyMigrationAdapter[] = [],
): DetectionRow[] {
  return allAdapters(extra)
    .map((adapter) => ({ adapter, ...safeDetect(adapter, sourceDir) }))
    .sort((a, b) => b.confidence - a.confidence);
}

/** Shapes the source has that no adapter handles yet, for the "not supported" message. */
export function recognisedUnsupported(sourceDir: string): string[] {
  const found: string[] = [];
  const ionic = ionicSignals(sourceDir);
  const ionicDetection = ionic.length > 0 ? detectIonic(sourceDir) : undefined;
  if (ionicDetection && ionicDetection.confidence < MIN_CONFIDENCE) {
    const why = ionicDetection.reasons[ionicDetection.reasons.length - 1];
    found.push(`Ionic/Capacitor app (${ionic.join(', ')}${why ? `; ${why}` : ''})`);
  }
  return found;
}

/** Plain-text detection table. */
export function formatDetectionTable(rows: DetectionRow[]): string {
  const header = ['Adapter', 'Confidence', 'Reasons'];
  const body = rows.map((r) => [r.adapter.id, r.confidence.toFixed(2), r.reasons.join('; ')]);
  const widths = [0, 1].map((i) => Math.max(header[i].length, ...body.map((b) => b[i].length)));
  const line = (c: string[]) => `${c[0].padEnd(widths[0])}  ${c[1].padEnd(widths[1])}  ${c[2]}`;
  return [line(header), ...body.map(line)].join('\n');
}

export interface AdapterChoice {
  adapter: AnyMigrationAdapter;
  detection: Detection;
  /** Chosen with --adapter rather than by detection. */
  forced: boolean;
}

/**
 * The adapter to use: the --adapter one, else the most confident one when it reaches
 * MIN_CONFIDENCE. Otherwise throws with the detection table and what was recognised.
 */
export function chooseAdapter(
  sourceDir: string,
  override?: string,
  minConfidence: number = MIN_CONFIDENCE,
  extra: readonly AnyMigrationAdapter[] = [],
): AdapterChoice {
  if (override) {
    const adapter = findAdapter(override, extra);
    return { adapter, detection: safeDetect(adapter, sourceDir), forced: true };
  }
  const rows = detectAll(sourceDir, extra);
  const best = rows[0];
  if (best && best.confidence >= minConfidence) {
    return { adapter: best.adapter, detection: best, forced: false };
  }
  const recognised = recognisedUnsupported(sourceDir);
  throw new Error(
    [
      `migrate: no adapter is confident enough (needs ${minConfidence.toFixed(
        2,
      )}) for ${sourceDir}.`,
      '',
      formatDetectionTable(rows),
      '',
      recognised.length > 0
        ? `Recognised, but not supported yet: ${recognised.join('; ')}.`
        : 'This project shape is not supported yet.',
      `To migrate it anyway, pick an adapter with --adapter=<${allAdapters(extra)
        .map((a) => a.id)
        .join('|')}>.`,
      ...(best && best.confidence >= MIN_CONFIDENCE_FLOOR
        ? [
            `To accept ${best.adapter.id} at ${best.confidence.toFixed(2)}: ` +
              `--min-confidence=${best.confidence}.`,
          ]
        : []),
    ].join('\n'),
  );
}
