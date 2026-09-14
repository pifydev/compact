/**
 * The compaction decision — pure, so the one judgment that matters is testable
 * without a live session.
 *
 * Compact only when: the extension is active (pi's own compaction is off, so we
 * are not double-compacting), no compaction is already in flight, the context
 * usage is known, and it has reached the threshold. Everything else — the
 * timing (only between turns, on agent_settled), the actual ctx.compact() call
 * — is the extension's job.
 */

export interface UsageLike {
  /** Percent of the context window in use, or null when unknown. */
  percent: number | null;
}

export interface DecideState {
  active: boolean;
  compacting: boolean;
  thresholdPercent: number;
}

export interface Decision {
  compact: boolean;
  reason: string;
}

export function shouldCompact(usage: UsageLike | undefined, state: DecideState): Decision {
  if (!state.active) return { compact: false, reason: "dormant (pi's built-in compaction is on)" };
  if (state.compacting) return { compact: false, reason: "a compaction is already running" };
  const percent = usage?.percent ?? null;
  // null right after a compaction, before the next response re-estimates — never
  // compact on an unknown, or we would loop compacting an already-small context.
  if (percent === null) return { compact: false, reason: "context usage is unknown" };
  if (percent < state.thresholdPercent) {
    return { compact: false, reason: `below threshold (${Math.round(percent)}% < ${state.thresholdPercent}%)` };
  }
  return { compact: true, reason: `at ${Math.round(percent)}% of the window (threshold ${state.thresholdPercent}%)` };
}
