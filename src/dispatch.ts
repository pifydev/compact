/**
 * Dispatching a compaction safely — the one bit of the ctx.compact() call that
 * needs guarding, factored out so it is testable without a live session.
 *
 * ctx.compact() reports the usual failures asynchronously via onError, but it
 * can also throw SYNCHRONOUSLY (e.g. no model configured, or an internal
 * precondition fails before it dispatches). An unguarded synchronous throw would
 * escape the caller mid-cleanup: the `compacting` flag stays true — permanently
 * disabling auto-compaction for the session — and, on the input-preflight path,
 * the pending promise is never resolved, so the input hook never returns
 * {action:"continue"} and the turn stalls.
 *
 * Routing the synchronous throw through the same onError callback the async path
 * uses lets each caller run its normal recovery (reset the flag, notify, and —
 * in the preflight — resolve), so a throwing compact leaves no stuck state.
 */

export interface CompactDispatchOptions {
  customInstructions?: string;
  onComplete?: (result: { tokensBefore: number; estimatedTokensAfter?: number }) => void;
  onError?: (error: Error) => void;
}

export interface CompactCapable {
  compact(options: CompactDispatchOptions): void;
}

/**
 * Call ctx.compact(), routing a synchronous throw to options.onError instead of
 * letting it escape. Returns true when compaction was dispatched, false when it
 * threw synchronously (onError has already run in that case).
 */
export function dispatchCompact(ctx: CompactCapable, options: CompactDispatchOptions): boolean {
  try {
    ctx.compact(options);
    return true;
  } catch (err) {
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}
