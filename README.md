# @pify/compact

[![CI](https://github.com/pifydev/compact/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/compact/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/compact)](https://www.npmjs.com/package/@pify/compact) [![npm downloads](https://img.shields.io/npm/dm/@pify/compact)](https://www.npmjs.com/package/@pify/compact)

Proactive auto-compaction for [pi](https://github.com/earendil-works/pi): when the context window crosses a threshold, compact **between turns** so a long session never stalls at the wall or forces a restart.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install compact`](https://github.com/pifydev/cli) or `pi install npm:@pify/compact`.

## Why

A long session fills the context window, and once it is full the run stops moving — you compact by hand or start over, losing the thread. pi has built-in compaction; this is for when you turn that off (or want a different threshold): it watches usage and compacts on its own, quietly, in the gap between turns.

## How it works

The trigger is `agent_settled` — the moment a run has fully settled, with no retry, compaction, or queued continuation pending. When context usage has reached the threshold, it calls pi's own `ctx.compact()` there. Compacting while the agent is idle means it never aborts a live run, which sidesteps the spurious "operation aborted" message that mid-run compaction produces; the next turn simply goes out with a smaller context, the current task preserved via the compaction instructions.

It stays **dormant unless pi's built-in compaction is off**, so the two never double-compact — and if it can't determine pi's setting, it errs to dormant. It won't act on an unknown usage reading (the `null` pi reports right after a compaction), so it can't loop.

## Settings

`.pi/compact.json` (project) or `<agentDir>/compact.json` (global):

```json
{
  "thresholdPercent": 80,
  "enabled": true
}
```

`thresholdPercent` (1–99) is how full the window may get before compaction; `PIFY_COMPACT_THRESHOLD` overrides it for one run. Bad values fall back to the defaults with a warning.

## Command

- `/autocompact` — status: active/dormant, threshold, and current context %.
- `/autocompact now` — compact immediately (when active).
- `/autocompact on` / `off` — toggle for this session.

## Note

To use this, turn pi's built-in compaction **off** — otherwise this package stays dormant to avoid double-compaction. There are **no runtime dependencies** and no model calls of its own; the compaction itself is pi's, on your session model. Works on Linux, macOS, and Windows.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
