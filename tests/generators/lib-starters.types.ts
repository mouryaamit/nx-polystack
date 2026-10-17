/** Shapes of the generated framework-free starter files, for the tests that load them. */
interface SessionConfig {
  idleMs: number;
  warningMs: number;
  absoluteMs?: number;
  activityEvents: string[];
  channelName: string;
  tickMs: number;
}
interface SessionState {
  status: 'stopped' | 'active' | 'warning' | 'timedOut';
  remainingMs: number;
  reason?: 'idle' | 'absolute';
}

export declare const clock: {
  DEFAULT_SESSION_TIMEOUT: SessionConfig;
  sessionState(
    now: number,
    startedAt: number,
    lastActivity: number,
    c: SessionConfig,
  ): SessionState;
  sessionConfigProblems(c: SessionConfig): string[];
  startedAtProblem(startedAt: unknown, now: number): string | null;
  validActivityTime(at: unknown, now: number): boolean;
  channelKey(name: string, baseURI: string | undefined): string;
};

interface MaskRule {
  valid?: RegExp;
  visibleStart?: number;
  visibleEnd?: number;
}

export declare const mask: {
  maskPii(
    value: unknown,
    format: string,
    options?: { maskChar?: string; rules?: Record<string, MaskRule> },
  ): string;
};
