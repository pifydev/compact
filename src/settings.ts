/**
 * Settings for @pify/compact. The one real knob is the threshold: how full the
 * context window may get before it is compacted between turns. Read from
 * `.pi/compact.json` (project) or `<agentDir>/compact.json` (global), with a
 * PIFY_COMPACT_THRESHOLD env override. Bad values fall back with a warning.
 */

export interface CompactSettings {
  /** Percent of the context window at which to compact (1–99). */
  thresholdPercent: number;
  /** Master switch; when false the extension never compacts. */
  enabled: boolean;
}

export const DEFAULT_SETTINGS: CompactSettings = {
  thresholdPercent: 80,
  enabled: true,
};

const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 99;

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
      for (const key of Object.keys(obj)) {
        if (key !== "thresholdPercent" && key !== "enabled") warnings.push(`unknown setting "${key}"`);
      }
      if ("enabled" in obj) {
        if (typeof obj.enabled === "boolean") settings.enabled = obj.enabled;
        else warnings.push(`"enabled" must be true or false — using ${DEFAULT_SETTINGS.enabled}`);
      }
      if ("thresholdPercent" in obj) {
        const v = obj.thresholdPercent;
        if (typeof v === "number" && Number.isFinite(v)) settings.thresholdPercent = clamp(v, warnings);
        else warnings.push(`"thresholdPercent" must be a number — using ${DEFAULT_SETTINGS.thresholdPercent}`);
      }
    }
  }

  const envT = env.PIFY_COMPACT_THRESHOLD;
  if (envT !== undefined && envT !== "") {
    const n = Number(envT);
    if (Number.isFinite(n)) settings.thresholdPercent = clamp(n, warnings);
    else warnings.push(`PIFY_COMPACT_THRESHOLD="${envT}" is not a number — ignored`);
  }

  return { settings, warnings };
}

function clamp(v: number, warnings: string[]): number {
  const c = Math.round(Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, v)));
  if (c !== v) warnings.push(`thresholdPercent clamped to ${c} (allowed ${MIN_THRESHOLD}–${MAX_THRESHOLD})`);
  return c;
}
