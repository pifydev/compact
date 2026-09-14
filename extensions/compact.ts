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
import { DEFAULT_SETTINGS, resolveSettings, type CompactSettings } from "../src/settings.ts";

type UiContext = ExtensionContext;

const CUSTOM_INSTRUCTIONS =
  "Preserve the current task and enough state to resume it seamlessly after compaction: the goal, " +
  "recent decisions, the files and commands in play, and any open thread. Summarize the rest.";

export default function compact(pi: ExtensionAPI) {
  let settings: CompactSettings = DEFAULT_SETTINGS;
  /** null = pi's compaction state unknown; true/false once determined. */
  let active = false;
  let compacting = false;
  /** Per-session override from /autocompact on|off, wins over settings. */
  let sessionEnabled: boolean | null = null;

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

  function runCompaction(ctx: UiContext, forced: boolean): void {
    compacting = true;
    ctx.compact({
      customInstructions: CUSTOM_INSTRUCTIONS,
      onComplete: (result) => {
        compacting = false;
        const before = result.tokensBefore;
        const after = result.estimatedTokensAfter;
        const delta = typeof after === "number" ? `~${fmt(before)} → ~${fmt(after)} tokens` : `~${fmt(before)} tokens`;
        if (ctx.hasUI) ctx.ui.notify(`${forced ? "Compacted" : "Auto-compacted"}: ${delta}.`, "info");
      },
      onError: (err) => {
        compacting = false;
        if (ctx.hasUI) ctx.ui.notify(`Auto-compaction failed: ${err.message}`, "warning");
      },
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
    if (!enabled()) return;
    const verdict = shouldCompact(ctx.getContextUsage(), {
      active,
      compacting,
      thresholdPercent: settings.thresholdPercent,
      maxTokens: settings.maxTokens,
    });
    if (verdict.compact) runCompaction(ctx, false);
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
