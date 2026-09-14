/**
 * Character-level degenerate-repeat guard for the outbound context.
 *
 * Models occasionally collapse into a long single-codepoint run — observed in
 * the wild as a thinking block ending in thousands of consecutive `【`, growing
 * each turn until the turn aborts. This is a different failure from hitting the
 * context wall (what the rest of @pify/compact handles): the attractor is
 * inside the generated text/thinking itself.
 *
 * Why it must be fixed at the context boundary: pi replays prior assistant
 * thinking back to the provider on every later request, and an aborted turn's
 * partial message stays in the session log. A degenerated tail therefore rides
 * along every subsequent prompt, where the model sees its own output ending in
 * thousands of repeats — a continuation bias that re-triggers the degeneration
 * and aborts the next turn too. The session dies in an abort loop with no way
 * out. Collapsing the run in the OUTBOUND view (persisted history is never
 * touched) breaks the loop.
 *
 * Ported from ranxianglei/billion-context-pi (src/degeneration.ts); trimmed to
 * a single self-contained pass with no external logging.
 */

/** A message as it appears in the outbound context: role + string|blocks content. */
type Msg = { role?: string; content?: unknown; [key: string]: unknown };

export interface DegenerationGuardConfig {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** Minimum length (in codepoints) of a single-codepoint run before it counts
   *  as degeneration. Legitimate runs in coding sessions (hrules, dotted
   *  leaders, comment banners) stay well under this. Default: 200; values below
   *  8 are raised to 8 so the collapse marker stays shorter than any run and
   *  ordinary dotted leaders are never matched. */
  minRun?: number;
}

export const DEFAULT_MIN_RUN = 200;
/** Below this the collapse marker could itself create detectable runs and
 *  sub-threshold matching starts hitting legitimate dotted leaders/hrules. */
export const MIN_VALID_MIN_RUN = 8;

/** One maximal run of a repeated codepoint. */
export interface DegenerateRun {
  /** The repeated codepoint (length 1 or 2 — surrogate pairs kept whole). */
  char: string;
  /** Run length in codepoints. */
  count: number;
  /** UTF-16 index of the run start in the original string. */
  index: number;
}

// Pre-screen before the full codepoint scan: one compiled regex pass decides
// whether a block can hold a degenerate run at all, so the per-codepoint scan
// only runs on the rare dirty block. Equivalent to the scan (with /su, `.`
// matches every codepoint incl. line terminators and isolated surrogates), not
// an approximation. Memoized per threshold.
let preScreenMinRun = Number.NaN;
let preScreenRe: RegExp | null = null;

function hasLongRun(text: string, minRun: number): boolean {
  const n = Math.floor(minRun);
  if (preScreenRe === null || preScreenMinRun !== n) {
    preScreenMinRun = n;
    preScreenRe = new RegExp(`(.)\\1{${Math.max(n - 1, 0)},}`, "su");
  }
  return preScreenRe.test(text);
}

/** Find maximal runs of a single repeated codepoint with length >= minRun.
 *  Codepoint-safe: surrogate pairs count as one unit. Returns [] for empty
 *  input or minRun < 2. */
export function findDegenerateRuns(text: string, minRun: number): DegenerateRun[] {
  const runs: DegenerateRun[] = [];
  if (!text || !Number.isFinite(minRun) || minRun < 2) return runs;
  if (!hasLongRun(text, minRun)) return runs;
  const chars = Array.from(text);
  let utf16 = 0;
  let k = 0;
  while (k < chars.length) {
    const ch = chars[k]!;
    let m = k + 1;
    while (m < chars.length && chars[m] === ch) m++;
    const count = m - k;
    if (count >= minRun) runs.push({ char: ch, count, index: utf16 });
    utf16 += count * ch.length;
    k = m;
  }
  return runs;
}

function describeChar(ch: string): string {
  if (ch === " ") return "space";
  if (ch === "\n") return "newline";
  if (ch === "\t") return "tab";
  if (ch === "\r") return "carriage-return";
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x7f) return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  return JSON.stringify(ch);
}

function applyRuns(text: string, runs: DegenerateRun[], minRun: number): string {
  // Idempotency: keep fewer copies than minRun, and the marker text must
  // contain no adjacent duplicate codepoints — otherwise a re-scan at a low
  // threshold could collapse inside the marker. The kept copies double as the
  // character sample, so the marker need not quote the char.
  const keep = Math.max(1, Math.min(3, minRun - 1));
  let out = "";
  let last = 0;
  for (const r of runs) {
    out += text.slice(last, r.index);
    out += `${r.char.repeat(keep)}… [${r.count}× identical chars cut — degenerate repeat]`;
    last = r.index + r.count * r.char.length;
  }
  out += text.slice(last);
  return out;
}

/** Collapse every degenerate run in `text` into a short marker naming the
 *  character and its count. Pure, idempotent, fail-safe; returns the input
 *  unchanged when there is nothing to collapse. */
export function collapseDegenerateRuns(text: string, minRun: number): string {
  const runs = findDegenerateRuns(text, minRun);
  return runs.length > 0 ? applyRuns(text, runs, minRun) : text;
}

/** Evidence of one rewritten message: which blocks changed and what was cut. */
export interface CollapseEvidence {
  /** Index of the rewritten message in the input array. */
  msgIndex: number;
  /** Block kinds rewritten ("content" for string content, else "text"/"thinking"). */
  blocks: string[];
  /** Runs collapsed across those blocks. */
  runs: DegenerateRun[];
}

/** Collapse degenerate runs in every ASSISTANT message's text/thinking blocks
 *  (string content included). Tool-call arguments are never touched (rewriting
 *  them would desync the model's view from the call that ran). Pure: returns
 *  the SAME array reference when nothing changed (cache-safe); idempotent;
 *  fail-safe (any error returns the input unchanged). */
export function collapseAssistantDegeneration(
  messages: Msg[],
  minRun: number,
): { messages: Msg[]; evidence: CollapseEvidence[] } {
  if (messages.length === 0) return { messages, evidence: [] };
  try {
    const evidence: CollapseEvidence[] = [];
    let changed = false;
    const out = messages.slice();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i] as Msg;
      if (msg.role !== "assistant") continue;
      const c = msg.content;
      if (typeof c === "string") {
        const runs = findDegenerateRuns(c, minRun);
        if (runs.length > 0) {
          out[i] = { ...msg, content: applyRuns(c, runs, minRun) };
          evidence.push({ msgIndex: i, blocks: ["content"], runs });
          changed = true;
        }
        continue;
      }
      if (!Array.isArray(c)) continue;
      const blocks: string[] = [];
      const runs: DegenerateRun[] = [];
      let blockChanged = false;
      const nc = c.map((p) => {
        const b = p as { type?: string; text?: unknown; thinking?: unknown };
        if (b?.type === "text" && typeof b.text === "string") {
          const r = findDegenerateRuns(b.text, minRun);
          if (r.length > 0) {
            blockChanged = true;
            blocks.push("text");
            runs.push(...r);
            return { ...(b as object), text: applyRuns(b.text, r, minRun) };
          }
          return p;
        }
        if (b?.type === "thinking" && typeof b.thinking === "string") {
          const r = findDegenerateRuns(b.thinking, minRun);
          if (r.length > 0) {
            blockChanged = true;
            blocks.push("thinking");
            runs.push(...r);
            return { ...(b as object), thinking: applyRuns(b.thinking, r, minRun) };
          }
          return p;
        }
        return p;
      });
      if (blockChanged) {
        out[i] = { ...msg, content: nc };
        evidence.push({ msgIndex: i, blocks, runs });
        changed = true;
      }
    }
    return { messages: changed ? out : messages, evidence };
  } catch {
    return { messages, evidence: [] };
  }
}

/** A one-shot recovery notice appended while a degenerated assistant message is
 *  the most recent turn: tells the model the repeated segment carries no
 *  information and was truncated, and to resume from the last valid step rather
 *  than continue the attractor. */
export function degenerationNotice(runs: DegenerateRun[], timestamp: number): Msg {
  const sorted = [...runs].sort((a, b) => b.count - a.count);
  const top = sorted[0]!;
  const extra = sorted.length > 1 ? ` and ${sorted.length - 1} other repeated segment(s)` : "";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[recovery notice] Your previous turn ended in degenerate generation: its output contained ${top.count} consecutive repetitions of ${describeChar(top.char)}${extra}. That repeated segment carries no information and has been truncated in the context above. Do not reproduce it or continue the pattern. Resume your task from your last valid step.`,
      },
    ],
    timestamp,
  };
}

/** Resolve minRun the same way settings does, for standalone use. */
function normalizeMinRun(minRun: number): number {
  if (!Number.isFinite(minRun) || minRun < 2) return DEFAULT_MIN_RUN;
  return Math.max(MIN_VALID_MIN_RUN, Math.floor(minRun));
}

/** The whole outbound pass: collapse degenerate runs in assistant messages and,
 *  when the MOST RECENT assistant message was one of them, append a one-shot
 *  recovery notice (self-limiting — a fresh model turn makes it non-last and the
 *  notice stops on the next rebuild, no persistent state).
 *
 *  Returns the SAME array reference when nothing was degenerate, so a clean
 *  context is a true no-op and never busts the provider's prompt cache. */
export function guardDegeneration(messages: Msg[], minRun: number, now: number): Msg[] {
  const n = normalizeMinRun(minRun);
  const { messages: collapsed, evidence } = collapseAssistantDegeneration(messages, n);
  if (evidence.length === 0) return messages;

  // The recovery notice fires only when the last assistant message itself was
  // degenerate (operating on the outbound view: a thinking-only aborted turn
  // that pi drops from the view won't be seen here — the collapse is the
  // primary protection, the notice a best-effort nudge).
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as Msg).role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const lastEvidence = evidence.find((e) => e.msgIndex === lastAssistant);
  if (!lastEvidence) return collapsed;
  return [...collapsed, degenerationNotice(lastEvidence.runs, now)];
}
