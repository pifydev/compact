/**
 * Settings for @pify/compact. The one real knob is the threshold: how full the
 * context window may get before it is compacted between turns. Read from
 * `.pi/compact.json` (project) or `<agentDir>/compact.json` (global), with a
 * PIFY_COMPACT_THRESHOLD env override. Bad values fall back with a warning.
 */

export interface CompactSettings {
  /** Percent of the context window at which to compact (1–99). */
  thresholdPercent: number;
  /** Absolute token ceiling that also triggers compaction; 0 = off. Useful on */
  /** huge windows where the percentage never trips before the session is vast. */
  maxTokens: number;
  /** Minimum token growth since the last compaction before the PERCENT trigger */
  /** fires again; 0 = off. Avoids re-compacting when a compaction freed little */
  /** and the percentage is still near the threshold. The ceiling ignores it. */
  minGrowthTokens: number;
  /** Collapse degenerate single-codepoint runs in the outbound context so a */
  /** poisoned assistant tail can't loop the session into aborts. Default on. */
  degenerationGuard: boolean;
  /** Minimum run length (codepoints) that counts as degeneration; floored at 8. */
  degenerationMinRun: number;
  /** Also compact at contextWindow − reserveTokens, so a response always has room. */
  reserveAware: boolean;
  /** Steer pi's summary with a deterministic list of facts (files/goals/…) to keep. */
  anchors: boolean;
  /** Compact before a prompt is sent when it would push the window over threshold. */
  preflight: boolean;
  /** Master switch; when false the extension never compacts. */
  enabled: boolean;
}

export const DEFAULT_SETTINGS: CompactSettings = {
  thresholdPercent: 80,
  maxTokens: 0,
  minGrowthTokens: 0,
  degenerationGuard: true,
  degenerationMinRun: 200,
  reserveAware: true,
  anchors: true,
  preflight: true,
  enabled: true,
};

const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 99;
const MAX_TOKENS_CEILING = 4_000_000;
const MIN_DEGENERATION_RUN = 8;

export function resolveSettings(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { settings: CompactSettings; warnings: string[] } {
  const settings: CompactSettings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];

  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push("settings file is not an object — ignored");
    } else {
      const obj = raw as Record<string, unknown>;
      const known = new Set([
        "thresholdPercent",
        "enabled",
        "maxTokens",
        "minGrowthTokens",
        "degenerationGuard",
        "degenerationMinRun",
        "reserveAware",
        "anchors",
        "preflight",
      ]);
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) warnings.push(`unknown setting "${key}"`);
      }
      if ("enabled" in obj) {
        if (typeof obj.enabled === "boolean") settings.enabled = obj.enabled;
        else warnings.push(`"enabled" must be true or false — using ${DEFAULT_SETTINGS.enabled}`);
      }
      if ("thresholdPercent" in obj) {
        const v = obj.thresholdPercent;
        if (typeof v === "number" && Number.isFinite(v)) settings.thresholdPercent = clampThreshold(v, warnings);
        else warnings.push(`"thresholdPercent" must be a number — using ${DEFAULT_SETTINGS.thresholdPercent}`);
      }
      if ("maxTokens" in obj) {
        const v = obj.maxTokens;
        if (typeof v === "number" && Number.isFinite(v)) settings.maxTokens = clampTokens(v, warnings);
        else warnings.push(`"maxTokens" must be a number — using ${DEFAULT_SETTINGS.maxTokens}`);
      }
      if ("minGrowthTokens" in obj) {
        const v = obj.minGrowthTokens;
        if (typeof v === "number" && Number.isFinite(v)) settings.minGrowthTokens = clampTokens(v, warnings, "minGrowthTokens");
        else warnings.push(`"minGrowthTokens" must be a number — using ${DEFAULT_SETTINGS.minGrowthTokens}`);
      }
      if ("degenerationGuard" in obj) {
        if (typeof obj.degenerationGuard === "boolean") settings.degenerationGuard = obj.degenerationGuard;
        else warnings.push(`"degenerationGuard" must be true or false — using ${DEFAULT_SETTINGS.degenerationGuard}`);
      }
      if ("degenerationMinRun" in obj) {
        const v = obj.degenerationMinRun;
        if (typeof v === "number" && Number.isFinite(v)) settings.degenerationMinRun = clampMinRun(v, warnings);
        else warnings.push(`"degenerationMinRun" must be a number — using ${DEFAULT_SETTINGS.degenerationMinRun}`);
      }
      for (const key of ["reserveAware", "anchors", "preflight"] as const) {
        if (key in obj) {
          if (typeof obj[key] === "boolean") settings[key] = obj[key] as boolean;
          else warnings.push(`"${key}" must be true or false — using ${DEFAULT_SETTINGS[key]}`);
        }
      }
    }
  }

  const envT = env.PIFY_COMPACT_THRESHOLD;
  if (envT !== undefined && envT !== "") {
    const n = Number(envT);
    if (Number.isFinite(n)) settings.thresholdPercent = clampThreshold(n, warnings);
    else warnings.push(`PIFY_COMPACT_THRESHOLD="${envT}" is not a number — ignored`);
  }
  const envMax = env.PIFY_COMPACT_MAX_TOKENS;
  if (envMax !== undefined && envMax !== "") {
    const n = Number(envMax);
    if (Number.isFinite(n)) settings.maxTokens = clampTokens(n, warnings);
    else warnings.push(`PIFY_COMPACT_MAX_TOKENS="${envMax}" is not a number — ignored`);
  }
  const envGrowth = env.PIFY_COMPACT_MIN_GROWTH;
  if (envGrowth !== undefined && envGrowth !== "") {
    const n = Number(envGrowth);
    if (Number.isFinite(n)) settings.minGrowthTokens = clampTokens(n, warnings, "minGrowthTokens");
    else warnings.push(`PIFY_COMPACT_MIN_GROWTH="${envGrowth}" is not a number — ignored`);
  }

  return { settings, warnings };
}

function clampThreshold(v: number, warnings: string[]): number {
  const c = Math.round(Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, v)));
  if (c !== v) warnings.push(`thresholdPercent clamped to ${c} (allowed ${MIN_THRESHOLD}–${MAX_THRESHOLD})`);
  return c;
}

function clampTokens(v: number, warnings: string[], field = "maxTokens"): number {
  // 0 = off; any other value is a real ceiling floored at 1000 and capped.
  const c = v <= 0 ? 0 : Math.round(Math.min(MAX_TOKENS_CEILING, Math.max(1000, v)));
  if (c !== v) warnings.push(`${field} clamped to ${c} (0 = off, else 1000–${MAX_TOKENS_CEILING})`);
  return c;
}

function clampMinRun(v: number, warnings: string[]): number {
  const c = Math.round(Math.max(MIN_DEGENERATION_RUN, v));
  if (c !== v) warnings.push(`degenerationMinRun clamped to ${c} (minimum ${MIN_DEGENERATION_RUN})`);
  return c;
}
