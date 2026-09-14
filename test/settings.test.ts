import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

test("defaults when there is no config", () => {
  const { settings, warnings } = resolveSettings(undefined, {});
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.deepEqual(warnings, []);
});

test("valid overrides are taken", () => {
  const { settings } = resolveSettings({ thresholdPercent: 65, enabled: false }, {});
  assert.equal(settings.thresholdPercent, 65);
  assert.equal(settings.enabled, false);
});

test("threshold is clamped to 1–99 with a warning", () => {
  assert.equal(resolveSettings({ thresholdPercent: 250 }, {}).settings.thresholdPercent, 99);
  assert.equal(resolveSettings({ thresholdPercent: 0 }, {}).settings.thresholdPercent, 1);
  assert.ok(resolveSettings({ thresholdPercent: 250 }, {}).warnings.some((w) => w.includes("clamped")));
});

test("wrong types and unknown keys warn and fall back", () => {
  const { settings, warnings } = resolveSettings({ thresholdPercent: "high", nope: 1 }, {});
  assert.equal(settings.thresholdPercent, DEFAULT_SETTINGS.thresholdPercent);
  assert.ok(warnings.some((w) => w.includes("must be a number")));
  assert.ok(warnings.some((w) => w.includes('unknown setting "nope"')));
});

test("maxTokens: 0 is off, positive values are floored and capped", () => {
  assert.equal(resolveSettings({ maxTokens: 0 }, {}).settings.maxTokens, 0);
  assert.equal(resolveSettings({ maxTokens: 300_000 }, {}).settings.maxTokens, 300_000);
  assert.equal(resolveSettings({ maxTokens: 50 }, {}).settings.maxTokens, 1000, "tiny positive floored to 1000");
  assert.ok(resolveSettings({ maxTokens: 99_000_000 }, {}).settings.maxTokens < 99_000_000, "capped");
  assert.equal(resolveSettings(undefined, { PIFY_COMPACT_MAX_TOKENS: "250000" }).settings.maxTokens, 250_000);
});

test("PIFY_COMPACT_THRESHOLD overrides", () => {
  assert.equal(resolveSettings({ thresholdPercent: 80 }, { PIFY_COMPACT_THRESHOLD: "60" }).settings.thresholdPercent, 60);
  const bad = resolveSettings(undefined, { PIFY_COMPACT_THRESHOLD: "soon" });
  assert.equal(bad.settings.thresholdPercent, DEFAULT_SETTINGS.thresholdPercent);
  assert.ok(bad.warnings.some((w) => w.includes("not a number")));
});

test("minGrowthTokens: 0 off by default, positive floored/capped, env override", () => {
  assert.equal(DEFAULT_SETTINGS.minGrowthTokens, 0);
  assert.equal(resolveSettings({ minGrowthTokens: 30_000 }, {}).settings.minGrowthTokens, 30_000);
  assert.equal(resolveSettings({ minGrowthTokens: 50 }, {}).settings.minGrowthTokens, 1000, "tiny positive floored");
  const capped = resolveSettings({ minGrowthTokens: 99_000_000 }, {});
  assert.ok(capped.settings.minGrowthTokens < 99_000_000);
  assert.ok(capped.warnings.some((w) => w.includes("minGrowthTokens clamped")));
  assert.equal(resolveSettings(undefined, { PIFY_COMPACT_MIN_GROWTH: "40000" }).settings.minGrowthTokens, 40_000);
});

test("degenerationGuard: default on, boolean validated", () => {
  assert.equal(DEFAULT_SETTINGS.degenerationGuard, true);
  assert.equal(resolveSettings({ degenerationGuard: false }, {}).settings.degenerationGuard, false);
  const bad = resolveSettings({ degenerationGuard: "yes" }, {});
  assert.equal(bad.settings.degenerationGuard, true);
  assert.ok(bad.warnings.some((w) => w.includes("degenerationGuard")));
});

test("degenerationMinRun: default 200, floored at 8", () => {
  assert.equal(DEFAULT_SETTINGS.degenerationMinRun, 200);
  assert.equal(resolveSettings({ degenerationMinRun: 500 }, {}).settings.degenerationMinRun, 500);
  const floored = resolveSettings({ degenerationMinRun: 3 }, {});
  assert.equal(floored.settings.degenerationMinRun, 8);
  assert.ok(floored.warnings.some((w) => w.includes("degenerationMinRun clamped")));
});

test("reserveAware / anchors / preflight: booleans that default on", () => {
  assert.equal(DEFAULT_SETTINGS.reserveAware, true);
  assert.equal(DEFAULT_SETTINGS.anchors, true);
  assert.equal(DEFAULT_SETTINGS.preflight, true);
  const off = resolveSettings({ reserveAware: false, anchors: false, preflight: false }, {});
  assert.equal(off.settings.reserveAware, false);
  assert.equal(off.settings.anchors, false);
  assert.equal(off.settings.preflight, false);
  assert.deepEqual(off.warnings, []);
  const bad = resolveSettings({ anchors: "yes" }, {});
  assert.equal(bad.settings.anchors, true);
  assert.ok(bad.warnings.some((w) => w.includes('"anchors" must be true or false')));
});
