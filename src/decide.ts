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
  /** Absolute tokens in use, or null when unknown. */
  tokens?: number | null;
}

export interface DecideState {
  active: boolean;
  compacting: boolean;
  thresholdPercent: number;
  /** Absolute token ceiling; 0 = off. Catches huge windows where a % never trips. */
  maxTokens?: number;
  /** Reserve-aware ceiling (contextWindow − reserveTokens); 0 = off. Ensures */
  /** enough room is left for the model's response — matters on small windows */
  /** where a flat percentage can leave less headroom than the reserve. */
  reserveCeiling?: number;
  /** Minimum token growth since the last compaction before the PERCENT trigger */
  /** fires again; 0 = off. The ceiling ignores it (a hard ceiling is safety). */
  minGrowthTokens?: number;
  /** Tokens in use at the last compaction, or null if none yet — the growth */
  /** baseline. Ignored unless minGrowthTokens > 0. */
  lastCompactedTokens?: number | null;
}

export interface Decision {
  compact: boolean;
  reason: string;
}

export function shouldCompact(usage: UsageLike | undefined, state: DecideState): Decision {
  if (!state.active) return { compact: false, reason: "dormant (pi's built-in compaction is on)" };
  if (state.compacting) return { compact: false, reason: "a compaction is already running" };
  const percent = usage?.percent ?? null;
  const tokens = usage?.tokens ?? null;
  const ceiling = state.maxTokens ?? 0;

  // An absolute ceiling catches huge windows where the percentage never trips
  // (80% of a 1M window is 800k tokens — far past when you'd want to compact).
  if (ceiling > 0 && tokens !== null && tokens >= ceiling) {
    return { compact: true, reason: `at ${fmt(tokens)} tokens (ceiling ${fmt(ceiling)})` };
  }

  // The reserve-aware ceiling: leave room for the model's response. On a small
  // window a flat 80% can leave less than the reserve, so compacting at
  // window−reserve is more correct. Like the ceiling, it is a hard safety that
  // ignores the growth gate.
  const reserveCeiling = state.reserveCeiling ?? 0;
  if (reserveCeiling > 0 && tokens !== null && tokens >= reserveCeiling) {
    return { compact: true, reason: `at ${fmt(tokens)} tokens (reserve ceiling ${fmt(reserveCeiling)})` };
  }

  // null right after a compaction, before the next response re-estimates — never
  // compact on an unknown, or we would loop compacting an already-small context.
  if (percent === null) return { compact: false, reason: "context usage is unknown" };
  if (percent < state.thresholdPercent) {
    return { compact: false, reason: `below threshold (${Math.round(percent)}% < ${state.thresholdPercent}%)` };
  }

  // Growth gate (opt-in): even at the threshold, hold off until the context has
  // grown by a real amount since the last compaction. Stops the thrash where a
  // compaction frees little, leaves the percentage near the threshold, and the
  // next settle compacts again. Only ever gates the percentage trigger — the
  // absolute ceiling above is a hard safety and is never held back.
  const minGrowth = state.minGrowthTokens ?? 0;
  const base = state.lastCompactedTokens ?? null;
  if (minGrowth > 0 && base !== null && tokens !== null) {
    const growth = tokens - base;
    if (growth < minGrowth) {
      return { compact: false, reason: `only ${fmt(Math.max(0, growth))} growth since last compaction (< ${fmt(minGrowth)})` };
    }
  }

  return { compact: true, reason: `at ${Math.round(percent)}% of the window (threshold ${state.thresholdPercent}%)` };
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
