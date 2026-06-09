# Project Browse / Create / Manage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Manage projects" modal to the voice-command widget that lets users browse `~/.claude/projects/`, pick arbitrary folders, and rename/recolor/remove tracked entries — persisting changes to `config.local.json`.

**Architecture:** New `projects-store.js` service owns `config.local.json` mutation (atomic write via tmp+rename). `session-manager-core` gains `addProject`/`updateProject`/`removeProject` that delegate to the store, splice the in-memory `tracked` array in place, then call `notifyListeners()` — the existing re-render hook that `project-selector.js` and `session-tabs.js` already subscribe to. New `manage-projects-modal.js` is a self-contained UI factory; a gear icon in `voice-command/index.js` opens it.

**Tech Stack:** Vanilla JS in dataviewjs/Obsidian context, Node `fs`/`path` from `ctx`, no test framework (per repo convention: `node --check` for syntax + manual integration). Persistence layer is testable via a small standalone node test harness.

**Spec:** `docs/superpowers/specs/2026-05-10-project-browse-create-design.md`.

---

## Task 1: Lift `config.local.json` merge out of remote-mode branch

Currently the deep-merge runs only when `voiceCommand.mode === "remote"` (`Jarvis Dashboard.md:117-134`). Because new projects persist to `config.local.json`, the merge must run unconditionally so local-mode users see their tracked list.

**Files:**
- Modify: `Jarvis Dashboard.md:40-138`

- [ ] **Step 1: Read the current state of the merge block**

```bash
sed -n '38,140p' "Jarvis Dashboard.md"
```

Confirm the structure matches what's described: `config` is loaded at line 40, merge logic is inside an `if (... === "remote")` block at lines 117-138.

- [ ] **Step 2: Insert an unconditional merge block right after `config` is loaded**

Replace lines `40` (the existing `const config = ...` line) and the lines that follow up through line 41, with:

```javascript
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
```

- [ ] **Step 3: Remove the duplicated merge logic from the remote-mode block**

Find the block starting `if (config.widgets?.voiceCommand?.mode === "remote") {` (currently at line 117) and replace it with:

```javascript
// ── Load network client for remote voice mode ──
if (config.widgets?.voiceCommand?.mode === "remote") {
  ctx._localConfig = _localConfig;
  ctx.networkClient = await loadModule("services/network-client.js")(ctx);
  ctx.cleanups.push(() => ctx.networkClient.cleanup());
}
```

- [ ] **Step 4: Syntax-check the markdown's embedded JS**

The dashboard JS lives inside a fenced code block in `Jarvis Dashboard.md`. Extract and check:

```bash
awk '/^```dataviewjs/{f=1;next} /^```/{f=0} f' "Jarvis Dashboard.md" > /tmp/jarvis-dashboard-check.js
node --check /tmp/jarvis-dashboard-check.js && echo OK
```

Expected: `OK`. If it fails, fix the syntax error before moving on.

- [ ] **Step 5: Commit**

```bash
git add "Jarvis Dashboard.md"
git commit -m "refactor(dashboard): always merge config.local.json at boot

Previously the merge only ran when voiceCommand.mode === 'remote'.
Project tracking now persists to config.local.json, so local-mode
users need the merge too. Lift it to the top of the boot sequence."
```

---

## Task 2: Write `projects-store.js` test harness

The store is the pure-data layer — atomic file write, list mutation. Testable in isolation by injecting `nodeFs`/`nodePath` via a fake ctx. Write the test first (TDD), see it fail, then implement.

**Files:**
- Create: `tests/projects-store.test.js`
- Test fixtures: `tests/.tmp/` (created by test, gitignored)

- [ ] **Step 1: Add `tests/` to `.gitignore` for the temp dir**

Read `.gitignore` first to see the current contents:

```bash
cat .gitignore | head -30
```

Append:

```
# Test sandbox
tests/.tmp/
```

- [ ] **Step 2: Write the failing test harness**

Create `tests/projects-store.test.js`:

```javascript
// Standalone test harness for src/services/projects-store.js
// Run: node tests/projects-store.test.js
// The store is a dataviewjs-style module: it destructures ctx and returns an
// object. We load it the same way the dashboard does — via new Function — but
// inject real fs/path from Node and a sandbox tmp dir.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const TMP = path.resolve(__dirname, ".tmp");
const STORE_SRC = path.resolve(__dirname, "../src/services/projects-store.js");

function makeCtx({ configDir }) {
  return {
    nodeFs: fs,
    nodePath: path,
    config: { projects: { rootPath: "/fake/root" } },
    _configDir: configDir,
  };
}

function loadStore(ctx) {
  const code = fs.readFileSync(STORE_SRC, "utf8");
  return new Function("ctx", code)(ctx);
}

function freshSandbox(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runTest(name, fn) {
  try {
    fn();
    console.log("PASS  " + name);
  } catch (e) {
    console.error("FAIL  " + name);
    console.error(e.stack || e.message);
    process.exitCode = 1;
  }
}

// ── 1. write() creates config.local.json when missing ──
runTest("write creates config.local.json when missing", () => {
  const dir = freshSandbox("t1");
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  const arr = [{ dir: "-Users-foo", label: "Foo" }];
  store.write(arr);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "config.local.json"), "utf8"));
  assert.deepStrictEqual(written.projects.tracked, arr);
});

// ── 2. write() preserves unrelated keys ──
runTest("write preserves unrelated keys in config.local.json", () => {
  const dir = freshSandbox("t2");
  fs.writeFileSync(path.join(dir, "config.local.json"), JSON.stringify({
    network: { token: "abc" },
    projects: { tracked: [{ dir: "-old", label: "Old" }] },
  }, null, 2));
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  store.write([{ dir: "-new", label: "New" }]);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "config.local.json"), "utf8"));
  assert.strictEqual(written.network.token, "abc");
  assert.deepStrictEqual(written.projects.tracked, [{ dir: "-new", label: "New" }]);
});

// ── 3. write() is atomic (uses tmp + rename) ──
runTest("write uses tmp file then rename", () => {
  const dir = freshSandbox("t3");
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  store.write([{ dir: "-x", label: "X" }]);
  // After write, no .tmp file should be left behind
  const tmpExists = fs.existsSync(path.join(dir, "config.local.json.tmp"));
  assert.strictEqual(tmpExists, false);
  const real = JSON.parse(fs.readFileSync(path.join(dir, "config.local.json"), "utf8"));
  assert.deepStrictEqual(real.projects.tracked, [{ dir: "-x", label: "X" }]);
});

// ── 4. addProject appends to current tracked ──
runTest("addProject appends to provided tracked array", () => {
  const dir = freshSandbox("t4");
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  const current = [{ dir: "-a", label: "A" }];
  const next = store.addProject(current, { dir: "-b", label: "B" });
  assert.deepStrictEqual(next, [
    { dir: "-a", label: "A" },
    { dir: "-b", label: "B" },
  ]);
  // And it persisted
  const written = JSON.parse(fs.readFileSync(path.join(dir, "config.local.json"), "utf8"));
  assert.deepStrictEqual(written.projects.tracked, next);
});

// ── 5. addProject is a no-op when dir already tracked ──
runTest("addProject ignores duplicate dir", () => {
  const dir = freshSandbox("t5");
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  const current = [{ dir: "-a", label: "A" }];
  const next = store.addProject(current, { dir: "-a", label: "Different" });
  assert.deepStrictEqual(next, current);
});

// ── 6. updateProject patches by index ──
runTest("updateProject patches the entry at index", () => {
  const dir = freshSandbox("t6");
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  const current = [
    { dir: "-a", label: "A" },
    { dir: "-b", label: "B" },
  ];
  const next = store.updateProject(current, 1, { label: "Beta", color: "#ff0" });
  assert.deepStrictEqual(next, [
    { dir: "-a", label: "A" },
    { dir: "-b", label: "Beta", color: "#ff0" },
  ]);
});

// ── 7. removeProject splices out the index ──
runTest("removeProject splices out the entry at index", () => {
  const dir = freshSandbox("t7");
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  const current = [
    { dir: "-a", label: "A" },
    { dir: "-b", label: "B" },
    { dir: "-c", label: "C" },
  ];
  const next = store.removeProject(current, 1);
  assert.deepStrictEqual(next, [
    { dir: "-a", label: "A" },
    { dir: "-c", label: "C" },
  ]);
});

// ── 8. encodePath converts /Users/foo/bar → -Users-foo-bar ──
runTest("encodePath produces dash-encoded form", () => {
  const dir = freshSandbox("t8");
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  assert.strictEqual(store.encodePath("/Users/foo/bar"), "-Users-foo-bar");
  assert.strictEqual(store.encodePath("/a/b"), "-a-b");
});

// ── 9. decodeLabel derives the last segment ──
runTest("decodeLabel returns last segment of dash-encoded dir", () => {
  const dir = freshSandbox("t9");
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  assert.strictEqual(store.decodeLabel("-Users-foo-my-project"), "my-project");
  assert.strictEqual(store.decodeLabel("-foo"), "foo");
});

// ── 10. scanAvailable lists dirs minus already-tracked ──
runTest("scanAvailable returns untracked dirs from rootPath", () => {
  const dir = freshSandbox("t10");
  const root = path.join(dir, "claude-projects");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "-Users-a"));
  fs.mkdirSync(path.join(root, "-Users-b"));
  fs.mkdirSync(path.join(root, "-Users-c"));
  fs.writeFileSync(path.join(root, "not-a-project"), "x"); // no leading dash, ignored
  const ctx = makeCtx({ configDir: dir });
  const store = loadStore(ctx);
  const available = store.scanAvailable(root, ["-Users-b"]);
  const dirs = available.map(p => p.dir).sort();
  assert.deepStrictEqual(dirs, ["-Users-a", "-Users-c"]);
});

console.log("\nDone.");
```

- [ ] **Step 3: Run the harness; expect failure (file doesn't exist)**

```bash
node tests/projects-store.test.js
```

Expected: error like `ENOENT: no such file or directory ... src/services/projects-store.js` (or similar). This confirms the test runs and would catch a missing implementation.

- [ ] **Step 4: Commit the test harness**

```bash
git add tests/projects-store.test.js .gitignore
git commit -m "test: add projects-store harness (failing — store not yet implemented)"
```

---

## Task 3: Implement `projects-store.js`

Pure persistence + helpers. No DOM. No `notifyListeners` — that's session-manager-core's job.

**Files:**
- Create: `src/services/projects-store.js`

- [ ] **Step 1: Write the implementation**

Create `src/services/projects-store.js`:

```javascript
// Projects Store — load/merge/write the tracked-projects list in config.local.json.
// All mutations write to config.local.json (gitignored); config.json is never touched.
// Returns: { write, addProject, updateProject, removeProject, scanAvailable, encodePath, decodeLabel }

const { nodeFs, nodePath } = ctx;

// ctx._configDir is set by the test harness to point at a sandbox dir.
// In production the dashboard sets it to <srcDir>/config so we resolve config.local.json there.
const CONFIG_DIR = ctx._configDir;
if (!CONFIG_DIR) throw new Error("[projects-store] ctx._configDir is required");

const LOCAL_PATH = nodePath.join(CONFIG_DIR, "config.local.json");
const TMP_PATH = LOCAL_PATH + ".tmp";

function readLocal() {
  try {
    return JSON.parse(nodeFs.readFileSync(LOCAL_PATH, "utf8"));
  } catch {
    return {};
  }
}

function write(newTracked) {
  const obj = readLocal();
  obj.projects = obj.projects || {};
  obj.projects.tracked = newTracked;
  const json = JSON.stringify(obj, null, 2);
  nodeFs.writeFileSync(TMP_PATH, json);
  nodeFs.renameSync(TMP_PATH, LOCAL_PATH);
  return newTracked;
}

function addProject(current, entry) {
  if (current.some(p => p.dir === entry.dir)) return current;
  const next = [...current, entry];
  write(next);
  return next;
}

function updateProject(current, index, patch) {
  if (index < 0 || index >= current.length) return current;
  const next = current.map((p, i) => i === index ? { ...p, ...patch } : p);
  // Strip empty-string keys so falling back to default behavior works
  const cleaned = next.map(p => {
    const out = {};
    for (const k of Object.keys(p)) if (p[k] !== "" && p[k] != null) out[k] = p[k];
    return out;
  });
  write(cleaned);
  return cleaned;
}

function removeProject(current, index) {
  if (index < 0 || index >= current.length) return current;
  const next = current.filter((_, i) => i !== index);
  write(next);
  return next;
}

function encodePath(absPath) {
  return absPath.replace(/\//g, "-");
}

function decodeLabel(encodedDir) {
  // "-Users-foo-my-project" → "my-project"
  // We pick the last segment that has at least one char.
  const parts = encodedDir.split("-").filter(Boolean);
  return parts[parts.length - 1] || encodedDir;
}

function scanAvailable(rootPath, trackedDirs) {
  const trackedSet = new Set(trackedDirs);
  const out = [];
  let entries;
  try { entries = nodeFs.readdirSync(rootPath); }
  catch { return out; }
  for (const entry of entries) {
    if (!entry.startsWith("-")) continue;
    if (trackedSet.has(entry)) continue;
    try {
      const stat = nodeFs.statSync(nodePath.join(rootPath, entry));
      if (!stat.isDirectory()) continue;
    } catch { continue; }
    out.push({ dir: entry, label: decodeLabel(entry) });
  }
  return out;
}

return { write, addProject, updateProject, removeProject, scanAvailable, encodePath, decodeLabel };
```

- [ ] **Step 2: Run the test harness; expect all 10 tests pass**

```bash
node tests/projects-store.test.js
```

Expected output:

```
PASS  write creates config.local.json when missing
PASS  write preserves unrelated keys in config.local.json
PASS  write uses tmp file then rename
PASS  addProject appends to provided tracked array
PASS  addProject ignores duplicate dir
PASS  updateProject patches the entry at index
PASS  removeProject splices out the entry at index
PASS  encodePath produces dash-encoded form
PASS  decodeLabel returns last segment of dash-encoded dir
PASS  scanAvailable returns untracked dirs from rootPath

Done.
```

If any test fails, fix the implementation (not the test) and re-run.

- [ ] **Step 3: Commit**

```bash
git add src/services/projects-store.js
git commit -m "feat(projects-store): add persistence service for tracked projects

Atomic writes to config.local.json (tmp+rename), helpers for path
encoding/decoding and untracked-dir scanning. All 10 harness tests pass."
```

---

## Task 4: Wire `projects-store` into dashboard bootstrap

The store needs to load before `session-manager-core` so the latter can call into it. Also set `ctx._configDir` so the store knows where `config.local.json` lives.

**Files:**
- Modify: `Jarvis Dashboard.md` (service-load section, currently around lines 104-114)

- [ ] **Step 1: Add `_configDir` to the shared context**

In `Jarvis Dashboard.md`, find the line where `ctx` is built (currently around line 75 — `const ctx = {`). Inside the object literal, add a new property near `_srcDir`:

```javascript
_srcDir: srcDir + "/",
_configDir: nodePath.join(srcDir, "config"),
```

- [ ] **Step 2: Load `projects-store` before `session-manager-core`**

Find the service-load block (currently lines 104-114). Insert the store load right before `_sessionManagerCore`:

```javascript
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
```

- [ ] **Step 3: Syntax-check the dashboard**

```bash
awk '/^```dataviewjs/{f=1;next} /^```/{f=0} f' "Jarvis Dashboard.md" > /tmp/jarvis-dashboard-check.js
node --check /tmp/jarvis-dashboard-check.js && echo OK
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add "Jarvis Dashboard.md"
git commit -m "feat(dashboard): wire projects-store service into bootstrap

Loads before session-manager-core so it can be called from there.
Adds ctx._configDir so the store knows where config.local.json lives."
```

---

## Task 5: Add mutation methods to `session-manager-core`

The store does file I/O; `session-manager-core` does in-memory mutation + listener notification. Three new methods on the returned object: `addProject`, `updateProject`, `removeProject`. Each delegates to `ctx.projectsStore`, splices `tracked` in place, and calls `notifyListeners()`.

**Files:**
- Modify: `src/services/session-manager-core.js:130-268`

- [ ] **Step 1: Read the current file to confirm the insertion point**

```bash
sed -n '255,268p' src/services/session-manager-core.js
```

You should see the `return { ... };` at the end of the factory.

- [ ] **Step 2: Add the mutation helpers inside the factory (before `return`)**

In `src/services/session-manager-core.js`, find this section (currently around lines 249-254):

```javascript
  // ── Cleanup ──
  function cleanup() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveImmediate();
    listeners = [];
  }
```

Insert immediately after the `cleanup` function:

```javascript
  // ── Tracked-projects mutation (delegates to projects-store) ──
  const projectsStore = ctx.projectsStore;

  function replaceTracked(newArray) {
    tracked.length = 0;
    for (const p of newArray) tracked.push(p);
    notifyListeners();
  }

  function addProject(entry) {
    if (!projectsStore) return tracked;
    const next = projectsStore.addProject(tracked, entry);
    replaceTracked(next);
    return next;
  }

  function updateProject(index, patch) {
    if (!projectsStore) return tracked;
    const next = projectsStore.updateProject(tracked, index, patch);
    replaceTracked(next);
    return next;
  }

  function removeProject(index) {
    if (!projectsStore) return tracked;
    const next = projectsStore.removeProject(tracked, index);
    replaceTracked(next);
    return next;
  }
```

- [ ] **Step 3: Expose the three methods in the returned object**

In the same file, locate the `return { ... };` block at the bottom of the factory (currently lines 259-267). Update it to include the new methods:

```javascript
  return {
    createSession, moveSession, getSession, removeSession,
    getAllSessions, getActiveSessionId, setActiveSession, getActiveSession,
    getProject, getProjectColor, getProjectIcon,
    addProject, updateProject, removeProject,
    save: saveDebouncedFn, saveImmediate, load,
    onChange, cleanup,
    get tracked() { return tracked; },
    get colorPalette() { return colorPalette; },
  };
```

- [ ] **Step 4: Syntax-check the file**

```bash
node --check src/services/session-manager-core.js && echo OK
```

Expected: `OK`.

- [ ] **Step 5: Verify the methods land on `sessionManager`**

`session-manager.js` returns whatever `createCore({...})` returns plus `getProjectPath`, so the new methods are forwarded automatically. Confirm by reading lines 67-96:

```bash
sed -n '67,96p' src/services/session-manager.js
```

You should see `const manager = createCore({ ... });` and `manager.getProjectPath = getProjectPath;` then `return manager;`. No edit needed here.

- [ ] **Step 6: Commit**

```bash
git add src/services/session-manager-core.js
git commit -m "feat(session-manager): add addProject/updateProject/removeProject

Delegates to ctx.projectsStore for persistence, splices the in-memory
tracked array in place, then notifies listeners. project-selector and
session-tabs already subscribe to onChange and re-render automatically."
```

---

## Task 6: Modal skeleton — open/close, backdrop, focus

Build the modal as a self-contained factory that returns `{ open, close, isOpen }`. Wire the gear icon last (Task 9).

**Files:**
- Create: `src/widgets/voice-command/core/manage-projects-modal.js`

- [ ] **Step 1: Create the skeleton**

Create `src/widgets/voice-command/core/manage-projects-modal.js`:

```javascript
// Voice Command — Manage projects modal
// Self-contained UI for browsing/adding/editing tracked projects.
// Returns: { createManageProjectsModal }

const { el, T, config } = ctx;
const sessionManager = ctx.sessionManager;
const projectsStore = ctx.projectsStore;
const nodeFs = ctx.nodeFs;
const nodePath = ctx.nodePath;

function expandHome(p) {
  if (p && p.startsWith("~")) {
    return nodePath.join(require("os").homedir(), p.slice(1));
  }
  return p;
}

function createManageProjectsModal() {
  let backdropEl = null;
  let modalEl = null;
  let unsubscribe = null;
  let escHandler = null;

  function isOpen() { return !!backdropEl; }

  function close() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
    if (backdropEl && backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl);
    backdropEl = null;
    modalEl = null;
  }

  function open() {
    if (isOpen()) return;

    backdropEl = el("div", {
      position: "fixed", inset: "0",
      background: "rgba(0,0,0,0.55)",
      zIndex: "9999",
      display: "flex", alignItems: "center", justifyContent: "center",
    });

    modalEl = el("div", {
      width: "min(640px, 92vw)", maxHeight: "84vh",
      background: T.panelBg,
      border: `1px solid ${T.accent}33`,
      borderRadius: "12px",
      boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
      display: "flex", flexDirection: "column", overflow: "hidden",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    });

    // Header
    const header = el("div", {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "14px 18px",
      borderBottom: `1px solid ${T.panelBorder}`,
    });
    header.appendChild(el("div", {
      fontSize: "13px", fontWeight: "600", letterSpacing: "0.5px",
      color: T.text, textTransform: "uppercase",
    }, "Manage projects"));
    const closeBtn = el("div", {
      cursor: "pointer", fontSize: "18px", color: T.textMuted, lineHeight: "1",
      padding: "2px 6px",
    }, "✕");
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    modalEl.appendChild(header);

    // Body container — sections appended in later tasks
    const body = el("div", {
      flex: "1", overflowY: "auto", padding: "16px 18px",
      display: "flex", flexDirection: "column", gap: "20px",
    });
    modalEl.appendChild(body);
    modalEl._body = body;

    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);

    // Click backdrop to close (but not when clicking inside modal)
    backdropEl.addEventListener("click", (e) => {
      if (e.target === backdropEl) close();
    });

    // Esc to close
    escHandler = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", escHandler);

    // Re-render on tracked-list changes
    unsubscribe = sessionManager.onChange(() => {
      if (modalEl && modalEl._renderSections) modalEl._renderSections();
    });

    // Initial render — populated in later tasks
    modalEl._renderSections = () => {
      body.innerHTML = "";
      const placeholder = el("div", { color: T.textMuted, fontSize: "12px" },
        "(sections rendered in subsequent tasks)");
      body.appendChild(placeholder);
    };
    modalEl._renderSections();
  }

  return { open, close, isOpen };
}

return { createManageProjectsModal };
```

- [ ] **Step 2: Syntax-check**

```bash
node --check src/widgets/voice-command/core/manage-projects-modal.js && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add src/widgets/voice-command/core/manage-projects-modal.js
git commit -m "feat(voice-command): manage-projects modal skeleton

Backdrop, header, Esc/click-outside close, focus-trapping container,
auto-resubscribes to sessionManager.onChange. Sections added next."
```

---

## Task 7: Modal — Tracked section (rename, color/icon, remove)

Build the first section: list of currently-tracked projects with rename/color/remove controls.

**Files:**
- Modify: `src/widgets/voice-command/core/manage-projects-modal.js` (extend `_renderSections`)

- [ ] **Step 1: Replace the placeholder `_renderSections` with the Tracked section**

In `src/widgets/voice-command/core/manage-projects-modal.js`, find:

```javascript
    modalEl._renderSections = () => {
      body.innerHTML = "";
      const placeholder = el("div", { color: T.textMuted, fontSize: "12px" },
        "(sections rendered in subsequent tasks)");
      body.appendChild(placeholder);
    };
    modalEl._renderSections();
```

Replace with:

```javascript
    modalEl._renderSections = () => {
      body.innerHTML = "";
      body.appendChild(renderTrackedSection());
      // Available section appended in next task
    };

    function renderTrackedSection() {
      const tracked = sessionManager.tracked;
      const wrapper = el("div", { display: "flex", flexDirection: "column", gap: "8px" });
      wrapper.appendChild(el("div", {
        fontSize: "11px", fontWeight: "600", letterSpacing: "0.5px",
        color: T.textMuted, textTransform: "uppercase",
      }, `Tracked (${tracked.length})`));

      if (tracked.length === 0) {
        wrapper.appendChild(el("div", { color: T.textMuted, fontSize: "12px" },
          "No projects tracked yet."));
        return wrapper;
      }

      const list = el("div", {
        display: "flex", flexDirection: "column",
        border: `1px solid ${T.panelBorder}`, borderRadius: "8px", overflow: "hidden",
      });
      tracked.forEach((proj, idx) => list.appendChild(renderTrackedRow(proj, idx, tracked.length)));
      wrapper.appendChild(list);
      return wrapper;
    }

    function renderTrackedRow(proj, idx, total) {
      const color = sessionManager.getProjectColor(idx);
      const icon = sessionManager.getProjectIcon(idx);
      const row = el("div", {
        display: "flex", alignItems: "center", gap: "10px",
        padding: "10px 12px",
        borderBottom: idx < total - 1 ? `1px solid ${T.panelBorder}` : "none",
      });

      // Color dot
      row.appendChild(el("span", {
        width: "8px", height: "8px", borderRadius: "50%",
        background: color, flexShrink: "0",
      }));

      // Icon
      row.appendChild(el("span", { fontSize: "14px", lineHeight: "1", flexShrink: "0" }, icon));

      // Label (or rename input when editing)
      const labelHost = el("div", { flex: "1", minWidth: "0" });
      const labelText = el("div", {
        fontSize: "12px", fontWeight: "600", color: T.text,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }, proj.label || `Project ${idx}`);
      labelHost.appendChild(labelText);
      const dirText = el("div", {
        fontSize: "10px", color: T.textMuted,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontFamily: "'SF Mono', 'Fira Code', monospace",
      }, proj.dir);
      labelHost.appendChild(dirText);
      row.appendChild(labelHost);

      // Rename
      const renameBtn = el("span", {
        cursor: "pointer", color: T.textMuted, fontSize: "13px",
        padding: "4px 6px",
      }, "✎");
      renameBtn.title = "Rename";
      renameBtn.addEventListener("click", () => beginRename(labelHost, labelText, idx, proj));
      row.appendChild(renameBtn);

      // Color/icon
      const colorBtn = el("span", {
        cursor: "pointer", color: T.textMuted, fontSize: "13px",
        padding: "4px 6px",
      }, "\u{1F3A8}");
      colorBtn.title = "Icon and color";
      colorBtn.addEventListener("click", (e) => openColorPopover(colorBtn, idx, proj));
      row.appendChild(colorBtn);

      // Remove
      const removeBtn = el("span", {
        cursor: "pointer", color: T.textMuted, fontSize: "13px",
        padding: "4px 6px",
      }, "✕");
      removeBtn.title = "Remove";
      removeBtn.addEventListener("click", () => beginRemove(row, idx));
      row.appendChild(removeBtn);

      return row;
    }

    function beginRename(host, currentLabelEl, idx, proj) {
      // el() only sets styles; set DOM attributes separately.
      const input = el("input", {
        background: T.bg, color: T.text,
        border: `1px solid ${T.accent}66`, borderRadius: "6px",
        padding: "4px 8px", fontSize: "12px", fontWeight: "600",
        width: "100%", outline: "none",
      });
      input.type = "text";
      input.value = proj.label || "";
      currentLabelEl.replaceWith(input);
      input.focus();
      input.select();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const newLabel = input.value.trim();
        const patch = { label: newLabel || projectsStore.decodeLabel(proj.dir) };
        sessionManager.updateProject(idx, patch);
        // Re-render handled by onChange subscription
      };
      const cancel = () => {
        if (committed) return;
        committed = true;
        modalEl._renderSections();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
      input.addEventListener("blur", commit);
    }

    function openColorPopover(anchor, idx, proj) {
      // Single popover at a time
      const existing = document.querySelector(".jarvis-color-popover");
      if (existing) existing.remove();

      const palette = sessionManager.colorPalette;
      const popover = el("div", {
        position: "fixed", zIndex: "10001",
        background: T.panelBg, border: `1px solid ${T.accent}33`,
        borderRadius: "8px", padding: "10px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column", gap: "8px",
      });
      popover.classList.add("jarvis-color-popover");

      // Emoji input
      const emojiRow = el("div", { display: "flex", alignItems: "center", gap: "6px" });
      emojiRow.appendChild(el("span", { fontSize: "10px", color: T.textMuted }, "Icon"));
      const emojiInput = el("input", {
        background: T.bg, color: T.text,
        border: `1px solid ${T.panelBorder}`, borderRadius: "4px",
        padding: "2px 6px", fontSize: "13px", width: "44px", textAlign: "center",
      });
      emojiInput.type = "text";
      emojiInput.value = proj.icon || "";
      emojiInput.addEventListener("change", () => {
        sessionManager.updateProject(idx, { icon: emojiInput.value.trim() });
      });
      emojiRow.appendChild(emojiInput);
      popover.appendChild(emojiRow);

      // Swatches
      const swatchRow = el("div", { display: "flex", flexWrap: "wrap", gap: "6px", maxWidth: "180px" });
      palette.forEach((c) => {
        const swatch = el("span", {
          width: "20px", height: "20px", borderRadius: "50%",
          background: c, cursor: "pointer", flexShrink: "0",
          border: c === proj.color ? `2px solid ${T.text}` : `2px solid transparent`,
        });
        swatch.addEventListener("click", () => {
          sessionManager.updateProject(idx, { color: c });
          popover.remove();
        });
        swatchRow.appendChild(swatch);
      });
      popover.appendChild(swatchRow);

      const rect = anchor.getBoundingClientRect();
      popover.style.top = (rect.bottom + 4) + "px";
      popover.style.left = Math.max(8, rect.right - 200) + "px";
      document.body.appendChild(popover);

      const closePopover = (e) => {
        if (popover.contains(e.target) || anchor.contains(e.target)) return;
        popover.remove();
        document.removeEventListener("mousedown", closePopover);
      };
      setTimeout(() => document.addEventListener("mousedown", closePopover), 0);
    }

    function beginRemove(row, idx) {
      // Inline confirm: replace the row's right side with Yes/No
      const existing = row.querySelector(".jarvis-confirm-strip");
      if (existing) return;

      // Count active sessions referencing this index
      const activeCount = sessionManager.getAllSessions().filter(s => s.projectIndex === idx).length;
      const msg = activeCount > 0
        ? `Remove? ${activeCount} active session(s) keep their label.`
        : "Remove?";

      const confirm = el("div", {
        display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto",
        fontSize: "11px", color: T.textMuted,
      });
      confirm.classList.add("jarvis-confirm-strip");
      confirm.appendChild(el("span", {}, msg));
      const yes = el("span", {
        cursor: "pointer", color: T.accent, fontWeight: "600",
        padding: "2px 6px",
      }, "Yes");
      const no = el("span", {
        cursor: "pointer", color: T.textMuted, padding: "2px 6px",
      }, "No");
      yes.addEventListener("click", () => {
        sessionManager.removeProject(idx);
      });
      no.addEventListener("click", () => {
        confirm.remove();
      });
      confirm.appendChild(yes);
      confirm.appendChild(no);

      // Hide the existing right-side icons by appending the strip — simplest is to clear them.
      const buttons = row.querySelectorAll('span[title]');
      buttons.forEach(b => b.style.display = "none");
      row.appendChild(confirm);
    }

    modalEl._renderSections();
```

- [ ] **Step 2: Syntax-check**

```bash
node --check src/widgets/voice-command/core/manage-projects-modal.js && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add src/widgets/voice-command/core/manage-projects-modal.js
git commit -m "feat(manage-modal): tracked section with rename/color/remove

Inline rename input (Enter saves, Esc cancels). Color popover with
emoji input and palette swatches. Inline remove confirm that mentions
how many active sessions will keep their cached label."
```

---

## Task 8: Modal — Available section + folder picker

Add the second section: untracked projects discovered via `scanAvailable`, plus a folder picker for arbitrary paths.

**Files:**
- Modify: `src/widgets/voice-command/core/manage-projects-modal.js` (add `renderAvailableSection`, wire into `_renderSections`)

- [ ] **Step 1: Wire the available section into `_renderSections`**

In `src/widgets/voice-command/core/manage-projects-modal.js`, find:

```javascript
    modalEl._renderSections = () => {
      body.innerHTML = "";
      body.appendChild(renderTrackedSection());
      // Available section appended in next task
    };
```

Replace with:

```javascript
    modalEl._renderSections = () => {
      body.innerHTML = "";
      body.appendChild(renderTrackedSection());
      body.appendChild(renderAvailableSection());
    };
```

- [ ] **Step 2: Add `renderAvailableSection` function**

In the same file, immediately after the `renderTrackedRow` function (and before `beginRename`), add:

```javascript
    function renderAvailableSection() {
      const wrapper = el("div", { display: "flex", flexDirection: "column", gap: "8px" });

      const header = el("div", {
        display: "flex", alignItems: "center", justifyContent: "space-between",
      });
      const trackedDirs = sessionManager.tracked.map(p => p.dir);
      const rootPath = expandHome(config.projects?.rootPath || "~/.claude/projects/");
      const available = projectsStore.scanAvailable(rootPath, trackedDirs);

      header.appendChild(el("div", {
        fontSize: "11px", fontWeight: "600", letterSpacing: "0.5px",
        color: T.textMuted, textTransform: "uppercase",
      }, `Available (${available.length} not tracked)`));

      // Folder-picker button
      const pickWrap = el("label", {
        cursor: "pointer", fontSize: "11px", fontWeight: "600",
        color: T.accent, padding: "4px 10px",
        border: `1px solid ${T.accent}55`, borderRadius: "6px",
      }, "Pick folder");
      const folderInput = el("input", { display: "none" });
      folderInput.type = "file";
      folderInput.setAttribute("webkitdirectory", "");
      folderInput.setAttribute("directory", "");
      folderInput.addEventListener("change", (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        const f = files[0];
        // In Electron (Obsidian's runtime), File.path is the absolute path.
        const fileAbs = f.path || "";
        if (!fileAbs) return; // Not in Electron — bail.
        // webkitRelativePath has form "<picked>/<sub>/.../file.ext".
        // Climb (segs.length - 1) levels with dirname to land on the picked dir itself.
        const np = ctx.nodePath;
        const segs = (f.webkitRelativePath || f.name).split("/");
        let folderAbs = fileAbs;
        for (let i = 0; i < segs.length - 1; i++) folderAbs = np.dirname(folderAbs);
        const encoded = projectsStore.encodePath(folderAbs);
        const label = projectsStore.decodeLabel(encoded);
        sessionManager.addProject({ dir: encoded, label });
        folderInput.value = ""; // reset so re-picking the same folder retriggers change
      });
      pickWrap.appendChild(folderInput);
      header.appendChild(pickWrap);
      wrapper.appendChild(header);

      if (available.length === 0) {
        wrapper.appendChild(el("div", { color: T.textMuted, fontSize: "12px" },
          "No untracked projects found in rootPath."));
        return wrapper;
      }

      const list = el("div", {
        display: "flex", flexDirection: "column",
        border: `1px solid ${T.panelBorder}`, borderRadius: "8px", overflow: "hidden",
      });
      available.forEach((proj, i) => list.appendChild(renderAvailableRow(proj, i, available.length)));
      wrapper.appendChild(list);
      return wrapper;
    }

    function renderAvailableRow(proj, i, total) {
      const row = el("div", {
        display: "flex", alignItems: "center", gap: "10px",
        padding: "10px 12px",
        borderBottom: i < total - 1 ? `1px solid ${T.panelBorder}` : "none",
      });
      row.appendChild(el("span", {
        width: "6px", height: "6px", borderRadius: "50%",
        background: T.textMuted, flexShrink: "0",
      }));
      const labelHost = el("div", { flex: "1", minWidth: "0" });
      labelHost.appendChild(el("div", {
        fontSize: "12px", fontWeight: "600", color: T.text,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }, proj.label));
      labelHost.appendChild(el("div", {
        fontSize: "10px", color: T.textMuted,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontFamily: "'SF Mono', 'Fira Code', monospace",
      }, proj.dir));
      row.appendChild(labelHost);

      const addBtn = el("span", {
        cursor: "pointer", fontSize: "11px", fontWeight: "600",
        color: T.accent, padding: "4px 10px",
        border: `1px solid ${T.accent}55`, borderRadius: "6px",
      }, "+ Add");
      addBtn.addEventListener("click", () => {
        const next = sessionManager.addProject({ dir: proj.dir, label: proj.label });
        // After re-render (triggered by addProject → notifyListeners), find the new row
        // and put its rename input into focus. We do this by storing a flag the renderer
        // picks up.
        modalEl._focusRenameForDir = proj.dir;
      });
      row.appendChild(addBtn);
      return row;
    }
```

- [ ] **Step 3: Wire the auto-focus-rename hand-off**

In the same file, find `renderTrackedRow` and update its label-host construction to honor `_focusRenameForDir`. Locate this block:

```javascript
      // Label (or rename input when editing)
      const labelHost = el("div", { flex: "1", minWidth: "0" });
```

After it (before `row.appendChild(labelHost);`), before the rename button is appended, add:

```javascript
      // Auto-focus rename if a freshly-added entry is requesting it
      if (modalEl._focusRenameForDir === proj.dir) {
        modalEl._focusRenameForDir = null;
        // Defer to after this row is in the DOM
        setTimeout(() => beginRename(labelHost, labelText, idx, proj), 0);
      }
```

- [ ] **Step 4: Syntax-check**

```bash
node --check src/widgets/voice-command/core/manage-projects-modal.js && echo OK
```

Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/widgets/voice-command/core/manage-projects-modal.js
git commit -m "feat(manage-modal): available section + folder picker

Lists untracked Claude project dirs from rootPath with a + Add action,
plus a webkitdirectory folder picker for arbitrary paths. Newly added
entries auto-focus their rename input."
```

---

## Task 9: Wire the gear icon in `voice-command/index.js`

Add the modal load to the loader, instantiate it, and render a gear icon next to the project-selector. Hide the gear when `projects.mode !== "manual"`.

**Files:**
- Modify: `src/widgets/voice-command/index.js`

- [ ] **Step 1: Add the modal to the parallel loader**

Find the `Promise.all([...])` block (currently lines 42-58). Append a new entry:

```javascript
const [
  { stripAnsi, stripMarkdown },
  { createStateMachine },
  { createStorageAdapter },
  { createArcReactor },
  { createTextInput },
  { createConnectionBar },
  { createTerminalPanel },
  { createRecorder },
  { createTTSAdapter },
  { createStreamHandler },
  { createCardRenderer },
  { createReconnectManager },
  { createProcessManager },
  { createSessionTabs },
  { createProjectSelector },
  { createManageProjectsModal },
] = await Promise.all([
  loadSub("core/utilities.js"),
  loadSub("core/state-machine.js"),
  loadSub("adapters/storage-adapter.js"),
  loadSub("core/arc-reactor.js"),
  loadSub("core/text-input.js"),
  loadSub("core/connection-bar.js"),
  loadSub("core/terminal-panel.js"),
  loadSub("adapters/recorder-adapter.js"),
  loadSub("adapters/tts-adapter.js"),
  loadSub("core/stream-handler.js"),
  loadSub("core/interaction-cards.js"),
  loadSub("core/reconnect-manager.js"),
  loadSub("desktop/process-manager.js"),
  loadSub("core/session-tabs.js"),
  loadSub("core/project-selector.js"),
  loadSub("core/manage-projects-modal.js"),
]);
```

- [ ] **Step 2: Instantiate the modal and create the gear icon**

Find the `projSelector` instantiation (currently around lines 167-178):

```javascript
const projSelector = createProjectSelector({
  onSelect: (idx) => {
    ...
  },
  isDisabled: () => uiState === "streaming" || uiState === "launching" || uiState === "recording" || uiState === "transcribing",
});
```

Immediately after this block, add:

```javascript
const manageModal = createManageProjectsModal();

// Gear icon — opens the manage-projects modal. Hidden in auto-discovery mode.
const isManualMode = (config.projects?.mode || "manual") === "manual";
const gearBtn = el("div", {
  display: isManualMode ? "flex" : "none",
  alignItems: "center", justifyContent: "center",
  padding: "6px 10px",
  marginLeft: "6px",
  cursor: "pointer",
  fontSize: "14px", color: T.textMuted,
  borderRadius: "6px",
  transition: "color 0.15s ease, background 0.15s ease",
  flexShrink: "0",
}, "⚙");
gearBtn.title = "Manage projects";
gearBtn.addEventListener("mouseenter", () => { gearBtn.style.color = T.accent; });
gearBtn.addEventListener("mouseleave", () => { gearBtn.style.color = T.textMuted; });
gearBtn.addEventListener("click", (e) => { e.stopPropagation(); manageModal.open(); });
```

- [ ] **Step 3: Place the gear next to the project-selector**

Find where the project-selector is appended to `section` (currently around line 201):

```javascript
section.appendChild(projSelector.el.selector);
```

The selector is a single element. We want to wrap it + gear in a flex row so they sit side-by-side. Replace with:

```javascript
const projectRow = el("div", {
  display: "flex", alignItems: "center", gap: "0",
  marginTop: "12px",
});
// Reset the selector's own marginTop because the row owns it now
projSelector.el.selector.style.marginTop = "0";
projectRow.appendChild(projSelector.el.selector);
projectRow.appendChild(gearBtn);
section.appendChild(projectRow);
```

- [ ] **Step 4: Add a gear-equivalent into the session-tabs row**

Find the line that appends the tab bar (currently around line 205):

```javascript
terminal.el.panel.appendChild(tabs.el.tabBar);
```

After it, add a second gear that's only visible when there ARE active sessions (i.e., when the project-selector is hidden):

```javascript
// Second gear — visible inside the tab row when project-selector is not shown
const tabsGearBtn = gearBtn.cloneNode(true);
tabsGearBtn.addEventListener("click", (e) => { e.stopPropagation(); manageModal.open(); });
tabsGearBtn.addEventListener("mouseenter", () => { tabsGearBtn.style.color = T.accent; });
tabsGearBtn.addEventListener("mouseleave", () => { tabsGearBtn.style.color = T.textMuted; });
tabsGearBtn.style.marginLeft = "auto";
if (isManualMode) tabs.el.tabBar.appendChild(tabsGearBtn);
```

- [ ] **Step 5: Register cleanup**

The modal subscribes to `sessionManager.onChange` while open. The widget's normal teardown will close it via the page unload, but for safety register a cleanup:

Find where `ctx.cleanups.push` is used in `voice-command/index.js` (look for existing `ctx.cleanups.push` calls) and add:

```javascript
ctx.cleanups.push(() => manageModal.close());
```

A reasonable insertion point is right after `const manageModal = createManageProjectsModal();` from Step 2.

- [ ] **Step 6: Syntax-check**

```bash
node --check src/widgets/voice-command/index.js && echo OK
```

Expected: `OK`.

- [ ] **Step 7: Commit**

```bash
git add src/widgets/voice-command/index.js
git commit -m "feat(voice-command): wire manage-projects modal + gear icon

Adds gear icon next to project-selector and inside session-tabs row.
Hidden when projects.mode != 'manual' (auto-discovery owns the list).
Modal closes on widget cleanup."
```

---

## Task 10: Manual integration verification

No automated UI tests; verify in Obsidian per the repo's standing convention (`feedback_node_check_dataviewjs`: always `node --check` widget files; verify against real systems per `feedback_verify_real_systems`).

**Files:** none (verification only)

- [ ] **Step 1: Run `node --check` on every changed JS file**

```bash
node --check src/services/projects-store.js && \
node --check src/services/session-manager-core.js && \
node --check src/widgets/voice-command/core/manage-projects-modal.js && \
node --check src/widgets/voice-command/index.js && \
echo "ALL OK"
```

Expected: `ALL OK`.

- [ ] **Step 2: Re-run the projects-store harness**

```bash
node tests/projects-store.test.js
```

Expected: 10/10 PASS.

- [ ] **Step 3: Extract and check the dashboard JS**

```bash
awk '/^```dataviewjs/{f=1;next} /^```/{f=0} f' "Jarvis Dashboard.md" > /tmp/jarvis-dashboard-check.js
node --check /tmp/jarvis-dashboard-check.js && echo OK
```

Expected: `OK`.

- [ ] **Step 4: Open the dashboard in Obsidian and walk the golden path**

Open the `Jarvis Dashboard.md` note in Obsidian. Verify in order:

1. Dashboard renders without errors (open dev tools → console clean of red errors).
2. Voice-command widget shows the project-selector (when no active session) with a gear icon (⚙) to its right.
3. Click gear → modal opens with backdrop, "Manage projects" header, Tracked section listing your current `tracked` array, Available section listing untracked dirs from `~/.claude/projects/`.
4. Click ✎ on a tracked row → label morphs into an input → type new label → Enter → row re-renders with new label → check `src/config/config.local.json` contains the change.
5. Click 🎨 → popover with emoji input + palette swatches → click a swatch → row's color dot updates → new color persists in `config.local.json`.
6. Click ✕ → "Remove?" confirm strip → click Yes → row disappears, `config.local.json` no longer contains it.
7. In the Available section, click `+ Add` next to an untracked dir → entry moves to Tracked and rename input is auto-focused.
8. Click "Pick folder" → OS folder picker opens → choose any directory → entry appears in Tracked with auto-derived label and dash-encoded `dir`.
9. Close modal (✕, Esc, or click backdrop) → Both `+` (session-tabs) and ▾ (project-selector) pickers reflect the latest tracked list without a dashboard reload.
10. Reload Obsidian → tracked list persists from `config.local.json`.

If any step fails, fix and re-verify the affected step.

- [ ] **Step 5: Verify the always-merge regression case**

If `config.local.json` did not exist before, create one:

```bash
echo '{"projects":{"tracked":[{"dir":"-tmp-merge-check","label":"MergeCheck"}]}}' > src/config/config.local.json
```

Reload the dashboard. Confirm `MergeCheck` appears in the Tracked list (proves the unconditional merge from Task 1 works in local mode). Then remove the test file via the modal's ✕ button.

- [ ] **Step 6: Verify `config.json` is untouched by edits**

```bash
git diff src/config/config.json
```

Expected: no diff. All persistence should be in `config.local.json`.

- [ ] **Step 7: Final commit (only if step 6 surfaced fixes)**

If you needed to fix anything during verification:

```bash
git add -A
git commit -m "fix(manage-modal): <what you fixed>"
```

Otherwise, skip this step.

---

## Files touched (summary)

| File | New / Modified |
|---|---|
| `Jarvis Dashboard.md` | Modified (Task 1, 4) |
| `src/services/projects-store.js` | New (Task 3) |
| `src/services/session-manager-core.js` | Modified (Task 5) |
| `src/widgets/voice-command/core/manage-projects-modal.js` | New (Tasks 6, 7, 8) |
| `src/widgets/voice-command/index.js` | Modified (Task 9) |
| `tests/projects-store.test.js` | New (Task 2) |
| `.gitignore` | Modified (Task 2) |
