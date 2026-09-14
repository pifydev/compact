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

test("PIFY_COMPACT_THRESHOLD overrides", () => {
  assert.equal(resolveSettings({ thresholdPercent: 80 }, { PIFY_COMPACT_THRESHOLD: "60" }).settings.thresholdPercent, 60);
  const bad = resolveSettings(undefined, { PIFY_COMPACT_THRESHOLD: "soon" });
  assert.equal(bad.settings.thresholdPercent, DEFAULT_SETTINGS.thresholdPercent);
  assert.ok(bad.warnings.some((w) => w.includes("not a number")));
});
