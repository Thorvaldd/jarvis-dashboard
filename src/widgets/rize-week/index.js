// Rize Week Widget
// Renders the selected ISO week's Rize summary: per-project bars + top entries.
// Returns: HTMLElement

const { el, T, config, isNarrow, createSectionTitle, addHoverEffect, nodeFs, nodePath } = ctx;

const PROJECT_COLORS = [T.accent, T.purple, T.green, T.gold, T.orange, T.red];
const TOP_ENTRIES_LIMIT = config.widgets?.rizeWeek?.topEntries || 8;

// ── Lazy-load rize-client onto ctx (kept on ctx so weekly-review reuses the cache) ──
async function getRizeClient() {
  if (ctx.rizeClient) return ctx.rizeClient;
  const code = nodeFs.readFileSync(
    nodePath.join(ctx._srcDir, "services", "rize-client.js"), "utf8"
  );
  const _AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  ctx.rizeClient = await new _AsyncFunction("ctx", code)(ctx);
  return ctx.rizeClient;
}

// ── ISO week math (Monday-start; ISO 8601) ──
function startOfIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Monday = 1 ... Sunday = 7
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 1);
  return d;
}

function endOfIsoWeek(monday) {
  const d = new Date(monday);
  d.setUTCDate(d.getUTCDate() + 6);
  return d;
}

function isoWeekParts(date) {
  // Algorithm: ISO week-numbering year and week
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

function isoWeekKey(date) {
  const { year, week } = isoWeekParts(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function fmtYmd(date) {
  return date.toISOString().slice(0, 10);
}

function fmtShortDate(date) {
  // e.g. "May 4"
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtHours(h) {
  if (h >= 10) return h.toFixed(1) + "h";
  if (h >= 1) return h.toFixed(2) + "h";
  return Math.round(h * 60) + "m";
}

function fmtEntryTime(iso) {
  // ISO timestamp → "Mon 09:21" (local time)
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day} ${hh}:${mm}`;
}

// ── State ──
let currentMonday = startOfIsoWeek(new Date());

// ── Build section shell ──
const section = el("div", {
  position: "relative",
  zIndex: "2",
  marginBottom: isNarrow ? "24px" : "40px",
});

const titleRow = createSectionTitle("Rize — This Week");
section.appendChild(titleRow);

// Card container
const card = el("div", {
  background: T.panelBg,
  border: `1px solid ${T.panelBorder}`,
  borderRadius: "12px",
  padding: isNarrow ? "16px" : "20px 24px",
  position: "relative",
  overflow: "hidden",
});
section.appendChild(card);

// Header: prev / week label / next / "today" link
const headerRow = el("div", {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: "16px",
  flexWrap: "wrap",
  gap: "8px",
});

function makeArrowBtn(symbol) {
  const b = el("div", {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: "28px", height: "28px",
    border: `1px solid ${T.panelBorder}`, borderRadius: "6px",
    background: "transparent", cursor: "pointer",
    fontSize: "14px", color: T.textMuted,
    transition: "all 0.2s ease", userSelect: "none",
  }, symbol);
  addHoverEffect(b, { background: T.hoverBg, borderColor: T.accentDim, color: T.accent }, {
    background: "transparent", borderColor: T.panelBorder, color: T.textMuted,
  });
  return b;
}

const prevBtn = makeArrowBtn("◀");
const nextBtn = makeArrowBtn("▶");
const weekLabel = el("div", {
  fontSize: isNarrow ? "13px" : "15px",
  fontWeight: "700", color: T.text,
  letterSpacing: "1px",
  flex: "1 1 auto", textAlign: "center",
});
const todayBtn = el("div", {
  fontSize: "10px", fontWeight: "700", letterSpacing: "1.5px",
  textTransform: "uppercase", color: T.accent,
  padding: "4px 10px", borderRadius: "8px",
  background: "rgba(0,212,255,0.08)", cursor: "pointer",
  transition: "all 0.2s ease",
}, "This week");
addHoverEffect(todayBtn, { background: "rgba(0,212,255,0.16)" }, { background: "rgba(0,212,255,0.08)" });

headerRow.appendChild(prevBtn);
headerRow.appendChild(weekLabel);
headerRow.appendChild(nextBtn);
headerRow.appendChild(todayBtn);
card.appendChild(headerRow);

// Body container — replaced on each render
const body = el("div", {});
card.appendChild(body);

function setBodyMessage(message, color) {
  body.innerHTML = "";
  body.appendChild(el("div", {
    fontSize: "13px", color: color || T.textMuted,
    padding: "12px", textAlign: "center",
    fontStyle: "italic",
  }, message));
}

function renderError(msg) {
  body.innerHTML = "";
  body.appendChild(el("div", {
    fontSize: "12px", color: T.red,
    border: `1px solid ${T.red}55`, borderRadius: "8px",
    background: "rgba(231,76,60,0.06)",
    padding: "10px 14px", lineHeight: "1.5",
  }, msg));
}

function renderData(data) {
  body.innerHTML = "";
  const { entries, projectSummary, totalHours } = data;

  // Total
  const totalRow = el("div", {
    display: "flex", alignItems: "baseline", gap: "10px",
    marginBottom: "16px",
  });
  totalRow.appendChild(el("div", {
    fontSize: "11px", letterSpacing: "2px",
    textTransform: "uppercase", color: T.textMuted,
  }, "Total tracked"));
  totalRow.appendChild(el("div", {
    fontSize: isNarrow ? "20px" : "24px",
    fontWeight: "700", color: T.text,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
  }, fmtHours(totalHours)));
  totalRow.appendChild(el("div", {
    fontSize: "11px", color: T.textMuted,
  }, `${entries.length} entries`));
  body.appendChild(totalRow);

  if (totalHours === 0) {
    body.appendChild(el("div", {
      fontSize: "13px", color: T.textMuted,
      padding: "20px", textAlign: "center", fontStyle: "italic",
    }, "No Rize entries for this week."));
    return;
  }

  // Per-project bars
  const barsWrap = el("div", { marginBottom: "16px" });
  const maxHours = Math.max(...projectSummary.map(p => p.hours), 0.01);
  projectSummary.forEach((proj, idx) => {
    const color = PROJECT_COLORS[idx % PROJECT_COLORS.length];
    const row = el("div", { marginBottom: "8px" });

    const labelRow = el("div", {
      display: "flex", justifyContent: "space-between",
      fontSize: "12px", marginBottom: "4px",
    });
    labelRow.appendChild(el("span", { color: T.text, fontWeight: "600" }, proj.name));
    labelRow.appendChild(el("span", {
      color: T.textMuted, fontFamily: "'SF Mono', 'Fira Code', monospace",
    }, `${fmtHours(proj.hours)} (${proj.pct}%)`));
    row.appendChild(labelRow);

    const barTrack = el("div", {
      height: "6px", background: "rgba(255,255,255,0.04)",
      borderRadius: "3px", overflow: "hidden",
    });
    const barFill = el("div", {
      height: "100%",
      width: Math.max(2, (proj.hours / maxHours) * 100) + "%",
      background: color, borderRadius: "3px",
      transition: "width 0.4s ease",
    });
    barTrack.appendChild(barFill);
    row.appendChild(barTrack);
    barsWrap.appendChild(row);
  });
  body.appendChild(barsWrap);

  // Top entries
  if (entries.length > 0) {
    body.appendChild(el("div", {
      fontSize: "10px", letterSpacing: "2px",
      textTransform: "uppercase", color: T.textMuted,
      marginBottom: "8px", marginTop: "12px",
    }, `Top ${Math.min(TOP_ENTRIES_LIMIT, entries.length)} entries`));

    const list = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
    const topEntries = [...entries]
      .sort((a, b) => b.durationSeconds - a.durationSeconds)
      .slice(0, TOP_ENTRIES_LIMIT);
    topEntries.forEach(e => {
      const row = el("div", {
        display: "grid",
        gridTemplateColumns: isNarrow ? "auto 1fr" : "90px 60px 1fr",
        gap: "10px", alignItems: "baseline",
        fontSize: "12px", padding: "4px 0",
        borderBottom: `1px solid ${T.panelBorder}`,
      });
      if (!isNarrow) {
        row.appendChild(el("span", {
          color: T.textMuted, fontFamily: "'SF Mono', 'Fira Code', monospace",
        }, fmtEntryTime(e.startTime)));
        row.appendChild(el("span", {
          color: T.accent, fontFamily: "'SF Mono', 'Fira Code', monospace",
          textAlign: "right",
        }, fmtHours(e.durationHours)));
      } else {
        const meta = el("span", {
          color: T.textMuted, fontFamily: "'SF Mono', 'Fira Code', monospace",
          fontSize: "10px",
        }, `${fmtEntryTime(e.startTime)} · ${fmtHours(e.durationHours)}`);
        row.appendChild(meta);
      }
      const titleCell = el("span", { color: T.text, lineHeight: "1.4" });
      titleCell.appendChild(document.createTextNode(e.title));
      if (e.projectName) {
        titleCell.appendChild(el("span", {
          color: T.textMuted, marginLeft: "6px", fontSize: "10px",
        }, `· ${e.projectName}`));
      }
      row.appendChild(titleCell);
      list.appendChild(row);
    });
    body.appendChild(list);
  }
}

async function render() {
  const monday = currentMonday;
  const sunday = endOfIsoWeek(monday);
  const key = isoWeekKey(monday);
  weekLabel.textContent = `${key} · ${fmtShortDate(monday)} – ${fmtShortDate(sunday)}`;

  setBodyMessage("Fetching Rize…");

  let client;
  try { client = await getRizeClient(); }
  catch (e) { renderError(`Failed to load Rize client: ${e.message}`); return; }

  const result = await client.fetchWeek(fmtYmd(monday), fmtYmd(sunday));
  if (result.error) { renderError(result.error); return; }
  renderData(result);
}

prevBtn.addEventListener("click", () => {
  const next = new Date(currentMonday);
  next.setUTCDate(next.getUTCDate() - 7);
  currentMonday = next;
  render();
});

nextBtn.addEventListener("click", () => {
  const next = new Date(currentMonday);
  next.setUTCDate(next.getUTCDate() + 7);
  currentMonday = next;
  render();
});

todayBtn.addEventListener("click", () => {
  currentMonday = startOfIsoWeek(new Date());
  render();
});

// Expose the current selection so weekly-review can read it.
ctx._rizeWeekState = {
  getMonday: () => new Date(currentMonday),
  getSunday: () => endOfIsoWeek(currentMonday),
  getKey: () => isoWeekKey(currentMonday),
};

render();

return section;
