// Weekly Review Widget
// Big "Generate weekly review → Obsidian" button. Gathers Claude Code sessions,
// Rize data, the Littlebird paste and memory.md, composes a markdown weekly
// note, writes it to Weekly/YYYY-Www.md (preserving sections after "## Notes"
// on regeneration), and opens it.
// Returns: HTMLElement

const { el, T, config, isNarrow, createSectionTitle, addHoverEffect, nodeFs, nodePath } = ctx;

const reviewCfg = config.weeklyReview || {};
const OUTPUT_FOLDER = reviewCfg.outputFolder || "Weekly";
const MEMORY_FILE = reviewCfg.memoryFile || "memory.md";
const PROMPTS_PER_SESSION = reviewCfg.promptsPerSessionInReview || 5;
const PRESERVE_AFTER = reviewCfg.preserveSectionsAfter || "## Notes";

// ── Lazy-load rize-client ──
async function getRizeClient() {
  if (ctx.rizeClient) return ctx.rizeClient;
  const code = nodeFs.readFileSync(
    nodePath.join(ctx._srcDir, "services", "rize-client.js"), "utf8"
  );
  const _AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  ctx.rizeClient = await new _AsyncFunction("ctx", code)(ctx);
  return ctx.rizeClient;
}

// ── ISO week math (Monday-start, ISO 8601) ──
function startOfIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 1);
  return d;
}

function endOfIsoWeek(monday) {
  const d = new Date(monday);
  d.setUTCDate(d.getUTCDate() + 6);
  return d;
}

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function fmtYmd(date) { return date.toISOString().slice(0, 10); }

function activeWeek() {
  if (ctx._rizeWeekState?.getMonday) {
    try {
      const monday = ctx._rizeWeekState.getMonday();
      const sunday = ctx._rizeWeekState.getSunday();
      return { monday, sunday, key: ctx._rizeWeekState.getKey() };
    } catch {}
  }
  const monday = startOfIsoWeek(new Date());
  return { monday, sunday: endOfIsoWeek(monday), key: isoWeekKey(monday) };
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~")) return nodePath.join(require("os").homedir(), p.slice(1));
  return p;
}

// ── Local-time ISO 8601 with offset (e.g. 2026-05-09T17:32:00+03:00) ──
function localIsoNow() {
  const d = new Date();
  const pad = n => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const oh = pad(offsetMin / 60);
  const om = pad(offsetMin % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

// ── Claude Code session scan for a date range ──
function gatherClaudeWeek(mondayDate, sundayDate) {
  const rootPath = expandHome(config.projects?.rootPath || "~/.claude/projects/");
  const startMs = Date.UTC(
    mondayDate.getUTCFullYear(), mondayDate.getUTCMonth(), mondayDate.getUTCDate(),
    0, 0, 0, 0
  );
  const endMs = Date.UTC(
    sundayDate.getUTCFullYear(), sundayDate.getUTCMonth(), sundayDate.getUTCDate(),
    23, 59, 59, 999
  );

  const trackedDirs = new Map();
  for (const proj of (config.projects?.tracked || [])) {
    trackedDirs.set(proj.dir, proj.label);
  }

  let allDirs;
  try {
    allDirs = nodeFs.readdirSync(rootPath).filter(e => e.startsWith("-"));
  } catch { return { perProject: {}, totalSessions: 0, totalMinutes: 0 }; }

  const perProject = {};
  let totalSessions = 0;
  let totalMinutes = 0;

  for (const dir of allDirs) {
    const projPath = nodePath.join(rootPath, dir);
    let stat;
    try { stat = nodeFs.statSync(projPath); }
    catch { continue; }
    if (!stat.isDirectory()) continue;

    const label = trackedDirs.get(dir)
      || dir.split("-").filter(Boolean).pop()
      || dir;

    let files;
    try {
      files = nodeFs.readdirSync(projPath).filter(f => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const fname of files) {
      const fp = nodePath.join(projPath, fname);
      let fstat;
      try { fstat = nodeFs.statSync(fp); }
      catch { continue; }
      // Quick mtime filter: skip files definitely outside the range. Pre-week
      // files have nothing relevant; post-week we still allow because mtime
      // could be after the file's last activity moved it forward.
      if (fstat.mtimeMs < startMs - 30 * 86400000) continue;

      const session = parseSessionForWeek(fp, startMs, endMs);
      if (!session) continue;

      if (!perProject[label]) {
        perProject[label] = { name: label, sessions: 0, minutes: 0, prompts: [] };
      }
      perProject[label].sessions += 1;
      perProject[label].minutes += session.minutes;
      for (const p of session.prompts) perProject[label].prompts.push(p);
      totalSessions += 1;
      totalMinutes += session.minutes;
    }
  }

  // Sort prompts in each project by timestamp desc
  for (const proj of Object.values(perProject)) {
    proj.prompts.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  }

  return { perProject, totalSessions, totalMinutes };
}

function parseSessionForWeek(filePath, startMs, endMs) {
  let content;
  try { content = nodeFs.readFileSync(filePath, "utf8"); }
  catch { return null; }

  const lines = content.split("\n");
  let earliest = null;
  let latest = null;
  const prompts = [];

  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    const ts = rec.timestamp;
    if (ts) {
      const t = Date.parse(ts);
      if (!isNaN(t)) {
        if (earliest === null || t < earliest) earliest = t;
        if (latest === null || t > latest) latest = t;
      }
    }

    if (rec.type === "user" && rec.message) {
      const text = extractUserText(rec.message.content);
      if (text && !isCommandCaveat(text)) {
        prompts.push({ ts, text: truncate(text, 240) });
      }
    }
  }

  if (earliest === null || latest === null) return null;
  // Keep the session if any activity falls inside the week range.
  if (latest < startMs || earliest > endMs) return null;

  // Clamp duration to the requested range so a single rolling session doesn't
  // dominate a week's stats.
  const clampedStart = Math.max(earliest, startMs);
  const clampedEnd = Math.min(latest, endMs);
  const minutes = Math.max(1, Math.round((clampedEnd - clampedStart) / 60000));

  // Filter prompts to the week range
  const inRangePrompts = prompts.filter(p => {
    if (!p.ts) return false;
    const t = Date.parse(p.ts);
    return !isNaN(t) && t >= startMs && t <= endMs;
  });

  return { minutes, prompts: inRangePrompts };
}

function extractUserText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (typeof block === "string") return block;
    }
  }
  return "";
}

function isCommandCaveat(text) {
  return text.startsWith("<command-")
    || text.startsWith("<local-command-")
    || text.includes("<command-name>")
    || text.startsWith("<system-reminder>");
}

function truncate(s, max) {
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ── Compose the markdown ──
function fmtMinutes(min) {
  const h = min / 60;
  if (h >= 10) return h.toFixed(1) + "h";
  if (h >= 1) return h.toFixed(2) + "h";
  return Math.round(min) + "m";
}

function fmtHoursDecimal(h) {
  if (h >= 10) return h.toFixed(1) + "h";
  if (h >= 1) return h.toFixed(2) + "h";
  return Math.round(h * 60) + "m";
}

function fmtEntryDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day} ${date} ${hh}:${mm}`;
}

function composeMarkdown({ key, mondayDate, sundayDate, claude, rize, littlebird, memory }) {
  const startStr = fmtYmd(mondayDate);
  const endStr = fmtYmd(sundayDate);

  // Build a unified per-project list combining Rize + Claude data
  const allProjectNames = new Set();
  if (rize.projectSummary) {
    for (const p of rize.projectSummary) allProjectNames.add(p.name);
  }
  for (const name of Object.keys(claude.perProject || {})) allProjectNames.add(name);

  const merged = Array.from(allProjectNames).map(name => {
    const rizeProj = (rize.projectSummary || []).find(p => p.name === name);
    const ccProj = claude.perProject[name];
    return {
      name,
      rizeHours: rizeProj?.hours || 0,
      rizePct: rizeProj?.pct || 0,
      rizeEntries: (rize.entries || []).filter(e => (e.projectName || "(no project)") === name),
      ccSessions: ccProj?.sessions || 0,
      ccMinutes: ccProj?.minutes || 0,
      ccPrompts: ccProj?.prompts || [],
    };
  }).sort((a, b) => {
    const aw = a.rizeHours * 60 + a.ccMinutes / 2;
    const bw = b.rizeHours * 60 + b.ccMinutes / 2;
    return bw - aw;
  });

  const ccHours = (claude.totalMinutes / 60).toFixed(1);
  const rizeHours = (rize.totalHours || 0).toFixed(1);
  const topProject = merged[0];
  const topProjectLabel = topProject
    ? `${topProject.name} (${topProject.rizePct || Math.round(100 * topProject.ccMinutes / Math.max(1, claude.totalMinutes))}%)`
    : "—";

  const lines = [];
  lines.push("---");
  lines.push(`week: ${key}`);
  lines.push(`start: ${startStr}`);
  lines.push(`end: ${endStr}`);
  lines.push(`type: weekly-review`);
  lines.push(`tags: [weekly, claude-code, rize]`);
  lines.push(`generated: ${localIsoNow()}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Weekly Review — ${key}`);
  lines.push("");
  lines.push(`**${startStr} → ${endStr}**`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Claude Code:** ${claude.totalSessions} sessions across ${Object.keys(claude.perProject).length} projects, ~${ccHours}h`);
  if (rize.error) {
    lines.push(`- **Rize:** _unavailable — ${rize.error}_`);
  } else {
    lines.push(`- **Rize:** ${rizeHours}h tracked, top project: ${topProjectLabel}`);
  }
  lines.push(`- **Top focus areas:** ${merged.slice(0, 3).map(p => p.name).join(", ") || "—"}`);
  lines.push("");
  lines.push("## Projects");
  lines.push("");

  for (const proj of merged) {
    lines.push(`### ${proj.name}`);
    lines.push("");
    const ccLabel = proj.ccSessions > 0
      ? `**Claude Code:** ${proj.ccSessions} sessions, ${fmtMinutes(proj.ccMinutes)}`
      : `**Claude Code:** —`;
    const rizeLabel = proj.rizeHours > 0
      ? `**Rize:** ${fmtHoursDecimal(proj.rizeHours)} (${proj.rizePct}%)`
      : `**Rize:** —`;
    lines.push(`${rizeLabel} · ${ccLabel}`);
    lines.push("");

    if (proj.ccPrompts.length > 0) {
      const top = proj.ccPrompts.slice(0, PROMPTS_PER_SESSION);
      lines.push(`<details><summary>Claude Code prompts (top ${top.length} of ${proj.ccPrompts.length})</summary>`);
      lines.push("");
      for (const p of top) {
        const t = p.ts ? p.ts.slice(0, 16).replace("T", " ") : "??";
        lines.push(`- ${t}: ${p.text}`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }

    if (proj.rizeEntries.length > 0) {
      lines.push(`<details><summary>Rize entries (${proj.rizeEntries.length})</summary>`);
      lines.push("");
      for (const e of proj.rizeEntries) {
        lines.push(`- ${fmtEntryDateTime(e.startTime)} · ${fmtHoursDecimal(e.durationHours)} · ${e.title}`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  if (merged.length === 0) {
    lines.push("_No tracked activity for this week._");
    lines.push("");
  }

  lines.push("## Littlebird daily journal");
  lines.push("");
  if (littlebird && littlebird.trim().length > 0) {
    lines.push(littlebird.trim());
  } else {
    lines.push("_No paste captured for this week. Add it via the Littlebird widget on the dashboard._");
  }
  lines.push("");
  lines.push("## Memory & context");
  lines.push("");
  lines.push(`> Pulled from \`${MEMORY_FILE}\` at vault root. Edit there to update.`);
  lines.push("");
  if (memory && memory.trim().length > 0) {
    lines.push(memory.trim());
  } else {
    lines.push(`_No \`${MEMORY_FILE}\` found at vault root._`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- ");
  lines.push("");
  lines.push("## TODO carryover");
  lines.push("");
  lines.push("- [ ] ");
  lines.push("");
  lines.push("## Next week focus");
  lines.push("");
  lines.push("- [ ] ");
  lines.push("");
  lines.push("---");
  lines.push("*Generated by jarvis-dashboard weekly-review widget*");
  lines.push("");
  return lines.join("\n");
}

// ── File composition that preserves "## Notes" and below ──
function buildFinalContent(existing, fresh) {
  if (!existing) return fresh;
  const marker = `\n${PRESERVE_AFTER}`;
  const idx = existing.indexOf(marker);
  if (idx === -1) {
    // No preserve marker in existing file — overwrite entirely.
    return fresh;
  }
  const freshIdx = fresh.indexOf(marker);
  if (freshIdx === -1) {
    // Shouldn't happen — fresh template always has the marker.
    return fresh;
  }
  // Replace prefix-up-to-marker with fresh's prefix, keep existing's suffix verbatim.
  return fresh.slice(0, freshIdx) + existing.slice(idx);
}

// ── File I/O ──
function vaultBasePath() {
  // app.vault.adapter.basePath works in Obsidian Desktop; on mobile it's via
  // adapter.getBasePath() — fall back to ctx._adapter.vaultBasePath().
  try { return app.vault.adapter.basePath; } catch {}
  try { return ctx._adapter.vaultBasePath(); } catch {}
  return "";
}

async function readMemoryMd() {
  const base = vaultBasePath();
  if (!base) return "";
  const fp = nodePath.join(base, MEMORY_FILE);
  try { return nodeFs.readFileSync(fp, "utf8"); }
  catch { return ""; }
}

function writeWeeklyNote(weekKey, content) {
  const base = vaultBasePath();
  if (!base) throw new Error("Could not resolve vault base path.");
  const folderAbs = nodePath.join(base, OUTPUT_FOLDER);
  try { nodeFs.mkdirSync(folderAbs, { recursive: true }); } catch {}
  const filePath = nodePath.join(folderAbs, `${weekKey}.md`);
  let existing = "";
  try { existing = nodeFs.readFileSync(filePath, "utf8"); } catch {}
  const finalContent = buildFinalContent(existing, content);
  nodeFs.writeFileSync(filePath, finalContent);
  return `${OUTPUT_FOLDER}/${weekKey}.md`;
}

function openWeeklyNote(relativePath) {
  try {
    if (app && app.workspace && typeof app.workspace.openLinkText === "function") {
      app.workspace.openLinkText(relativePath, "");
    }
  } catch {}
}

// ── UI ──
const section = el("div", {
  position: "relative",
  zIndex: "2",
  marginBottom: isNarrow ? "24px" : "40px",
});

section.appendChild(createSectionTitle("Weekly Review", { color: T.green }));

const card = el("div", {
  background: T.panelBg,
  border: `1px solid ${T.panelBorder}`,
  borderRadius: "12px",
  padding: isNarrow ? "16px" : "20px 24px",
  position: "relative", overflow: "hidden",
  display: "flex", flexDirection: isNarrow ? "column" : "row",
  alignItems: isNarrow ? "stretch" : "center",
  gap: "16px",
});
section.appendChild(card);

const description = el("div", {
  flex: "1 1 auto", color: T.textMuted, fontSize: "12px",
  lineHeight: "1.5",
});
const descLine1 = el("div", {
  color: T.text, fontWeight: "600", fontSize: "13px",
  marginBottom: "4px",
}, "Generate a weekly markdown review");
const descLine2 = el("div", {}, `Aggregates Claude Code sessions, Rize, your Littlebird paste and ${MEMORY_FILE} into ${OUTPUT_FOLDER}/<week>.md. Preserves anything below "${PRESERVE_AFTER}".`);
description.appendChild(descLine1);
description.appendChild(descLine2);
card.appendChild(description);

const btn = el("div", {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  gap: "10px", padding: "12px 22px",
  border: `1px solid ${T.green}66`, borderRadius: "8px",
  background: "rgba(68,201,143,0.08)",
  cursor: "pointer", transition: "all 0.3s ease",
  whiteSpace: "nowrap", userSelect: "none",
});
btn.appendChild(el("span", { fontSize: "14px", color: T.green }, "✸"));
const btnLabel = el("span", {
  fontSize: "11px", fontWeight: "700", letterSpacing: "2px",
  textTransform: "uppercase", color: T.green,
  fontFamily: "'SF Mono', 'Fira Code', monospace",
}, "Generate weekly review");
btn.appendChild(btnLabel);
addHoverEffect(btn, {
  boxShadow: `0 0 16px rgba(68,201,143,0.25)`,
  borderColor: `${T.green}aa`,
  background: "rgba(68,201,143,0.14)",
}, {
  boxShadow: "none",
  borderColor: `${T.green}66`,
  background: "rgba(68,201,143,0.08)",
});
card.appendChild(btn);

const status = el("div", {
  fontSize: "11px", color: T.textMuted, marginTop: "10px",
  fontFamily: "'SF Mono', 'Fira Code', monospace",
  minHeight: "16px",
});
section.appendChild(status);

let busy = false;

function setStatus(text, color) {
  status.textContent = text;
  status.style.color = color || T.textMuted;
}

function setBtnEnabled(enabled, label) {
  btn.style.opacity = enabled ? "1" : "0.55";
  btn.style.pointerEvents = enabled ? "auto" : "none";
  if (label) btnLabel.textContent = label;
}

btn.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  setBtnEnabled(false, "Working…");
  const { monday, sunday, key } = activeWeek();

  // 1. Claude Code sessions
  setStatus("Gathering Claude sessions…", T.accent);
  let claude;
  try { claude = gatherClaudeWeek(monday, sunday); }
  catch (e) {
    claude = { perProject: {}, totalSessions: 0, totalMinutes: 0, error: e.message };
  }

  // 2. Rize
  setStatus("Fetching Rize…", T.accent);
  let rize = { entries: [], projectSummary: [], totalHours: 0 };
  try {
    const client = await getRizeClient();
    const result = await client.fetchWeek(fmtYmd(monday), fmtYmd(sunday));
    if (result.error) rize = { entries: [], projectSummary: [], totalHours: 0, error: result.error };
    else rize = result;
  } catch (e) {
    rize = { entries: [], projectSummary: [], totalHours: 0, error: e.message };
  }

  // 3. Littlebird paste + memory.md
  const littlebird = (ctx._littlebirdPaste?.getForWeek?.(key)) || readLittlebirdLs(key);
  const memory = await readMemoryMd();

  // 4. Compose
  setStatus("Composing…", T.accent);
  let markdown;
  try {
    markdown = composeMarkdown({
      key, mondayDate: monday, sundayDate: sunday,
      claude, rize, littlebird, memory,
    });
  } catch (e) {
    setStatus(`Compose failed: ${e.message}`, T.red);
    setBtnEnabled(true, "Generate weekly review");
    busy = false;
    return;
  }

  // 5. Write file
  let writtenPath;
  try { writtenPath = writeWeeklyNote(key, markdown); }
  catch (e) {
    setStatus(`Write failed: ${e.message}`, T.red);
    setBtnEnabled(true, "Generate weekly review");
    busy = false;
    return;
  }

  setStatus(`Done — opening ${writtenPath}`, T.green);
  openWeeklyNote(writtenPath.replace(/\.md$/, ""));
  setBtnEnabled(true, "Generate weekly review");
  busy = false;
});

function readLittlebirdLs(weekKey) {
  try { return window.localStorage.getItem(`littlebird-paste:${weekKey}`) || ""; }
  catch { return ""; }
}

return section;
