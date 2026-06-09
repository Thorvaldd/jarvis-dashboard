# Weekly Work Review System — Implementation Brief

> Hand this entire file to Claude Code as the project brief. It encodes all
> architecture decisions made during planning so you don't have to re-explain.

## Context

I'm a software developer working across different projects using GitLab, Jira, Confluence, DBeaver, Rider,
and Claude Code. I track time with **Rize** (already capturing my work
automatically) and want a **weekly review system** that aggregates:

1. Claude Code session activity (`~/.claude/projects/*.jsonl`)
2. Rize time tracking (via Rize API)
3. Manual Littlebird daily-journal pastes (deferred — placeholder only for now)
4. My own `memory.md` / project notes from the Obsidian vault

…into a single weekly markdown file in my Obsidian vault that I can review,
edit, and use as a record of what I worked on, my progress, and what's left.

## Why this approach (decisions already made — do not relitigate)

We evaluated several paths before landing here. The relevant constraints:

- **Output target is Obsidian markdown.** A standalone web app would need a
  backend daemon for filesystem access (Claude Code JSONL, vault files), OAuth
  for Rize, CORS handling, deployment. DataviewJS-in-Obsidian gets all of that
  for free and runs on macOS/iOS/Android out of the box.
- **`AndrewKochulab/jarvis-dashboard` already solves ~70% of the dashboard.**
  It parses Claude Code JSONL, has a 30-day analytics widget, focus timer,
  quick capture, and a clean `(ctx) -> HTMLElement` widget contract. We're
  building **on top of it**, not from scratch.
- **`ccusage` was considered for token tracking.** Not needed for v1 —
  jarvis-dashboard already extracts what we care about (sessions, projects,
  prompts) directly from JSONL. Token costs aren't part of the weekly review.
- **Littlebird has no public API.** Manual paste each week (~30 sec) is the
  v1 plan. Probe for local storage will happen later. **Do not attempt to
  scrape, screen-read, or reverse-engineer Littlebird in this iteration.**

## Repository

Fork of: https://github.com/AndrewKochulab/jarvis-dashboard

Already cloned to the working directory before you receive this brief. You
should be operating inside the repo root.

Read these files first to internalize the existing patterns — **do not skip
this step**:

1. `README.md` — overall architecture
2. `Jarvis Dashboard.md` — entry point, contains `WIDGET_MAP`
3. `src/config/config.json` — all configurable values
4. `src/services/session-parser.js` — how JSONL files are read
5. `src/services/stats-engine.js` — how analytics are computed
6. `src/widgets/system-diagnostics.js` — a representative widget for shape
7. `src/widgets/activity-analytics.js` — a more complex widget for shape

The widget contract is: each widget is a `.js` file whose body executes inside
`new Function("ctx", code)` and **returns an `HTMLElement`**. Widgets cannot
use `import`/`export`. They access everything via the shared `ctx` object
(see README's "Shared Context" section).

## Scope of v1 — three new widgets + one new service

### What to add

**New service:** `src/services/rize-client.js`
- Reads `RIZE_API_TOKEN` from `~/.jarvis/secrets.json` (gitignored, see below)
- Exposes `fetchWeek(startDate, endDate)` returning `{ entries, projectSummary, totalHours }`
- Caches responses for 5 minutes in memory (matches `systemDiagnostics.cacheDurationMs` pattern)
- Graceful failure: returns `{ error: string }` on auth/network errors so the widget can render an error state without breaking the dashboard

**Widget 1:** `src/widgets/rize-week.js`
- Renders the current ISO week's Rize summary
- Per-project hour totals with color-coded bars (use `T.accent`, `T.purple`, `T.green` from theme)
- List of top time entries with title, project label, duration
- A "week selector" — prev/next arrows, defaults to current week, supports clicking back through prior weeks
- Loading state while fetching, error state if API fails or token missing

**Widget 2:** `src/widgets/littlebird-paste.js`
- Plain textarea (full-width, ~6 rows) labeled "Littlebird daily journal — paste here"
- Persists to `localStorage` keyed by ISO week (`littlebird-paste:2026-W19`)
- A small "Saved" indicator when content is dirty/saved
- That's it — no parsing, no AI, no integrations. Just a holding pen.

**Widget 3:** `src/widgets/weekly-review.js`
- A button: "Generate weekly review → Obsidian"
- When clicked:
  1. Reads Claude Code sessions for the selected week (use existing `session-parser.js`, extend if needed)
  2. Reads Rize data via the new service
  3. Reads the Littlebird textarea content from `localStorage`
  4. Reads `memory.md` from the vault root if it exists (use `dv.app.vault.adapter.read`)
  5. Composes a markdown document (template below)
  6. Writes it to `Weekly/YYYY-Www.md` in the vault using `dv.app.vault.create` (or `modify` if it already exists)
  7. Opens the new note via `app.workspace.openLinkText`
- Shows progress states: "Gathering Claude sessions…" → "Fetching Rize…" → "Composing…" → "Done — opening note"
- On error in any step, surface a clear message but still write a partial note with placeholders (the user wants to capture *something* even if Rize is down)

### Markdown template for generated weekly note

```markdown
---
week: 2026-W19
start: 2026-05-04
end: 2026-05-10
type: weekly-review
tags: [weekly, claude-code, rize]
generated: 2026-05-10T17:32:00+03:00
---

# Weekly Review — 2026-W19

**2026-05-04 → 2026-05-10**

## Summary

- **Claude Code:** {n_sessions} sessions across {n_projects} projects, ~{cc_hours}h
- **Rize:** {rize_hours}h tracked, top project: {top_project} ({top_pct}%)
- **Top focus areas:** {project_list}

## Projects

### {project_name}

**Rize:** {hours}h ({pct}%) · **Claude Code:** {cc_sessions} sessions, {cc_minutes}m

<details><summary>Claude Code prompts (top 5 of {n})</summary>

- {ts}: {prompt_truncated}
- ...

</details>

<details><summary>Rize entries</summary>

- {date} · {hours}h · {title}
- ...

</details>

(repeat per project, sorted by total time desc)

## Littlebird daily journal

{littlebird_paste_content_or_placeholder}

## Memory & context

> Pulled from `memory.md` at vault root. Edit there to update.

{memory_md_content_or_placeholder}

## Notes

-

## TODO carryover

- [ ]

## Next week focus

- [ ]

---
*Generated by jarvis-dashboard weekly-review widget*
```

**Important:** the script must NOT overwrite content under `## Notes`,
`## TODO carryover`, or `## Next week focus` if the file already exists. Use
this strategy:
- If the file does not exist → write the full template
- If it exists → regenerate everything *above* `## Notes` (Summary, Projects,
  Littlebird, Memory) by splitting on the `## Notes` heading, replacing the
  prefix, keeping the suffix verbatim

### Layout integration

Add to `src/config/config.json` `layout` array, in this order, replacing the
default layout near the top:

```json
{ "type": "header" },
{ "type": "live-sessions" },
{ "type": "rize-week" },
{ "type": "row", "columns": 2, "widgets": ["focus-timer", "quick-capture"] },
{ "type": "littlebird-paste" },
{ "type": "weekly-review" },
{ "type": "agent-cards" },
{ "type": "system-diagnostics" },
{ "type": "activity-analytics" },
{ "type": "footer" }
```

Register the three widgets in `Jarvis Dashboard.md` `WIDGET_MAP`.

### Configuration additions

Extend `src/config/config.json` with:

```json
"rize": {
  "apiBaseUrl": "https://api.rize.io",
  "cacheDurationMs": 300000,
  "secretsFile": "~/.jarvis/secrets.json"
},
"weeklyReview": {
  "outputFolder": "Weekly",
  "memoryFile": "memory.md",
  "promptsPerSessionInReview": 5,
  "preserveSectionsAfter": "## Notes"
}
```

And add a config example for the secrets file at
`src/config/secrets.example.json`:

```json
{
  "rizeApiToken": "your-rize-api-token-here"
}
```

Add `secrets.json` and `~/.jarvis/secrets.json` paths to `.gitignore`.

## What NOT to do in v1

- No Jira integration (next iteration)
- No GitLab MR integration (next iteration)
- No Littlebird scraping or API calls — paste textarea only
- No standalone web app, daemon, or backend service
- No new external dependencies beyond what jarvis-dashboard already uses
- No tests beyond manual verification (this is a personal tool, not production)
- No "AI summarization" of sessions in the widget itself — the user opens the
  generated markdown in Claude.ai or Claude Code if they want synthesis

## How to verify it works

1. The dashboard loads in Obsidian without console errors
2. The Rize widget shows real data for the current week (or a clear error if
   the token isn't configured yet)
3. The Littlebird textarea persists across page reloads
4. Clicking "Generate weekly review" produces a file at `Weekly/YYYY-Www.md`
   in the vault with all sections populated (Claude sessions from real JSONL,
   Rize data if available, Littlebird paste, memory.md content)
5. Re-running on the same week preserves manual edits below `## Notes`

## Working notes for the implementer

- The repo is pre-1.0 (4 commits at fork time). Don't be surprised if there
  are rough edges in the existing code — match the existing style rather
  than refactoring.
- DataviewJS file system access uses Node's `fs` module via
  `app.vault.adapter.basePath` for vault paths, but for `~/.claude/projects/`
  you need absolute paths via `os.homedir()`. The existing `session-parser.js`
  shows the pattern.
- Rize API auth: `Authorization: Bearer <token>`. Endpoints to investigate:
  `/v1/time-entries` with `start_time` and `end_time` query params, and
  `/v1/projects` for the project list. Verify against actual API responses
  before assuming shape — the user has Rize MCP connected and can confirm
  field names if you ask.
- ISO week handling: use Monday as week start (matches Rize and most European
  conventions). The user is in Europe/Kyiv timezone — render times in local
  time but use UTC for storage/comparison.
- Commit in small atomic units: one commit per widget, one for the service,
  one for config additions. Conventional commit messages preferred
  (`feat:`, `fix:`, `chore:`).

## Suggested commit sequence

1. `chore: add secrets.example.json and update .gitignore`
2. `feat: add rize-client service`
3. `feat: add rize-week widget`
4. `feat: add littlebird-paste widget`
5. `feat: add weekly-review widget`
6. `feat: integrate new widgets into default layout`
7. `docs: update README with weekly review system`

## After v1 ships

The user will use this for 1–2 weeks before deciding next steps. Likely v2
candidates (do not implement preemptively):

- Littlebird local-storage probe + parser if files exist on disk
- Jira ticket completion summary from `gitlab-cli` or Jira REST API
- GitLab MR list per week (using existing GitLab tooling the user has)
- An "AI synthesis" button that calls Claude API directly with the generated
  markdown as input and writes a TL;DR to the top of the file

---

## Start here

1. Read the files listed in the "Repository" section above (steps 1–7)
2. Run `ls ~/.claude/projects/` and pick a recent project — read one of its
   `.jsonl` files to confirm the schema matches what `session-parser.js` expects
3. Confirm understanding by listing the files you'll create/modify before
   writing any code
4. Implement in the order of the suggested commit sequence
5. After each commit, briefly verify by re-opening `Jarvis Dashboard.md` in
   Obsidian and confirming the new widget renders (the user will be doing this
   alongside you)

If anything in this brief is ambiguous or contradicts what you find in the
repo, **ask before guessing**. The user prefers a 30-second clarification
question over a rewrite.
