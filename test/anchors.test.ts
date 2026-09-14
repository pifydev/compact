import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAnchors, formatAnchors, hasAnchors, anchorInstructions } from "../src/anchors.ts";

const user = (text: string) => ({ message: { role: "user", content: [{ type: "text", text }] } });
const toolCall = (name: string, args: Record<string, unknown>) => ({
  message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
});
const toolResult = (text: string, isError = false) => ({
  isError,
  message: { role: "toolResult", content: [{ type: "text", text }] },
});

test("extracts the first task as the goal and a later scope change", () => {
  const a = extractAnchors([
    user("Implement a rate limiter for the API"),
    user("Actually, let's use a token bucket instead"),
  ]);
  assert.match(a.goal ?? "", /rate limiter/i);
  assert.match(a.scopeChange ?? "", /token bucket/i);
});

test("ignores noise-only first user turns for the goal", () => {
  assert.equal(extractAnchors([user("ok"), user("thanks")]).goal, null);
});

test("classifies files into modified vs read (read-only excluded from modified)", () => {
  const a = extractAnchors([
    toolCall("edit", { path: "src/limiter.ts" }),
    toolCall("read", { path: "src/api.ts" }),
    toolCall("read", { path: "src/limiter.ts" }), // also read, but it was modified
  ]);
  assert.ok(a.filesModified.some((f) => f.includes("limiter.ts")), JSON.stringify(a.filesModified));
  assert.ok(a.filesRead.some((f) => f.includes("api.ts")), JSON.stringify(a.filesRead));
  assert.ok(!a.filesRead.some((f) => f.includes("limiter.ts")), "a modified file is not also listed as read");
});

test("pairs a git commit message with the hash from its result", () => {
  const a = extractAnchors([
    toolCall("bash", { command: 'git commit -m "add limiter"' }),
    toolResult("[main a1b2c3d] add limiter\n 1 file changed"),
  ]);
  assert.equal(a.commits.length, 1);
  assert.match(a.commits[0]!, /a1b2c3d/);
  assert.match(a.commits[0]!, /add limiter/);
});

test("captures preferences from user turns but not questions", () => {
  const a = extractAnchors([
    user("Implement the parser"),
    user("Please always use tabs, never spaces"),
    user("should I use spaces?"),
  ]);
  assert.ok(a.preferences.some((p) => /tabs/i.test(p)), JSON.stringify(a.preferences));
  assert.ok(!a.preferences.some((p) => /should I/i.test(p)));
});

test("captures a recent blocker from an errored tool result in the tail", () => {
  const entries = [user("Implement X"), toolResult("Error: test failed: timeout waiting for server", true)];
  const a = extractAnchors(entries);
  assert.ok(a.blockers.some((b) => /test failed/i.test(b)), JSON.stringify(a.blockers));
});

test("formatAnchors renders only non-empty sections, and empty input yields nothing", () => {
  assert.equal(formatAnchors(extractAnchors([])), "");
  assert.equal(hasAnchors(extractAnchors([])), false);
  assert.equal(anchorInstructions([]), "");

  const text = formatAnchors(
    extractAnchors([user("Implement a rate limiter"), toolCall("edit", { path: "src/limiter.ts" })]),
  );
  assert.match(text, /Preserve these exact facts/);
  assert.match(text, /Task: .*rate limiter/i);
  assert.match(text, /Files modified: .*limiter\.ts/);
  assert.ok(!/Files read:/.test(text), "empty sections are omitted");
});

test("never throws on malformed entries", () => {
  const a = extractAnchors([null, 42, "nonsense", {}, { message: null }, { message: { role: "user" } }] as unknown[]);
  assert.equal(hasAnchors(a), false);
});
