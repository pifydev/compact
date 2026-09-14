import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCompact } from "../src/decide.ts";

const state = (over = {}) => ({ active: true, compacting: false, thresholdPercent: 80, ...over });

test("compacts at or above the threshold when active and idle", () => {
  assert.equal(shouldCompact({ percent: 80 }, state()).compact, true);
  assert.equal(shouldCompact({ percent: 95 }, state()).compact, true);
});

test("does not compact below the threshold", () => {
  const d = shouldCompact({ percent: 79 }, state());
  assert.equal(d.compact, false);
  assert.match(d.reason, /below threshold/);
});

test("dormant when pi's built-in compaction is on (not active)", () => {
  const d = shouldCompact({ percent: 99 }, state({ active: false }));
  assert.equal(d.compact, false);
  assert.match(d.reason, /dormant/);
});

test("never compacts while a compaction is already running", () => {
  assert.equal(shouldCompact({ percent: 99 }, state({ compacting: true })).compact, false);
});

test("unknown usage (null percent) never triggers — avoids looping post-compaction", () => {
  assert.equal(shouldCompact({ percent: null }, state()).compact, false);
  assert.equal(shouldCompact(undefined, state()).compact, false);
});

test("a custom threshold is respected", () => {
  assert.equal(shouldCompact({ percent: 50 }, state({ thresholdPercent: 50 })).compact, true);
  assert.equal(shouldCompact({ percent: 49 }, state({ thresholdPercent: 50 })).compact, false);
});

test("an absolute token ceiling fires where the percentage never would", () => {
  // 300k of a 1M window is only 30% — under the 80% threshold — but past the ceiling.
  const d = shouldCompact({ percent: 30, tokens: 300_000 }, state({ maxTokens: 250_000 }));
  assert.equal(d.compact, true);
  assert.match(d.reason, /ceiling/);
  // Below both the percentage and the ceiling → no compaction.
  assert.equal(shouldCompact({ percent: 30, tokens: 200_000 }, state({ maxTokens: 250_000 })).compact, false);
  // Ceiling off (0) → percentage governs as before.
  assert.equal(shouldCompact({ percent: 30, tokens: 900_000 }, state({ maxTokens: 0 })).compact, false);
});
