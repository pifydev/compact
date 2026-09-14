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

test("growth gate holds off the percentage trigger until real regrowth", () => {
  // At the threshold but only 5k grown since the last compaction (baseline 90k)
  // with a 20k minimum → held off.
  const held = shouldCompact(
    { percent: 82, tokens: 95_000 },
    state({ minGrowthTokens: 20_000, lastCompactedTokens: 90_000 }),
  );
  assert.equal(held.compact, false);
  assert.match(held.reason, /growth since last compaction/);
  // Once it has grown past the minimum → compacts.
  assert.equal(
    shouldCompact({ percent: 82, tokens: 115_000 }, state({ minGrowthTokens: 20_000, lastCompactedTokens: 90_000 })).compact,
    true,
  );
});

test("growth gate is off by default and never blocks the first compaction", () => {
  // minGrowthTokens 0 → gate inert even with a baseline present.
  assert.equal(
    shouldCompact({ percent: 82, tokens: 95_000 }, state({ minGrowthTokens: 0, lastCompactedTokens: 90_000 })).compact,
    true,
  );
  // No baseline yet (null) → gate cannot apply, threshold governs.
  assert.equal(
    shouldCompact({ percent: 82, tokens: 95_000 }, state({ minGrowthTokens: 20_000, lastCompactedTokens: null })).compact,
    true,
  );
});

test("the ceiling ignores the growth gate — a hard ceiling is never held back", () => {
  const d = shouldCompact(
    { percent: 30, tokens: 300_000 },
    state({ maxTokens: 250_000, minGrowthTokens: 100_000, lastCompactedTokens: 299_000 }),
  );
  assert.equal(d.compact, true);
  assert.match(d.reason, /ceiling/);
});
