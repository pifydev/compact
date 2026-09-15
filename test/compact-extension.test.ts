/**
 * Regression tests for the whole extension: a ctx.compact() that throws
 * SYNCHRONOUSLY must not strand the `compacting` flag (which permanently
 * disables auto-compaction) nor, on the input-preflight path, leave the promise
 * unresolved so the input hook never returns {action:"continue"}.
 *
 * The extension only leaves its dormant state when pi's own compaction is off,
 * so each test points ctx.cwd at a temp project whose .pi/settings.json disables
 * pi's built-in compaction (roots are injected, never via HOME — os.homedir may
 * be cached under bun). Everything else is a hand-rolled fake ctx/pi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import compact from "../extensions/compact.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Instantiate the extension against a fake pi, returning its captured handlers. */
function loadExtension(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(evt: string, fn: Handler) {
      handlers.set(evt, fn);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  compact(pi);
  return handlers;
}

/** A temp project dir with pi's built-in compaction OFF (so the ext is active). */
function makeActiveProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pify-compact-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort; a lingering lockfile on Windows must not fail the test
  }
}

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted: () => boolean;
  sessionManager: { getBranch: () => unknown[] };
  ui: { notify: (msg: string, level: string) => void; setStatus: () => void };
  getContextUsage: () => { percent: number; tokens: number; contextWindow: number };
  compact: () => void;
}

/** ctx whose compact() always throws synchronously, counting each attempt. */
function makeThrowingCtx(dir: string, usage: { percent: number; tokens: number; contextWindow: number }) {
  const state = { compactAttempts: 0, warnings: [] as string[] };
  const ctx: FakeCtx = {
    cwd: dir,
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (msg, level) => {
        if (level === "warning") state.warnings.push(msg);
      },
      setStatus: () => {},
    },
    getContextUsage: () => usage,
    compact: () => {
      state.compactAttempts++;
      throw new Error("synthetic synchronous compact failure");
    },
  };
  return { ctx, state };
}

test("agent_settled: a synchronous compact throw resets the flag, so the next settle compacts again", async () => {
  const dir = makeActiveProjectDir();
  try {
    const handlers = loadExtension();
    const { ctx, state } = makeThrowingCtx(dir, { percent: 95, tokens: 500_000, contextWindow: 1_000_000 });

    await handlers.get("session_start")!({}, ctx); // determines active = true

    // First settle: over threshold → compact → ctx.compact() throws synchronously.
    await handlers.get("agent_settled")!({}, ctx);
    // Second settle: if the throw had stranded `compacting` at true, shouldCompact
    // would refuse and this would be a no-op. It must compact again.
    await handlers.get("agent_settled")!({}, ctx);

    assert.equal(state.compactAttempts, 2, "compaction is attempted on both settles (flag was reset)");
    assert.equal(state.warnings.length, 2, "each synchronous failure is surfaced as a warning");
  } finally {
    cleanup(dir);
  }
});

test("input preflight: a synchronous compact throw still resolves and returns continue", async () => {
  const dir = makeActiveProjectDir();
  try {
    const handlers = loadExtension();
    const { ctx, state } = makeThrowingCtx(dir, { percent: 95, tokens: 850_000, contextWindow: 1_000_000 });

    await handlers.get("session_start")!({}, ctx);

    // A big-enough prompt while idle trips the preflight → compactAndWait → throw.
    const result = await handlers.get("input")!({ text: "hello", streamingBehavior: undefined }, ctx);
    assert.deepEqual(result, { action: "continue" }, "input hook returns despite the synchronous throw");
    assert.equal(state.compactAttempts, 1, "preflight attempted the compaction");

    // Flag must be cleared: a following settle over threshold compacts again.
    await handlers.get("agent_settled")!({}, ctx);
    assert.equal(state.compactAttempts, 2, "compacting flag was reset by the preflight failure");
  } finally {
    cleanup(dir);
  }
});
