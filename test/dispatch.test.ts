import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchCompact, type CompactCapable, type CompactDispatchOptions } from "../src/dispatch.ts";

/** A ctx.compact() that throws synchronously, like pi does when it cannot start. */
const throwingCtx = (message = "no model configured"): CompactCapable => ({
  compact() {
    throw new Error(message);
  },
});

/** A ctx.compact() that dispatches fine and reports async (never synchronously). */
const dispatchingCtx = (): CompactCapable => ({
  compact() {
    // returns void; onComplete/onError would fire later in the real runtime
  },
});

test("a synchronous throw is routed to onError, not rethrown", () => {
  let seen: Error | null = null;
  const ok = dispatchCompact(throwingCtx("boom"), {
    onError: (err) => {
      seen = err;
    },
  });
  assert.equal(ok, false, "returns false when compact threw synchronously");
  assert.ok(seen, "onError was invoked with the thrown error");
  assert.equal((seen as unknown as Error).message, "boom");
});

test("a throwing compact runs the caller's flag-reset (compacting → false)", () => {
  // Mirror the extension: `compacting` is set true just before dispatch and the
  // onError callback (onCompactError) is what flips it back to false.
  let compacting = true;
  const options: CompactDispatchOptions = {
    onError: () => {
      compacting = false;
    },
  };
  dispatchCompact(throwingCtx(), options);
  assert.equal(compacting, false, "flag reset even though compact threw synchronously");
});

test("the preflight path resolves its promise on a synchronous throw", async () => {
  // Mirror compactAndWait: onError both clears the flag and resolves the promise.
  let compacting = true;
  const done = new Promise<void>((resolve) => {
    dispatchCompact(throwingCtx(), {
      onError: () => {
        compacting = false;
        resolve();
      },
    });
  });
  await done; // would hang forever if the throw escaped instead of hitting onError
  assert.equal(compacting, false);
});

test("a clean dispatch returns true and does not call onError", () => {
  let errored = false;
  const ok = dispatchCompact(dispatchingCtx(), {
    onError: () => {
      errored = true;
    },
  });
  assert.equal(ok, true);
  assert.equal(errored, false, "onError is left for the async path, not fired on a clean dispatch");
});

test("a non-Error throw is wrapped into an Error for onError", () => {
  let wasError = false;
  let message: string | null = null;
  const ctx: CompactCapable = {
    compact() {
      throw "stringly failure";
    },
  };
  dispatchCompact(ctx, {
    onError: (err) => {
      wasError = err instanceof Error;
      message = err.message;
    },
  });
  assert.equal(wasError, true, "a non-Error throw is wrapped into an Error");
  assert.equal(message, "stringly failure");
});
