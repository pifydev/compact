/**
 * @pify/compact — proactive auto-compaction.
 *
 * A long session eventually fills the context window; without intervention the
 * run stalls and you restart. pi has built-in compaction, but if you turn it
 * off (or want a different threshold), this fills the gap: when context usage
 * crosses a threshold, it compacts BETWEEN turns.
 *
 * The trigger is `agent_settled` — fired once the run has fully settled, with no
 * retry, compaction, or queued continuation pending. Compacting there means the
 * agent is idle, so `ctx.compact()` never aborts a live run — which sidesteps
 * the spurious "operation aborted" message (and the fragile rewrite of it) that
 * mid-run compaction requires. The next turn simply goes out with a smaller
 * context.
 *
 * It stays DORMANT unless pi's own compaction is off, so the two never
 * double-compact; when it cannot determine pi's setting it errs to dormant.
 * Zero runtime dependencies; local, no extra model calls of its own.
 */
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { shouldCompact } from "../src/decide.ts";
import { guardDegeneration } from "../src/degenerate.ts";
import { anchorInstructions } from "../src/anchors.ts";
import { dispatchCompact } from "../src/dispatch.ts";
import { DEFAULT_SETTINGS, resolveSettings, type CompactSettings } from "../src/settings.ts";

type UiContext = ExtensionContext;

const CUSTOM_INSTRUCTIONS =
  "Preserve the current task and enough state to resume it seamlessly after compaction: the goal, " +
  "recent decisions, the files and commands in play, and any open thread. Do not drop unfinished work, " +
  "and do not make unfinished work sound finished — keep every pending check, tentative finding, blocker, " +
  "and open question. Summarize the rest.";

/** Rough token cost of one attached image, for next-turn overflow projection. */
const IMAGE_TOKEN_ESTIMATE = 1600;

/** Conservative token estimate for a pending prompt (chars/4 + per-image cost). */
function estimatePromptTokens(text: string | undefined, images: unknown): number {
  const t = typeof text === "string" ? Math.ceil(text.length / 4) : 0;
  const img = Array.isArray(images) ? images.length * IMAGE_TOKEN_ESTIMATE : 0;
  return t + img;
}

export default function compact(pi: ExtensionAPI) {
  let settings: CompactSettings = DEFAULT_SETTINGS;
  /** null = pi's compaction state unknown; true/false once determined. */
  let active = false;
  let compacting = false;
  /** Per-session override from /autocompact on|off, wins over settings. */
  let sessionEnabled: boolean | null = null;
  /** Tokens in use at the last compaction — the growth-gate baseline. */
  let lastCompactedTokens: number | null = null;

  function loadSettings(cwd: string): string[] {
    for (const file of [join(cwd, ".pi", "compact.json"), join(getAgentDir(), "compact.json")]) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = resolveSettings(JSON.parse(raw));
        settings = parsed.settings;
        return parsed.warnings;
      } catch (err) {
        settings = DEFAULT_SETTINGS;
        return [`${file}: ${err instanceof Error ? err.message : String(err)}`];
      }
    }
    const parsed = resolveSettings(undefined);
    settings = parsed.settings;
    return parsed.warnings;
  }

  /** Silent hot-reload: re-read the settings file, keeping the last-good values */
  /** on a parse error so a mid-edit save never resets to defaults. */
  function reloadSettings(cwd: string): void {
    for (const file of [join(cwd, ".pi", "compact.json"), join(getAgentDir(), "compact.json")]) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      try {
        settings = resolveSettings(JSON.parse(raw)).settings;
      } catch {
        // keep the previously loaded settings
      }
      return;
    }
    settings = resolveSettings(undefined).settings;
  }

  /** contextWindow − reserveTokens (0 when disabled/unavailable): the point past */
  /** which too little room is left for the model's response. */
  function reserveCeiling(ctx: UiContext, window: number): number {
    if (!settings.reserveAware || !window) return 0;
    try {
      const projectTrusted = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false;
      const sm = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
      const ceiling = window - Math.max(0, sm.getCompactionReserveTokens());
      return ceiling > 0 ? ceiling : 0;
    } catch {
      return 0;
    }
  }

  /** Base instructions plus a deterministic anchor list, when enabled and present. */
  function compactionInstructions(ctx: UiContext): string {
    if (!settings.anchors) return CUSTOM_INSTRUCTIONS;
    let extra = "";
    try {
      const branch = (ctx.sessionManager as { getBranch?: () => unknown[] }).getBranch?.() ?? [];
      extra = anchorInstructions(branch);
    } catch {
      extra = "";
    }
    return extra ? `${CUSTOM_INSTRUCTIONS}\n\n${extra}` : CUSTOM_INSTRUCTIONS;
  }

  /** True only when we can confirm pi's built-in compaction is OFF. */
  function piCompactionOff(ctx: UiContext): boolean {
    try {
      const projectTrusted = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false;
      const sm = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
      return sm.getCompactionEnabled() === false;
    } catch {
      return false; // unknown → treat pi's as on → stay dormant (never double-compact)
    }
  }

  function enabled(): boolean {
    return sessionEnabled ?? settings.enabled;
  }

  function onCompactComplete(ctx: UiContext, forced: boolean, result: { tokensBefore: number; estimatedTokensAfter?: number }): void {
    compacting = false;
    const before = result.tokensBefore;
    const after = result.estimatedTokensAfter;
    // Reset the growth-gate baseline to the post-compaction size, so the next
    // percentage-triggered compaction waits for real regrowth.
    if (typeof after === "number") lastCompactedTokens = after;
    const delta = typeof after === "number" ? `~${fmt(before)} → ~${fmt(after)} tokens` : `~${fmt(before)} tokens`;
    if (ctx.hasUI) ctx.ui.notify(`${forced ? "Compacted" : "Auto-compacted"}: ${delta}.`, "info");
  }

  function onCompactError(ctx: UiContext, err: Error): void {
    compacting = false;
    const msg = err?.message || String(err);
    // "Nothing to compact" / "Already compacted" are benign — the context is
    // simply already small enough; report as info, not a failure.
    if (/nothing to compact|already compacted/i.test(msg)) {
      if (ctx.hasUI) ctx.ui.notify(`Auto-compaction skipped: ${msg}.`, "info");
      return;
    }
    if (ctx.hasUI) ctx.ui.notify(`Auto-compaction failed: ${msg}`, "warning");
  }

  function runCompaction(ctx: UiContext, forced: boolean): void {
    compacting = true;
    // dispatchCompact routes a SYNCHRONOUS throw from ctx.compact() through
    // onError (→ onCompactError), so a synchronous failure still clears the
    // `compacting` flag instead of stranding it true and disabling us for good.
    dispatchCompact(ctx, {
      customInstructions: compactionInstructions(ctx),
      onComplete: (result) => onCompactComplete(ctx, forced, result),
      onError: (err) => onCompactError(ctx, err),
    });
  }

  /** Trigger a compaction and resolve once it has settled (for the preflight). */
  function compactAndWait(ctx: UiContext): Promise<void> {
    return new Promise((resolve) => {
      compacting = true;
      // A SYNCHRONOUS throw here would otherwise leave both the `compacting`
      // flag stuck true and this promise unresolved, so the input hook never
      // returns. Route it through onError, which clears the flag and resolves.
      dispatchCompact(ctx, {
        customInstructions: compactionInstructions(ctx),
        onComplete: (result) => {
          onCompactComplete(ctx, false, result);
          resolve();
        },
        onError: (err) => {
          onCompactError(ctx, err);
          resolve();
        },
      });
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const warnings = loadSettings(ctx.cwd);
    active = piCompactionOff(ctx);
    if (ctx.hasUI) {
      if (warnings.length > 0) ctx.ui.notify(`compact settings: ${warnings.join("; ")}`, "warning");
      if (!active) {
        ctx.ui.setStatus("compact", undefined);
      }
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    reloadSettings(ctx.cwd); // pick up live edits to .pi/compact.json between turns
    if (!enabled()) return;
    const usage = ctx.getContextUsage();
    const verdict = shouldCompact(usage, {
      active,
      compacting,
      thresholdPercent: settings.thresholdPercent,
      maxTokens: settings.maxTokens,
      reserveCeiling: reserveCeiling(ctx, usage?.contextWindow ?? 0),
      minGrowthTokens: settings.minGrowthTokens,
      lastCompactedTokens,
    });
    if (verdict.compact) runCompaction(ctx, false);
  });

  // Preflight: a large paste can overflow the very next turn, which agent_settled
  // (reactive to CURRENT usage) can't foresee. On a fresh prompt while idle,
  // project current tokens + the prompt's estimated cost and compact first if
  // that would cross the threshold, so the turn goes out against a fitting window.
  pi.on("input", async (event, ctx): Promise<{ action: "continue" }> => {
    if (!settings.preflight || !enabled() || !active || compacting) return { action: "continue" };
    if (event.streamingBehavior !== undefined) return { action: "continue" }; // mid-run steer/followUp
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? 0;
    const current = usage?.tokens ?? null;
    if (!window || current === null) return { action: "continue" };
    const projected = current + estimatePromptTokens(event.text, event.images);
    const verdict = shouldCompact(
      { percent: (projected / window) * 100, tokens: projected },
      {
        active,
        compacting,
        thresholdPercent: settings.thresholdPercent,
        maxTokens: settings.maxTokens,
        reserveCeiling: reserveCeiling(ctx, window),
        minGrowthTokens: settings.minGrowthTokens,
        lastCompactedTokens,
      },
    );
    if (verdict.compact) await compactAndWait(ctx);
    return { action: "continue" };
  });

  // A safety pass on the OUTBOUND context, independent of the compaction gate
  // above (it runs even while dormant): collapse degenerate single-codepoint
  // runs in assistant text/thinking so a poisoned tail can't ride every later
  // prompt and loop the session into aborts. Returns undefined when the context
  // is clean, so a healthy session is a true no-op and the prompt cache holds.
  pi.on("context", async (event) => {
    if (!settings.degenerationGuard) return undefined;
    const msgs = event.messages as unknown[];
    const guarded = guardDegeneration(msgs as never[], settings.degenerationMinRun, Date.now());
    return guarded === msgs ? undefined : { messages: guarded as never };
  });

  pi.registerCommand("autocompact", {
    description: "Auto-compaction: /autocompact [status | now | on | off]",
    handler: async (args, ctx: UiContext) => {
      if (!ctx.hasUI) return;
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        sessionEnabled = arg === "on";
        ctx.ui.notify(`Auto-compaction ${sessionEnabled ? "on" : "off"} for this session.`, "info");
        return;
      }
      if (arg === "now") {
        if (!active) {
          ctx.ui.notify("Dormant: pi's built-in compaction is on (or its state is unknown).", "warning");
          return;
        }
        if (compacting) {
          ctx.ui.notify("A compaction is already running.", "warning");
          return;
        }
        if ((ctx.getContextUsage()?.percent ?? null) === null) {
          ctx.ui.notify("Context usage is unknown right now — try again after the next response.", "warning");
          return;
        }
        runCompaction(ctx, true);
        return;
      }
      // status
      const pct = ctx.getContextUsage()?.percent;
      const at = typeof pct === "number" ? `${Math.round(pct)}%` : "unknown";
      const state = !enabled() ? "off" : active ? `active, threshold ${settings.thresholdPercent}%` : "dormant (pi's built-in compaction is on)";
      ctx.ui.notify(`Auto-compaction: ${state}. Context now at ${at}.`, "info");
    },
  });
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
