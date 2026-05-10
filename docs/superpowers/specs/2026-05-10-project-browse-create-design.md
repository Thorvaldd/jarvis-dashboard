# Project Browse / Create / Manage — Design

**Date:** 2026-05-10
**Status:** Draft (pending user review)
**Branch:** weekly-review

## Problem

The voice-command widget shows a project picker (the `+` button in `src/widgets/voice-command/core/session-tabs.js:280` and the dropdown in `src/widgets/voice-command/core/project-selector.js`) but both only iterate `sessionManager.tracked`, which is read once at boot from `config.json` → `projects.tracked`. There is no in-app way to:

1. Discover projects that exist on disk but aren't tracked.
2. Add a new tracked project (currently requires editing `src/config/config.json` by hand).
3. Rename, recolor, or remove a tracked project.

This spec adds a self-service "Manage projects" modal that covers all three.

## Goals

- Browse `~/.claude/projects/` and add untracked dirs to the tracked list.
- Pick any folder on disk (folder picker) and track it, even if it has no Claude sessions yet.
- Rename, change icon/color, and remove existing tracked projects.
- Persist edits to `config.local.json` (gitignored), never `config.json` (committed).
- Reflect changes immediately in the existing `+` and ▾ pickers without a dashboard reload.

## Non-goals

- Reordering tracked projects (deferred — sessions reference projects by integer `projectIndex`, so reordering would silently re-link existing sessions to the wrong slot; out of scope until a stable-id migration).
- Editing the auto-discovery code path (`projects.mode !== "manual"`). The modal hides itself in auto mode.
- Creating new directories on disk. "Add project" only registers an existing path; it never `mkdir`s.
- Multi-Obsidian-pane write coordination. Last write wins.

## Architecture

### New files

- `src/services/projects-store.js` — load/merge/write the tracked-projects list. Owns `config.local.json` mutation. Returns `{ load, write, addProject, updateProject, removeProject }`.
- `src/widgets/voice-command/core/manage-projects-modal.js` — the modal UI factory. Returns `{ open, close, isOpen }`.

### Modified files

- `Jarvis Dashboard.md` — lift the `config.local.json` deep-merge out of the `voiceCommand.mode === "remote"` branch (currently lines 117-138) so it always runs at boot, before services load. Move it up to right after `config` is loaded (after line 40).
- `src/services/session-manager-core.js` — add three methods on the returned object: `addProject(entry)`, `updateProject(index, patch)`, `removeProject(index)`. Each calls into the store, replaces the in-memory `tracked` array contents in place (`tracked.length = 0; tracked.push(...new)`), then calls `notifyListeners()`. `colorPalette` is already exposed as a getter (`session-manager-core.js:266`) and is used by the modal swatches.

### Bootstrap order

`Jarvis Dashboard.md` loads services sequentially (lines 104-114). The new `projects-store` must load **before** `session-manager-core` so the latter can call into it. Insert order: `session-parser → projects-store → stats-engine → timer-service → voice-service → tts-service → session-manager-core → session-manager`.
- `src/widgets/voice-command/index.js` — render a gear icon (⚙) next to the project-selector and to the right of the session-tabs `+` button; click opens the modal. Hide the gear when `config.projects.mode !== "manual"`.

### Untouched but relevant

- `src/widgets/voice-command/core/project-selector.js` and `src/widgets/voice-command/core/session-tabs.js` already read `sessionManager.tracked` and re-render via `sessionManager.onChange`. No changes needed; in-place mutation + `notifyListeners()` propagates automatically.
- `src/services/session-parser.js` auto-discovery path is untouched.

## Data model

Per-project entry (existing shape, unchanged):

```json
{
  "dir": "-Users-oleksii-ai-work-overview",
  "label": "Work Overview",
  "icon": "🛠",
  "color": "#7c6bff"
}
```

- `dir` — encoded path: `/` → `-`, leading dash. Required, unique key.
- `label` — free text. Required. Auto-derived from `dir`'s last decoded segment if not provided.
- `icon` — emoji or single char. Optional. Falls back to `◉` (existing default in `getProjectIcon`).
- `color` — `#rrggbb`. Optional. Falls back to `colorPalette[index % len]` (existing default).

## Persistence

### Read path (boot)

1. Read `src/config/config.json` (committed seed).
2. Deep-merge `src/config/config.local.json` (gitignored) on top — **unconditionally**, not gated on `voiceCommand.mode === "remote"`.
3. Result: `config.projects.tracked` is the merged array. `session-manager-core.js:10` captures it once into the in-memory `tracked` const.

### Write path (mutations)

All writes go through `projects-store.write(newArray)`:

1. Read existing `config.local.json` (or `{}` if missing).
2. Set `obj.projects = obj.projects || {}; obj.projects.tracked = newArray` — **the full array**, not a diff. Avoids merge ambiguity (removing entries via deep-merge requires sentinel values).
3. `JSON.stringify(obj, null, 2)` to `config.local.json.tmp`.
4. `fs.renameSync(tmp, real)` for atomicity (prevents half-written JSON if the process dies mid-write).

`config.json` is never written by this feature.

### In-memory sync after mutation

In session-manager-core, after a successful store write:

```
tracked.length = 0;
tracked.push(...newArray);
notifyListeners();
```

The `get tracked()` getter and all `tracked[i]` callsites continue to work (same array reference, mutated contents). Existing `onChange` subscribers in session-tabs and project-selector re-render.

## UX

### Entry point

A small gear icon (⚙) is added to the voice-command widget in two places (same modal, two affordances):

- Next to the project-selector dropdown (when visible — i.e., no active session yet).
- To the right of the `+` button in the session-tabs bar.

Hidden entirely when `config.projects.mode !== "manual"`.

### Modal layout

Single modal, two stacked sections, no tabs:

```
┌─ Manage projects ──────────────────────────── ✕ ┐
│                                                  │
│  Tracked (4)                                     │
│  ┌────────────────────────────────────────────┐ │
│  │ ● 🛠 Work Overview          ✎  🎨  ✕      │ │
│  │ ● 📊 AcmeCorp           ✎  🎨  ✕      │ │
│  │ ● 🧪 ExampleCo            ✎  🎨  ✕      │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  Available (12 not tracked)         [Pick folder]│
│  ┌────────────────────────────────────────────┐ │
│  │ ○ jarvis-dashboard           [+ Add]       │ │
│  │ ○ demo-llc           [+ Add]       │ │
│  │ …                                          │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
└──────────────────────────────────────────────────┘
```

### Tracked row interactions

- **`✎` rename** — row morphs into an inline `<input>` pre-filled with current label. Enter saves, Esc cancels, blur saves.
- **`🎨` icon/color** — opens a small popover anchored to the row: emoji input (any single grapheme accepted) + 10 color swatches sourced from `sessionManager.colorPalette`. Click a swatch or commit the emoji to save.
- **`✕` remove** — confirms inline ("Remove? [Yes] [No]"). On confirm, calls `removeProject(index)`. If active sessions reference this project, the confirmation prompt mentions "N active session(s) will keep their current label."

### Available row interactions

- Source: `nodeFs.readdirSync(rootPath)` filtering for `entry.startsWith("-")` and dir-type, minus entries already in `tracked`. Same logic as `session-parser.js:67`, factored into a shared util (`src/services/projects-store.js` exports `scanAvailable(rootPath, trackedDirs)`).
- **`+ Add`** — appends with auto-derived label (`dir.split("-").filter(Boolean).pop()`), no icon, no color (so defaults from palette/`◉` apply by index). Modal then jumps the new entry to the Tracked section with the rename input auto-focused (the "auto + optional rename" choice).

### `[Pick folder]` button

- Uses `<input type="file" webkitdirectory>` (Electron supports `File.path` so we get the absolute path).
- Encodes path: `/Users/foo/bar` → `-Users-foo-bar`.
- If the encoded dir is already tracked, no-op + brief flash on the existing row.
- Otherwise added to tracked. If `~/.claude/projects/<encoded>` doesn't exist yet, the entry shows zero sessions until Claude is actually run there — same behavior as a manual config entry pointing at a future dir.

### Modal mechanics

- Fixed-position overlay, semi-transparent backdrop.
- Click-outside or Esc closes.
- Focus trapped inside while open.
- No "Save" button — every mutation persists immediately (direct manipulation).

### Validation

- Duplicate `dir` → silently no-op + brief shake animation on the existing row.
- Empty label after rename → falls back to derived dir name.
- No trim/case normalization on user input — preserve as typed.

## Hot-reload propagation

After any successful mutation, in order:

1. `projects-store.write(newArray)` (atomic file write).
2. `tracked.length = 0; tracked.push(...newArray)` (in-place splice in session-manager-core).
3. `sessionManager.notifyListeners()` — broadcasts to existing subscribers; project-selector and session-tabs re-render.
4. Modal re-renders its own Tracked/Available sections.
5. Live sessions retain their cached `projectLabel`/`projectColor`/`projectIcon` (snapshotted onto each session at creation time per `session-manager-core.js:91-102`). Removing a project does not delete in-flight sessions.

## Edge cases

- **Reordering changes indices** → drag-reorder disabled for v1. Tracked list renders in array order; only rename/color/remove are exposed.
- **Removing in-use project** → confirmation mentions live sessions; they keep their label snapshot.
- **`config.local.json` doesn't exist yet** → first write creates it with `{ "projects": { "tracked": [...] } }`.
- **`config.local.json` already has unrelated keys** (network token, hostname for companion server) → preserved; we only touch `projects.tracked`.
- **Concurrent writes from two panes** → last write wins. Atomic rename prevents corruption, not lost updates.
- **Auto-discovery mode** (`projects.mode !== "manual"`) → gear icon and modal are hidden.
- **Existing seed in `config.json`** (`{ "dir": "your-project-directory", "label": "My Project" }`) — appears merged into tracked on first run; user can remove it via the new ✕ button. Documented, not auto-cleaned.

## File-by-file change summary

| File | Change |
|---|---|
| `Jarvis Dashboard.md` | Move the `config.local.json` deep-merge out of the `mode === "remote"` block; run unconditionally after config load. |
| `src/services/projects-store.js` | **New.** `load()`, `write(arr)`, `addProject(entry)`, `updateProject(idx, patch)`, `removeProject(idx)`, `scanAvailable(rootPath, trackedDirs)`. Atomic writes via tmp + rename. |
| `src/services/session-manager-core.js` | Add `addProject`/`updateProject`/`removeProject` on the returned object; each calls `projectsStore`, mutates `tracked` in place, calls `notifyListeners()`. Pass `projectsStore` via ctx. |
| `src/widgets/voice-command/core/manage-projects-modal.js` | **New.** Modal factory: backdrop, header, Tracked list, Available list, folder picker. Subscribes to `sessionManager.onChange` to re-render. |
| `src/widgets/voice-command/index.js` | Render gear icon (hidden in auto mode); wire it to `manageProjectsModal.open()`. |

## Testing plan

- Round-trip: open modal, add an Available project, verify it appears in Tracked and in the `+` picker, restart Obsidian, verify it persists from `config.local.json`.
- Rename via ✎; verify label shows in `+` picker without restart.
- Color/icon change via 🎨; verify next session created uses the new color.
- Remove a tracked project that has an active session; verify session keeps its label, removed slot is gone from `+` picker, `config.local.json` no longer contains it.
- Pick folder pointing at a non-Claude path; verify entry is tracked, sessions panel is empty until Claude is run there.
- Boot dashboard with `voiceCommand.mode === "local"` and `config.local.json` containing `projects.tracked`; verify the merge happens (regression test for the always-merge change).
- Boot with `projects.mode !== "manual"`; verify gear icon does not render.
- Manual `node --check` on `manage-projects-modal.js`, `projects-store.js`, and the modified `session-manager-core.js` (per repo convention from `feedback_node_check_dataviewjs.md`).

## Out of scope / follow-ups

- Stable IDs for projects so reordering is safe.
- Importing/exporting tracked-list presets.
- Auto-cleanup of the placeholder `your-project-directory` seed in `config.json`.
- Surfacing project management in the mobile/iOS clients — this v1 is desktop Obsidian only.
