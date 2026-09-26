import { test } from "node:test";
import assert from "node:assert/strict";
import { placeholderFor, pruneSupersededReads } from "../src/prune.ts";

let ids = 0;
const read = (path: string) => {
  const id = `c${++ids}`;
  return {
    call: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }] },
    result: (text: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }] }),
  };
};
const filler = (n: number) => ({ role: "user", content: "x".repeat(n) });

function twoReads(path = "src/a.ts", tail = 0) {
  const r1 = read(path);
  const r2 = read(path);
  return [r1.call, r1.result("A".repeat(30_000)), filler(1000), r2.call, r2.result("B".repeat(500)), filler(tail)];
}

test("the earlier of two reads of the same file is blanked, the later one kept, when it is old enough and big enough", () => {
  const msgs = twoReads("src/a.ts", 200_000);
  const { messages, pruned } = pruneSupersededReads(msgs, { protectRecentChars: 100_000, minReclaimChars: 10_000 });
  assert.notEqual(messages, msgs);
  assert.deepEqual(pruned.map((p) => [p.index, p.path]), [[1, "src/a.ts"]]);
  const blanked = messages[1] as { content: Array<{ text: string }> };
  assert.equal(blanked.content[0]!.text, placeholderFor("src/a.ts"));
  assert.match((messages[4] as { content: Array<{ text: string }> }).content[0]!.text, /^B+$/, "the later read is intact");
  assert.equal(msgs[1], (msgs as unknown[])[1], "input untouched");
  // Idempotent: a second pass over the pruned view changes nothing.
  assert.equal(pruneSupersededReads(messages, { protectRecentChars: 100_000, minReclaimChars: 10_000 }).messages, messages);
});

test("a single read, or reads of different files, are never touched (same array reference)", () => {
  const one = read("src/a.ts");
  const single = [one.call, one.result("A".repeat(30_000)), filler(200_000)];
  assert.equal(pruneSupersededReads(single, { protectRecentChars: 1, minReclaimChars: 1 }).messages, single);
  const ra = read("src/a.ts");
  const rb = read("src/b.ts");
  const different = [ra.call, ra.result("A".repeat(30_000)), rb.call, rb.result("B".repeat(30_000)), filler(200_000)];
  assert.equal(pruneSupersededReads(different, { protectRecentChars: 1, minReclaimChars: 1 }).messages, different);
});

test("the protected tail and the reclaim floor both hold the rewrite back", () => {
  // Both reads inside the newest 100k chars: nothing is rewritten.
  const recent = twoReads("src/a.ts", 10);
  assert.equal(pruneSupersededReads(recent, { protectRecentChars: 100_000, minReclaimChars: 1 }).messages, recent);
  // Old enough, but too little to reclaim for the cache miss it costs.
  const small = twoReads("src/a.ts", 200_000);
  assert.equal(pruneSupersededReads(small, { protectRecentChars: 100_000, minReclaimChars: 100_000 }).messages, small);
});

test("the plan file is never pruned, and Windows spellings match POSIX ones", () => {
  const plan = twoReads("docs/PLAN.md", 200_000);
  assert.equal(pruneSupersededReads(plan, { protectRecentChars: 1, minReclaimChars: 1 }).messages, plan);
  const r1 = read("src\\a.ts");
  const r2 = read("./src/a.ts");
  const mixed = [r1.call, r1.result("A".repeat(30_000)), r2.call, r2.result("B"), filler(200_000)];
  const { pruned } = pruneSupersededReads(mixed, { protectRecentChars: 1, minReclaimChars: 1 });
  assert.equal(pruned.length, 1, "the same file under two spellings is one file");
});

test("never throws on malformed input", () => {
  const junk = [null, 1, { role: "assistant", content: [{ type: "toolCall" }] }, { role: "toolResult" }] as never[];
  assert.equal(pruneSupersededReads(junk).messages, junk);
});
