# @pify/compact

[![CI](https://github.com/pifydev/compact/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/compact/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/compact)](https://www.npmjs.com/package/@pify/compact) [![npm downloads](https://img.shields.io/npm/dm/@pify/compact)](https://www.npmjs.com/package/@pify/compact)

Proactive auto-compaction for [pi](https://github.com/earendil-works/pi): when the context window crosses a threshold, compact **between turns** so a long session never stalls at the wall or forces a restart.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install compact`](https://github.com/pifydev/cli) or `pi install npm:@pify/compact`.

## Why

A long session fills the context window, and once it is full the run stops moving — you compact by hand or start over, losing the thread. pi has built-in compaction; this is for when you turn that off (or want a different threshold): it watches usage and compacts on its own, quietly, in the gap between turns.

## How it works

The trigger is `agent_settled` — the moment a run has fully settled, with no retry, compaction, or queued continuation pending. When context usage has reached the threshold, it calls pi's own `ctx.compact()` there. Compacting while the agent is idle means it never aborts a live run, which sidesteps the spurious "operation aborted" message that mid-run compaction produces; the next turn simply goes out with a smaller context, the current task preserved via the compaction instructions.

It stays **dormant unless pi's built-in compaction is off**, so the two never double-compact — and if it can't determine pi's setting, it errs to dormant. It won't act on an unknown usage reading (the `null` pi reports right after a compaction), so it can't loop.

### Degeneration guard

Separately — and **always on, even while dormant** — a deterministic pass watches the outbound context for a different long-session death: a model that collapses into a long single-codepoint run (observed in the wild as a thinking block ending in thousands of `【`). pi replays prior assistant thinking to the provider on every later request, so a degenerated tail rides along every subsequent prompt, biases the model to continue the run, and the session dies in an abort loop. The guard collapses those runs in the **outbound view only** (persisted history is never touched) and, while the degenerated turn is the most recent one, appends a one-shot recovery notice. It costs no tokens and no model call; a clean context passes through untouched, so the prompt cache holds. (Adapted from [billion-context-pi](https://github.com/ranxianglei/billion-context-pi).)

## Settings

`.pi/compact.json` (project) or `<agentDir>/compact.json` (global):

```json
{
  "thresholdPercent": 80,
  "maxTokens": 0,
  "minGrowthTokens": 0,
  "degenerationGuard": true,
  "degenerationMinRun": 200,
  "enabled": true
}
```

`thresholdPercent` (1–99) is how full the window may get before compaction. `maxTokens` is an absolute token ceiling that *also* triggers compaction (0 = off) — useful on very large windows where a percentage never trips before the session is already huge (80% of a 1M window is 800k tokens). Whichever comes first wins.

`minGrowthTokens` (0 = off) gates the **percentage** trigger: even at the threshold, hold off until the context has grown by this many tokens since the last compaction. It stops the thrash where a compaction frees little, leaves usage near the threshold, and the next idle moment compacts again. The absolute ceiling ignores it — a hard ceiling is a safety and is never held back. (Idea from billion-context-pi's growth-gated triggering; off by default because a flat cadence can be better on repetitive workloads.)

`degenerationGuard` (default on) and `degenerationMinRun` (minimum run length that counts as degeneration; floored at 8) tune the guard described above.

`PIFY_COMPACT_THRESHOLD`, `PIFY_COMPACT_MAX_TOKENS`, and `PIFY_COMPACT_MIN_GROWTH` override the numeric knobs for one run. Bad values fall back to the defaults with a warning.

## Command

- `/autocompact` — status: active/dormant, threshold, and current context %.
- `/autocompact now` — compact immediately (when active).
- `/autocompact on` / `off` — toggle for this session.

## Note

To use this, turn pi's built-in compaction **off** — otherwise this package stays dormant to avoid double-compaction. There are **no runtime dependencies** and no model calls of its own; the compaction itself is pi's, on your session model. Works on Linux, macOS, and Windows.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
