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
