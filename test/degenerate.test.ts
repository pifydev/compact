import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findDegenerateRuns,
  collapseDegenerateRuns,
  collapseAssistantDegeneration,
  degenerationNotice,
  guardDegeneration,
  DEFAULT_MIN_RUN,
} from "../src/degenerate.ts";

const NOW = 1_700_000_000_000;

test("findDegenerateRuns detects a long single-codepoint run", () => {
  const runs = findDegenerateRuns("hello" + "【".repeat(300) + "world", 200);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.char, "【");
  assert.equal(runs[0]!.count, 300);
  assert.equal(runs[0]!.index, 5);
});

test("findDegenerateRuns ignores runs under the threshold", () => {
  assert.deepEqual(findDegenerateRuns("=".repeat(60), 200), []); // an hrule is fine
  assert.deepEqual(findDegenerateRuns("", 200), []);
});

test("findDegenerateRuns is codepoint-safe (astral chars count as one)", () => {
  const runs = findDegenerateRuns("😀".repeat(250), 200);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.count, 250);
  assert.equal(runs[0]!.char, "😀");
});

test("collapseDegenerateRuns replaces the run with a short marker and is idempotent", () => {
  const text = "a".repeat(400);
  const once = collapseDegenerateRuns(text, 200);
  assert.ok(once.length < text.length);
  assert.match(once, /400× identical chars cut/);
  // Re-running does not collapse inside the marker.
  assert.equal(collapseDegenerateRuns(once, 200), once);
});

test("collapseAssistantDegeneration only touches assistant text/thinking, never tool args", () => {
  const messages = [
    { role: "user", content: "x".repeat(400) }, // user content left alone
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "z".repeat(400) },
        { type: "text", text: "ok" },
        { type: "tool_call", input: { cmd: "q".repeat(400) } }, // args untouched
      ],
    },
  ];
  const { messages: out, evidence } = collapseAssistantDegeneration(messages, 200);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.msgIndex, 1);
  assert.deepEqual(evidence[0]!.blocks, ["thinking"]);
  // user message unchanged (same reference)
  assert.equal(out[0], messages[0]);
  const block = (out[1]!.content as { type: string; thinking?: string; input?: unknown }[]);
  assert.match(block[0]!.thinking as string, /400× identical chars cut/);
  assert.deepEqual(block[2]!.input, { cmd: "q".repeat(400) }); // tool args intact
});

test("collapseAssistantDegeneration returns the same array reference when clean (cache-safe)", () => {
  const messages = [{ role: "assistant", content: [{ type: "text", text: "all good" }] }];
  const { messages: out, evidence } = collapseAssistantDegeneration(messages, 200);
  assert.equal(out, messages);
  assert.deepEqual(evidence, []);
});

test("guardDegeneration appends a recovery notice when the last assistant turn was degenerate", () => {
  const messages = [
    { role: "user", content: "do the thing" },
    { role: "assistant", content: [{ type: "thinking", thinking: "【".repeat(500) }] },
  ];
  const out = guardDegeneration(messages, 200, NOW);
  assert.equal(out.length, 3);
  const notice = out[2] as { role: string; content: { text: string }[] };
  assert.equal(notice.role, "user");
  assert.match(notice.content[0]!.text, /recovery notice/);
  assert.match(notice.content[0]!.text, /500 consecutive repetitions/);
});

test("guardDegeneration does not append a notice when a clean assistant turn follows the degenerate one", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "【".repeat(500) }] }, // old, degenerate
    { role: "user", content: "continue" },
    { role: "assistant", content: [{ type: "text", text: "back on track" }] }, // newest, clean
  ];
  const out = guardDegeneration(messages, 200, NOW);
  // The old run is still collapsed, but no notice is appended (last turn clean).
  assert.equal(out.length, 3);
  assert.match((out[0]!.content as { text: string }[])[0]!.text, /identical chars cut/);
});

test("guardDegeneration is a true no-op (same reference) on a healthy context", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];
  assert.equal(guardDegeneration(messages, 200, NOW), messages);
});

test("guardDegeneration floors an out-of-range minRun to a safe default", () => {
  // minRun 0 would be nonsensical; it normalizes to DEFAULT_MIN_RUN, so a short
  // hrule is not treated as degeneration.
  const messages = [{ role: "assistant", content: [{ type: "text", text: "-".repeat(40) }] }];
  assert.equal(guardDegeneration(messages, 0, NOW), messages);
  assert.ok(DEFAULT_MIN_RUN >= 8);
});

test("degenerationNotice names the largest run and counts the rest", () => {
  const notice = degenerationNotice(
    [
      { char: "a", count: 10, index: 0 },
      { char: "b", count: 999, index: 20 },
    ],
    NOW,
  ) as { content: { text: string }[]; timestamp: number };
  assert.match(notice.content[0]!.text, /999 consecutive repetitions of "b"/);
  assert.match(notice.content[0]!.text, /1 other repeated segment/);
  assert.equal(notice.timestamp, NOW);
});
