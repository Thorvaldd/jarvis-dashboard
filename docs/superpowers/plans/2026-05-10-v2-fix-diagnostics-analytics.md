# V2 — Fix System Diagnostics & Activity Analytics

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:systematic-debugging` first (this is a "find the bug" task, not a "build a feature" task), then `superpowers:subagent-driven-development` once a fix path is identified.

**Status:** Deferred to next execution session.

**Goal:** Restore visibility of the System Diagnostics and Activity Analytics widgets in the Obsidian dashboard. Currently both fail to render any visible content even though they're listed in `config.json` `layout` and present in `WIDGET_MAP`.

**What we already know:**

1. Both widget directories exist with valid syntax:
   - `src/widgets/system-diagnostics/index.js` (renders 4 stat cards)
   - `src/widgets/activity-analytics/index.js` (renders heatmap, peak-hours, model-breakdown)
2. Both are wired in `Jarvis Dashboard.md` `WIDGET_MAP` (lines 171, 173) and present in the default `config.json` `layout`.
3. `git diff upstream/main -- src/widgets/system-diagnostics/ src/widgets/activity-analytics/` shows **no diff** — widget code is identical to the original repo where these used to work.
4. Commit `b2ddc37` wrapped each widget render in `renderWidgetSafe()` with try/catch + red error-card fallback. Reloading the dashboard after that commit produced **no error card and no console error** for either widget — meaning **they don't throw, they render empty/invisible**.
5. Both widgets register a callback via `ctx.onStatsReady.push(...)` and rely on stats being computed and dispatched (`Jarvis Dashboard.md:247-263`).

This rules out a thrown error and shifts suspicion to either (a) the stats pipeline never firing, or (b) the widgets rendering at zero height because of `contentVisibility: auto` without an intrinsic-size hint, or (c) section-title / helper missing from `ctx`.

## Hypotheses (most→least likely)

### H1: `content-visibility: auto` collapses the widgets to zero height

Both widgets are in `DEFERRED_WIDGETS` (`Jarvis Dashboard.md:188-191`):

```javascript
const DEFERRED_WIDGETS = new Set([
  "activity-analytics", "recent-activity", "footer",
  "system-diagnostics", "mission-control",
]);
```

The render loop sets `widget.style.contentVisibility = "auto"` on each. **`content-visibility: auto` requires `contain-intrinsic-size` to give the browser a placeholder height while the element is off-screen, otherwise it can collapse to 0px and never come back into view** — especially in Obsidian's preview pane where viewport detection may not behave the same as a regular browser.

If this hypothesis is right, system-diagnostics and activity-analytics are *being created and appended* to the wrapper, but their layout box is zero pixels tall, so the user sees nothing. `recent-activity` and `mission-control` would have the same problem; the user reportedly sees these (verify in step 1 below) — if those work, this hypothesis is weakened.

**Cheap fix to verify:** add `containIntrinsicSize: "auto 400px"` alongside `contentVisibility: "auto"`, OR remove the widget from `DEFERRED_WIDGETS` entirely (cheap revert).

### H2: Stats pipeline never fires `onStatsReady`

The dashboard has two paths to compute stats (`Jarvis Dashboard.md:247-263`):
- Worker mode: `ctx.sessionParser.requestWorkerStats()` — async, posts a message to a worker.
- Fallback: `setTimeout(() => ctx.statsEngine.computeStats(), 100)` — synchronous main-thread.

If `hasWorker === true` but the worker is silently failing (e.g., the new `weekly-review` Tasks etc. interfere with module loading) or `_onWorkerStats` is overwritten before the worker responds, callbacks never fire. Both widgets would *render their shells* (section title, empty cards) but populated values would never appear.

**Quick check:** in dev tools, inspect the rendered DOM — if you can find the `System Diagnostics` section title hidden somewhere in the wrapper, that confirms shell-rendered-but-invisible (H1). If not even the shell is in the DOM, look further upstream.

### H3: Some `ctx` helper they depend on is missing

`system-diagnostics` destructures `fmtTokens, fmtCost, createSectionTitle` from `ctx`. `activity-analytics` destructures `createSectionTitle`. All three exist in `helpers.js`. The destructure happens at top-level — if any were missing, the destructure itself wouldn't throw (it'd just yield undefined), but calling `createSectionTitle(...)` on `undefined` would. **Try/catch should have caught this** if it were happening — and it didn't. So this hypothesis is weak.

### H4: Layout-loop changes broke widget appending

`b2ddc37` refactored the loop into `renderWidgetSafe(widgetType, target, opts)`. Verify the refactor preserved behavior:
- Row-mode: each widget gets `marginBottom: "0"` (kept via `opts.zeroBottomMargin: true`).
- Solo-mode: no marginBottom override (correct).
- Both modes: `contain: "layout style"` set, `contentVisibility: "auto"` set when in `DEFERRED_WIDGETS`.

That all matches the pre-refactor behavior. **But** — the new error-card fallback uses `T.red`, `T.panelBorder`, etc. If `T` was somehow undefined at that point, it'd throw inside `renderWidgetSafe` itself. Verify `T` is in scope where `renderWidgetSafe` is defined (it should be — declared on line 44 from theme load).

## Investigation steps (to run next session)

1. **Confirm H1 first** — open dev tools in Obsidian (Cmd+Option+I → Console; for preview pane use the in-pane inspector). In Elements/DOM inspector, search for the text "System Diagnostics". If it's in the DOM but its computed `height` is 0, H1 is confirmed.
2. **Check stats path** — in console, after dashboard renders, run `window.__jarvis_ctx?.onStatsReady.length` (we'd need to expose `ctx` first; alternative: add `console.log("[JARVIS] stats fired", stats)` in `Jarvis Dashboard.md:251` and `Jarvis Dashboard.md:260`).
3. **Verify recent-activity / mission-control** — the user mentioned only system-diagnostics + activity-analytics. If `recent-activity` and `mission-control` work fine (both also in `DEFERRED_WIDGETS`), H1 is weakened and we look at stats pipeline (H2).
4. **Check `git log upstream/main..HEAD -- "Jarvis Dashboard.md"`** — review every fork-introduced change to the dashboard file for a regression that doesn't apply to all DEFERRED_WIDGETS uniformly.

## Fix paths (one of these is likely the answer)

### Path A: Add `contain-intrinsic-size`
If H1 is confirmed, change the deferred-widget styling in `renderWidgetSafe`:

```javascript
if (DEFERRED_WIDGETS.has(widgetType)) {
  widget.style.contentVisibility = "auto";
  widget.style.containIntrinsicSize = "auto 400px";  // placeholder height while off-screen
}
```

### Path B: Remove from DEFERRED_WIDGETS
Cheapest fix if intrinsic-size doesn't work. Drop `system-diagnostics` and `activity-analytics` from the set; they'll always render eagerly. Cost: small layout-perf hit while these widgets do their work.

### Path C: Fix the stats pipeline
If H2 is confirmed, the bug is somewhere in `services/session-worker.js` or `services/session-parser.js`. Read `ctx.sessionParser.hasWorker` and `requestWorkerStats` to see why the callback never lands.

### Path D: Remove the customisations and re-bisect
Last resort: temporarily comment out `rize-week`, `littlebird-paste`, `weekly-review` from `config.json` `layout`. If diagnostics+analytics return, one of those custom widgets is doing something destructive (e.g., overwriting `ctx.onStatsReady` instead of pushing to it, or shadowing a global). Then bisect by adding them back one at a time.

## Files likely to touch

| File | Why |
|---|---|
| `Jarvis Dashboard.md` | DEFERRED_WIDGETS set; `renderWidgetSafe` styling; `containIntrinsicSize` addition |
| `src/services/session-worker.js` | If H2 (worker stats path is broken) |
| `src/services/session-parser.js` | If H2 (fallback stats path is broken) |
| `src/widgets/rize-week/index.js`, `littlebird-paste/index.js`, `weekly-review/index.js` | If H4 / Path D (one of them mutates shared state) |

## Verification (whichever path)

- Reload `Jarvis Dashboard.md` in Obsidian.
- Both "System Diagnostics" and "Activity Analytics" section titles appear.
- The 4 stat cards (Sessions / Tokens / Est. Cost / Top Model) render with non-empty values.
- The 3 activity panels (heatmap / peak hours / model breakdown) render.
- No regression in other widgets that were already rendering (header, live-sessions, focus-timer, quick-capture, agent-cards, footer).

## Out of scope for v2

- Restyling or refactoring these widgets — fix-in-place only, no rewrites.
- Changing the stats pipeline architecture — only fix if it's the root cause.
- Touching the project-browse-create plan (`docs/superpowers/plans/2026-05-10-project-browse-create.md`) which has Tasks 2-10 still pending.
