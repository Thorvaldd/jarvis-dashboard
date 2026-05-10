---
tags:
  - dashboard/ai
cssclasses:
  - jarvis-page
---

```dataviewjs
const container = this.container;

// ── Prevent full re-render on vault file changes ──
// Dataview re-runs this block on every file change. Reuse existing DOM
// instead of rebuilding the entire dashboard (preserves terminal state, timers, etc.).
// Uses labeled block + break (DataviewJS uses eval, so bare `return` is illegal).
__jarvis__: {
if (window.__jarvisDashboard?.wrapper) {
  container.appendChild(window.__jarvisDashboard.styleEl);
  container.appendChild(window.__jarvisDashboard.wrapper);
  break __jarvis__;
}

const nodeFs = require("fs");
const nodePath = require("path");

// ── Resolve base path (works wherever the dashboard folder is placed) ──
const vaultBase = app.vault.adapter.basePath;
const currentFilePath = dv.current().file.path;
const dashboardDir = nodePath.dirname(nodePath.join(vaultBase, currentFilePath));
const srcDir = nodePath.join(dashboardDir, "src");

// ── Module loader ──
const _AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
function loadModule(relativePath) {
  const fullPath = nodePath.join(srcDir, relativePath);
  const code = nodeFs.readFileSync(fullPath, "utf8");
  return new _AsyncFunction("ctx", code);
}

// ── Load config ──
const config = JSON.parse(nodeFs.readFileSync(nodePath.join(srcDir, "config", "config.json"), "utf8"));

// ── Merge config.local.json (gitignored, holds user-specific overrides) ──
function deepMergeConfig(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMergeConfig(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
let _localConfig = {};
try {
  _localConfig = JSON.parse(nodeFs.readFileSync(
    nodePath.join(srcDir, "config", "config.local.json"), "utf8"));
  Object.assign(config, deepMergeConfig(config, _localConfig));
} catch {}

// ── Load core: theme ──
const themeResult = await loadModule("core/theme.js")({ container, config });
const { T, isNarrow, isMedium, isWide, CARD_PAD, FONT_SM, leafEl } = themeResult;

// ── Load core: styles ──
const styleEl = await loadModule("core/styles.js")({ T, config });
container.appendChild(styleEl);

// ── Load core: helpers ──
const helpers = await loadModule("core/helpers.js")({ T, isNarrow });
const { el, fmtTokens, fmtCost, formatModel, describeAction, getModelFamily, addHoverEffect, createSectionTitle } = helpers;

// ── Load core: markdown renderer ──
const markdownRenderer = await loadModule("core/markdown-renderer.js")({ el, T, config });

// ── Load registry ──
const registryPath = config.widgets?.agentCards?.registryPath || "src/config/Jarvis-Registry";
const dashboardFolder = currentFilePath.replace(/\/[^/]+$/, "");
const fullRegistryPath = dashboardFolder + "/" + registryPath;
const registry = dv.page(fullRegistryPath);
const agents = registry?.agents || [];
const agentNames = new Set();
const skillToAgent = new Map();
agents.forEach(a => {
  agentNames.add(a.name);
  (a.skills || []).forEach(s => skillToAgent.set(s, a.name));
});

// ── Performance config shortcuts ──
const perf = config.performance || {};
const animationsEnabled = perf.animationsEnabled !== false;

// ── Build shared context ──
const ctx = {
  el, T, config, container, dv,
  isNarrow, isMedium, isWide, leafEl,
  nodeFs, nodePath, CARD_PAD, FONT_SM,
  fmtTokens, fmtCost, formatModel, describeAction, getModelFamily, addHoverEffect, createSectionTitle,
  markdownRenderer,
  agents, agentNames, skillToAgent,
  agentCardRefs: new Map(),
  onStatsReady: [],
  intervals: [],
  cleanups: [],
  _paused: false,
  _srcDir: srcDir + "/",
  _configDir: nodePath.join(srcDir, "config"),
  _adapter: {
    readFile(path) { return nodeFs.readFileSync(path, "utf8"); },
    readFileAsync(path) { return nodeFs.readFileSync(path, "utf8"); },
    vaultBasePath() { return vaultBase; },
  },
  // Performance
  perf,
  animationsEnabled,
  // Pausable registry for centralized visibility pause/resume
  _pausables: [],
  registerPausable(startFn, stopFn) {
    ctx._pausables.push({ start: startFn, stop: stopFn });
  },
};

// ── Load services ──
ctx.sessionParser = await loadModule("services/session-parser.js")(ctx);
ctx.cleanups.push(() => { if (ctx.sessionParser.cleanup) ctx.sessionParser.cleanup(); });
ctx.statsEngine = await loadModule("services/stats-engine.js")(ctx);
ctx.timerService = await loadModule("services/timer-service.js")(ctx);
ctx.voiceService = await loadModule("services/voice-service.js")(ctx);
ctx.cleanups.push(() => ctx.voiceService.cleanup());
ctx.ttsService = await loadModule("services/tts-service.js")(ctx);
ctx.cleanups.push(() => ctx.ttsService.cleanup());
ctx.projectsStore = await loadModule("services/projects-store.js")(ctx);
ctx._sessionManagerCore = await loadModule("services/session-manager-core.js")(ctx);
ctx.sessionManager = await loadModule("services/session-manager.js")(ctx);
ctx.cleanups.push(() => ctx.sessionManager.cleanup());

// ── Load network client for remote voice mode ──
if (config.widgets?.voiceCommand?.mode === "remote") {
  ctx._localConfig = _localConfig;
  ctx.networkClient = await loadModule("services/network-client.js")(ctx);
  ctx.cleanups.push(() => ctx.networkClient.cleanup());
}

// ── Create main wrapper ──
const wrapper = el("div", {
  background: T.bg,
  minHeight: "100vh",
  padding: isNarrow ? "16px" : "32px",
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  color: T.text,
  position: "relative",
  overflow: "hidden",
});
container.appendChild(wrapper);

// ── Scan line overlay ──
if (config.dashboard?.showScanLine !== false) {
  wrapper.appendChild(el("div", {
    position: "absolute",
    left: "0", width: "100%", height: "6%",
    background: "linear-gradient(180deg, transparent, rgba(0,212,255,0.04), transparent)",
    pointerEvents: "none", zIndex: "1",
    animation: animationsEnabled ? "jarvisScanLine 8s linear infinite" : "none",
    willChange: animationsEnabled ? "top" : "auto",
    contain: "layout style",
  }));
}

// ── Widget map ──
const WIDGET_MAP = {
  "header":                "widgets/header/index.js",
  "live-sessions":         "widgets/live-sessions/index.js",
  "system-diagnostics":    "widgets/system-diagnostics/index.js",
  "agent-cards":           "widgets/agent-cards/index.js",
  "activity-analytics":    "widgets/activity-analytics/index.js",
  "communication-link":    "widgets/communication-link/index.js",
  "focus-timer":           "widgets/focus-timer/index.js",
  "quick-capture":         "widgets/quick-capture/index.js",
  "quick-launch":          "widgets/quick-launch/index.js",
  "mission-control":       "widgets/mission-control/index.js",
  "recent-activity":       "widgets/recent-activity/index.js",
  "jarvis-voice-command":  "widgets/voice-command/index.js",
  "rize-week":             "widgets/rize-week/index.js",
  "littlebird-paste":      "widgets/littlebird-paste/index.js",
  "weekly-review":         "widgets/weekly-review/index.js",
  "manage-projects":       "widgets/manage-projects/index.js",
  "footer":                "widgets/footer/index.js",
};

// ── Widgets that benefit from content-visibility: auto (below the fold) ──
const DEFERRED_WIDGETS = new Set([
  "activity-analytics", "recent-activity", "footer",
  "system-diagnostics", "mission-control",
]);

// ── Render layout ──
const layout = config.layout || [
  { type: "header" },
  { type: "live-sessions" },
  { type: "row", columns: 2, widgets: ["focus-timer", "quick-capture"] },
  { type: "agent-cards" },
  { type: "communication-link" },
  { type: "row", columns: 2, widgets: ["quick-launch", "mission-control"] },
  { type: "system-diagnostics" },
  { type: "activity-analytics" },
  { type: "recent-activity" },
  { type: "footer" },
];

const gridRefs = [];

// Render one widget by type, isolated in a try/catch so a single failure
// can't black-hole the rest of the dashboard. On failure, render a small
// red error card with the message so the user can see which widget broke.
async function renderWidgetSafe(widgetType, target, opts) {
  try {
    const widget = await loadModule(WIDGET_MAP[widgetType])(ctx);
    if (widget && widget.style) {
      if (opts && opts.zeroBottomMargin) widget.style.marginBottom = "0";
      widget.style.contain = "layout style";
      if (DEFERRED_WIDGETS.has(widgetType)) {
        widget.style.contentVisibility = "auto";
      }
    }
    target.appendChild(widget);
  } catch (e) {
    console.error(`[JARVIS] Widget '${widgetType}' failed to render:`, e);
    const errEl = el("div", {
      border: `1px solid ${T.red}55`,
      background: "rgba(231,76,60,0.06)",
      color: T.red,
      borderRadius: "8px",
      padding: "10px 14px",
      fontSize: "12px",
      fontFamily: "'SF Mono', 'Fira Code', monospace",
      marginBottom: opts && opts.zeroBottomMargin ? "0" : "16px",
    }, `[${widgetType}] ${e && e.message ? e.message : String(e)}`);
    target.appendChild(errEl);
  }
}

for (const entry of layout) {
  if (entry.type === "row" && entry.widgets) {
    const row = el("div", {
      display: "grid",
      gridTemplateColumns: isNarrow ? "1fr" : `repeat(${entry.columns || 2}, 1fr)`,
      gap: isNarrow ? "12px" : "20px",
      position: "relative",
      zIndex: "2",
      marginBottom: isNarrow ? "24px" : "40px",
      contain: "layout style",
    });
    for (const widgetType of entry.widgets) {
      if (WIDGET_MAP[widgetType]) {
        await renderWidgetSafe(widgetType, row, { zeroBottomMargin: true });
      }
    }
    wrapper.appendChild(row);
    gridRefs.push({ el: row, columns: entry.columns || 2 });
  } else if (WIDGET_MAP[entry.type]) {
    await renderWidgetSafe(entry.type, wrapper, { zeroBottomMargin: false });
  }
}

// ── Trigger async stats ──
if (ctx.sessionParser.hasWorker) {
  // Worker mode: request stats from background thread
  ctx._onWorkerStats = (stats) => {
    ctx.onStatsReady.forEach(cb => { try { cb(stats); } catch {} });
    ctx._onWorkerStats = null; // one-shot
  };
  ctx.sessionParser.requestWorkerStats();
} else {
  // Fallback: compute on main thread after initial render
  setTimeout(() => {
    try {
      const stats = ctx.statsEngine.computeStats();
      ctx.onStatsReady.forEach(cb => cb(stats));
    } catch {}
  }, 100);
}

// ── Centralized pause/resume when dashboard is not visible ──
const _visibilityHandler = () => {
  const hidden = document.hidden;
  ctx._paused = hidden;
  if (hidden) {
    // Pause all CSS animations via class toggle (no DOM iteration)
    wrapper.classList.add("jarvis-bg-paused");
    // Stop all registered interval-based work
    ctx._pausables.forEach(p => { try { p.stop(); } catch(e) {} });
  } else {
    // Resume all CSS animations
    wrapper.classList.remove("jarvis-bg-paused");
    // Restart all registered interval-based work
    ctx._pausables.forEach(p => { try { p.start(); } catch(e) {} });
  }
};
document.addEventListener("visibilitychange", _visibilityHandler);
ctx.cleanups.push(() => document.removeEventListener("visibilitychange", _visibilityHandler));

// ── Store dashboard reference for re-render prevention ──
window.__jarvisDashboard = { wrapper, styleEl };

// ── Cleanup (runs when note is actually closed, not on Dataview re-render) ──
function dashboardCleanup() {
  ctx.intervals.forEach(id => clearInterval(id));
  ctx.cleanups.forEach(fn => { try { fn(); } catch(e) {} });
  window.__jarvisDashboard = null;
}

// MutationObserver: detect when wrapper is removed from DOM
// Checks wrapper (not container) because wrapper is re-parented across Dataview re-renders
let cleanupTimer = null;
const observer = new MutationObserver(() => {
  if (!document.contains(wrapper)) {
    if (!cleanupTimer) {
      cleanupTimer = setTimeout(() => {
        if (!document.contains(wrapper)) {
          observer.disconnect();
          dashboardCleanup();
        }
        cleanupTimer = null;
      }, 500);
    }
  }
});
const observeTarget = container.parentElement || document.body;
observer.observe(observeTarget, { childList: true, subtree: false });

// Fallback: periodic check in case MutationObserver misses note close
ctx.intervals.push(setInterval(() => {
  if (!document.contains(wrapper)) {
    observer.disconnect();
    dashboardCleanup();
  }
}, 10000));

// ── Responsive resize ──
const resizeTarget = leafEl || container;
const ro = new ResizeObserver(() => {
  const w = leafEl ? leafEl.clientWidth : window.innerWidth;
  const narrow = w < 500;
  const wide = w >= 950;

  if (ctx._agentsGrid) ctx._agentsGrid.style.gridTemplateColumns = narrow ? "1fr" : (wide ? "repeat(3, 1fr)" : "1fr");
  if (ctx._diagGrid) ctx._diagGrid.style.gridTemplateColumns = narrow ? "repeat(2, 1fr)" : "repeat(4, 1fr)";
  if (ctx._analyticsGrid) ctx._analyticsGrid.style.gridTemplateColumns = narrow ? "1fr" : "repeat(3, 1fr)";
  if (ctx._bookmarkGroups) {
    ctx._bookmarkGroups.forEach(ref => {
      ref.el.style.gridTemplateColumns = narrow ? "repeat(3, 1fr)" : `repeat(${Math.min(ref.count, 4)}, 1fr)`;
    });
  }

  gridRefs.forEach(ref => {
    ref.el.style.gridTemplateColumns = narrow ? "1fr" : `repeat(${ref.columns}, 1fr)`;
  });
});
ro.observe(resizeTarget);
} /* end __jarvis__ block */
```
