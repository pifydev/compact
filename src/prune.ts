/**
 * Reclaim context before summarizing: superseded reads.
 *
 * The rest of this package answers "the window is full" with a lossy LLM
 * summary. Some of that weight is dead already: a file read twice keeps both
 * copies in context, and only the later one can still be true. Blanking the
 * earlier copy in the OUTBOUND view is lossless (the later read has the
 * content), deterministic, and needs no model call — it delays the summary,
 * or shrinks it.
 *
 * Cache discipline, because the outbound view is what the provider caches:
 * - the newest `protectRecentChars` of the transcript are never touched (the
 *   model may still be working from them, and rewriting the tail every turn
 *   would bust the warm prefix every turn);
 * - nothing is rewritten until at least `minReclaimChars` can be reclaimed at
 *   once, so a rewrite (one cache miss) is always paid for;
 * - given the same messages, the same result — the same array reference when
 *   nothing qualifies, like the degeneration guard.
 * Persisted history is never touched: a later /fork re-expands the reads.
 *
 * Only the supersede half of oh-my-pi's pre-compaction pruning is here; its
 * "useless result" half needs a core flag an extension cannot see.
 */

type Msg = { role?: string; content?: unknown; toolCallId?: string; [key: string]: unknown };

export interface PruneOptions {
  /** Newest transcript chars left untouched. Default ≈ 40k tokens. */
  protectRecentChars?: number;
  /** Minimum chars a rewrite must reclaim to be worth one cache miss. */
  minReclaimChars?: number;
}

export const DEFAULT_PROTECT_RECENT_CHARS = 160_000;
export const DEFAULT_MIN_RECLAIM_CHARS = 20_000;

/** A file the summary must not lose sight of, whatever was re-read. */
const PLAN_FILE = /(^|[\\/])[^\\/]*plan[^\\/]*\.md$/i;
const READ_TOOLS = new Set(["read", "cat"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Visible chars of a message's content — the unit the provider bills roughly by. */
function chars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (!isRecord(b)) continue;
    if (typeof b.text === "string") n += b.text.length;
    else if (typeof b.thinking === "string") n += b.thinking.length;
    else if (b.type === "toolCall") n += JSON.stringify(b.arguments ?? {}).length;
  }
  return n;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface PrunedRead {
  index: number;
  path: string;
  chars: number;
}

export function placeholderFor(path: string): string {
  return `[superseded: this read of ${path} was replaced by a later read of the same file — @pify/compact pruned it from context]`;
}

/**
 * Blank every read tool result whose file was read again later, outside the
 * protected tail, when enough can be reclaimed at once. Pure; returns the
 * SAME array reference when nothing changes; idempotent; never throws.
 */
export function pruneSupersededReads(messages: Msg[], opts: PruneOptions = {}): { messages: Msg[]; pruned: PrunedRead[] } {
  const protect = opts.protectRecentChars ?? DEFAULT_PROTECT_RECENT_CHARS;
  const minReclaim = opts.minReclaimChars ?? DEFAULT_MIN_RECLAIM_CHARS;
  try {
    // 1. Every read call: id → path, in transcript order.
    const pathOfCall = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (!isRecord(b) || b.type !== "toolCall" || typeof b.id !== "string") continue;
        const name = typeof b.name === "string" ? b.name.toLowerCase() : "";
        if (!READ_TOOLS.has(name)) continue;
        const args = isRecord(b.arguments) ? b.arguments : null;
        const raw = args?.path ?? args?.file;
        if (typeof raw === "string" && raw.trim()) pathOfCall.set(b.id, normalizePath(raw.trim()));
      }
    }
    if (pathOfCall.size < 2) return { messages, pruned: [] };

    // 2. Every read result, grouped by path, in order.
    const resultsByPath = new Map<string, number[]>();
    messages.forEach((msg, i) => {
      if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string") return;
      const path = pathOfCall.get(msg.toolCallId);
      if (!path) return;
      const list = resultsByPath.get(path) ?? [];
      list.push(i);
      resultsByPath.set(path, list);
    });

    // 3. Chars after each message, to find the protected tail.
    const after = new Array<number>(messages.length).fill(0);
    let acc = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      after[i] = acc;
      acc += chars(messages[i]!.content);
    }

    // 4. Candidates: all but the last result per path, outside the tail,
    //    not the plan file, not already a placeholder.
    const candidates: PrunedRead[] = [];
    for (const [path, indexes] of resultsByPath) {
      if (indexes.length < 2 || PLAN_FILE.test(path)) continue;
      for (const i of indexes.slice(0, -1)) {
        if (after[i]! < protect) continue;
        const msg = messages[i]!;
        const size = chars(msg.content);
        const text = typeof msg.content === "string" ? msg.content : "";
        if (text.startsWith("[superseded:")) continue;
        if (Array.isArray(msg.content)) {
          const first = msg.content[0];
          if (isRecord(first) && typeof first.text === "string" && first.text.startsWith("[superseded:")) continue;
        }
        if (size <= placeholderFor(path).length) continue;
        candidates.push({ index: i, path, chars: size });
      }
    }
    const reclaim = candidates.reduce((n, c) => n + c.chars, 0);
    if (candidates.length === 0 || reclaim < minReclaim) return { messages, pruned: [] };

    // 5. Rewrite the outbound view only.
    const out = messages.slice();
    for (const c of candidates) {
      const msg = messages[c.index]!;
      out[c.index] = { ...msg, content: [{ type: "text", text: placeholderFor(c.path) }] };
    }
    return { messages: out, pruned: candidates.sort((a, b) => a.index - b.index) };
  } catch {
    return { messages, pruned: [] };
  }
}
