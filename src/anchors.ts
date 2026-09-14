/**
 * Deterministic "anchor" extraction from the conversation, to steer pi's own
 * compaction summary toward the facts that matter.
 *
 * @pify/compact never writes the summary itself — it delegates to pi's LLM via
 * ctx.compact() and spends no tokens of its own. But it CAN hand that LLM a
 * short list of concrete facts to preserve, extracted here by plain regex/parse
 * (no model call): the task/goal, the files touched, stated preferences, recent
 * commits, and any open blocker. Appending them to the compaction instructions
 * as "keep these exact facts" makes the summary far less likely to generalize
 * away the load-bearing details.
 *
 * The patterns are adapted from sting8k/pi-vcc's deterministic extractors.
 * Everything here is pure and bounded; zero dependencies.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Join text blocks of a message's content into a single string. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** The message object of a session entry, whatever the nesting. */
function entryMessage(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry)) return null;
  if (isRecord(entry.message)) return entry.message;
  return entry;
}

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|remove|update|change|make|write|support|migrate|debug|investigate|improve|optimi[sz]e|rename|delete|integrate|wire|port)\b/i;
const SCOPE_CHANGE_RE = /\b(instead|actually|no,? wait|let'?s (?:not|instead)|pivot|change of plans|scratch that|on second thought)\b/i;
const PREF_RE = /\b(prefer|always|never|please (?:use|don'?t|avoid)|make sure|ensure|don'?t use|avoid using|use \w+ instead|keep it|style:)/i;
const BLOCKER_RE = /\b(fail(?:ed|ing|s)?|errored?|broken|cannot|can'?t|blocked|crash(?:ed|es)?|not working|unresolved|still stuck|does ?n'?t work)\b/i;
const COMMIT_RE = /git commit\b[^\n]*?-m\s*["']([^"']{3,})["']/i;
const NOISE_SHORT_RE = /^(ok|okay|yes|no|thanks?|sure|go|continue|proceed|do it|next|yep|nope|k)\b/i;

/** A trimmed one-line snippet, capped in length. */
function snippet(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Path argument from a tool call's arguments, if any. */
function toolPath(args: unknown): string | null {
  if (!isRecord(args)) return null;
  const p = args.path ?? args.file ?? args.filename;
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

const READ_TOOLS = new Set(["read", "cat"]);
const WRITE_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);

export interface Anchors {
  goal: string | null;
  scopeChange: string | null;
  filesModified: string[];
  filesRead: string[];
  preferences: string[];
  commits: string[];
  blockers: string[];
}

const EMPTY: Anchors = {
  goal: null,
  scopeChange: null,
  filesModified: [],
  filesRead: [],
  preferences: [],
  commits: [],
  blockers: [],
};

/** Strip a common leading directory so file lists show their distinguishing tails. */
function trimCommonPrefix(paths: string[]): string[] {
  if (paths.length < 2) return paths;
  const split = paths.map((p) => p.split(/[\\/]/));
  let common = 0;
  const first = split[0]!;
  outer: for (; common < first.length - 1; common++) {
    const seg = first[common];
    for (const parts of split) {
      if (parts.length - 1 <= common || parts[common] !== seg) break outer;
    }
  }
  if (common === 0) return paths;
  return split.map((parts) => parts.slice(common).join("/"));
}

/**
 * Extract anchors from session entries (branch order). Pure and bounded: caps
 * every list, dedupes, and returns EMPTY-shaped data when there is nothing to
 * anchor. Never throws.
 */
export function extractAnchors(entries: unknown[]): Anchors {
  try {
    let goal: string | null = null;
    let scopeChange: string | null = null;
    const modified = new Set<string>();
    const read = new Set<string>();
    const prefs: string[] = [];
    const commits: string[] = [];
    const blockerCandidates: string[] = [];
    let sawFirstUser = false;
    let pendingCommitMsg: string | null = null;

    for (const entry of entries) {
      const msg = entryMessage(entry);
      if (!msg) continue;
      const role = typeof msg.role === "string" ? msg.role : "";

      if (role === "user") {
        const text = messageText(msg.content);
        if (!text.trim() || NOISE_SHORT_RE.test(text.trim())) continue;
        if (!sawFirstUser && TASK_RE.test(text)) {
          goal = snippet(text);
          sawFirstUser = true;
        } else if (SCOPE_CHANGE_RE.test(text)) {
          scopeChange = snippet(text);
        }
        if (PREF_RE.test(text) && !text.trim().endsWith("?") && prefs.length < 6) {
          const line = text.split("\n").find((l) => PREF_RE.test(l)) ?? text;
          prefs.push(snippet(line, 120));
        }
        continue;
      }

      if (role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!isRecord(block) || block.type !== "toolCall") continue;
          const name = typeof block.name === "string" ? block.name.toLowerCase() : "";
          if (name === "bash") {
            const cmd = isRecord(block.arguments) && typeof block.arguments.command === "string" ? block.arguments.command : "";
            const m = COMMIT_RE.exec(cmd);
            if (m) pendingCommitMsg = m[1]!;
            continue;
          }
          const path = toolPath(block.arguments);
          if (!path) continue;
          if (WRITE_TOOLS.has(name)) modified.add(path);
          else if (READ_TOOLS.has(name)) read.add(path);
        }
        continue;
      }

      if (role === "toolResult" || role === "bashExecution") {
        const out = messageText(msg.content ?? msg.output ?? "");
        // Pair a pending "git commit -m" with the hash printed in its result.
        if (pendingCommitMsg) {
          const hash = /\b([0-9a-f]{7,40})\b/.exec(out);
          commits.push(hash ? `${hash[1]!.slice(0, 8)} ${pendingCommitMsg}` : pendingCommitMsg);
          pendingCommitMsg = null;
        }
      }
    }

    // Blockers: scan only the tail for freshness (an old failure is usually resolved).
    const tail = entries.slice(-24);
    for (const entry of tail) {
      const msg = entryMessage(entry);
      if (!msg) continue;
      const role = typeof msg.role === "string" ? msg.role : "";
      if (role !== "toolResult" && role !== "bashExecution" && role !== "user") continue;
      const isError = isRecord(entry) && (entry as { isError?: unknown }).isError === true;
      const text = messageText(msg.content ?? msg.output ?? "");
      if (!text) continue;
      const line = text.split("\n").find((l) => BLOCKER_RE.test(l));
      if ((isError || line) && blockerCandidates.length < 4) {
        blockerCandidates.push(snippet(line ?? text.split("\n")[0] ?? "", 120));
      }
    }

    return {
      goal,
      scopeChange,
      filesModified: trimCommonPrefix([...modified]).slice(0, 12),
      filesRead: [...read].filter((p) => !modified.has(p)).slice(0, 8),
      preferences: [...new Set(prefs)].slice(0, 6),
      commits: [...new Set(commits)].slice(0, 4),
      blockers: [...new Set(blockerCandidates)].slice(0, 4),
    };
  } catch {
    return { ...EMPTY };
  }
}

/** True when there is at least one fact worth anchoring. */
export function hasAnchors(a: Anchors): boolean {
  return Boolean(
    a.goal ||
      a.scopeChange ||
      a.filesModified.length ||
      a.filesRead.length ||
      a.preferences.length ||
      a.commits.length ||
      a.blockers.length,
  );
}

/**
 * Render anchors as an instruction block for ctx.compact(). Returns "" when
 * there is nothing to anchor. Bounded in size so it never bloats the request.
 */
export function formatAnchors(a: Anchors): string {
  if (!hasAnchors(a)) return "";
  const lines: string[] = ["Preserve these exact facts in the summary — do not drop or generalize them:"];
  if (a.goal) lines.push(`- Task: ${a.goal}`);
  if (a.scopeChange) lines.push(`- Latest scope change: ${a.scopeChange}`);
  if (a.filesModified.length) lines.push(`- Files modified: ${a.filesModified.join(", ")}`);
  if (a.filesRead.length) lines.push(`- Files read: ${a.filesRead.join(", ")}`);
  if (a.preferences.length) lines.push(`- Preferences: ${a.preferences.join(" | ")}`);
  if (a.commits.length) lines.push(`- Commits: ${a.commits.join(" | ")}`);
  if (a.blockers.length) lines.push(`- Open/unresolved: ${a.blockers.join(" | ")}`);
  return lines.join("\n");
}

/** Extract and format in one step; "" when nothing to anchor. */
export function anchorInstructions(entries: unknown[]): string {
  return formatAnchors(extractAnchors(entries));
}
