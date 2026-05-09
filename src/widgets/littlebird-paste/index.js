// Littlebird Paste Widget
// Plain textarea — paste your Littlebird daily journal here. Persists per ISO
// week via localStorage. No parsing, no AI; weekly-review picks up the value
// when generating the note.
// Returns: HTMLElement

const { el, T, isNarrow, createSectionTitle } = ctx;

const STORAGE_PREFIX = "littlebird-paste:";
const SAVED_HIDE_MS = 1500;

// ── ISO week math (duplicated from rize-week so this widget is self-contained) ──
function startOfIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 1);
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

function getActiveWeekKey() {
  if (ctx._rizeWeekState?.getKey) {
    try { return ctx._rizeWeekState.getKey(); } catch {}
  }
  return isoWeekKey(new Date());
}

function storageKey(weekKey) {
  return STORAGE_PREFIX + weekKey;
}

// ── Section ──
const section = el("div", {
  position: "relative",
  zIndex: "2",
  marginBottom: isNarrow ? "24px" : "40px",
});

let activeWeek = getActiveWeekKey();

const titleRow = createSectionTitle("Littlebird daily journal", {
  color: T.gold,
  badge: { text: activeWeek, color: T.gold, bg: "rgba(246,211,101,0.1)" },
});
section.appendChild(titleRow);

const card = el("div", {
  background: T.panelBg,
  border: `1px solid ${T.panelBorder}`,
  borderRadius: "12px",
  padding: isNarrow ? "16px" : "20px 24px",
  position: "relative",
  overflow: "hidden",
});
section.appendChild(card);

const helpText = el("div", {
  fontSize: "11px", color: T.textMuted, marginBottom: "10px",
  letterSpacing: "1px", textTransform: "uppercase",
}, "Paste here — saved to this browser, included in the next weekly review");
card.appendChild(helpText);

const textarea = el("textarea", {
  width: "100%",
  minHeight: "140px",
  padding: "12px",
  background: T.bg,
  color: T.text,
  border: `1px solid ${T.panelBorder}`,
  borderRadius: "8px",
  fontFamily: "'SF Mono', 'Fira Code', monospace",
  fontSize: "12px",
  lineHeight: "1.5",
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box",
});
textarea.placeholder = "Paste your Littlebird daily journal for this week here…";
textarea.rows = 6;

textarea.addEventListener("focus", () => {
  textarea.style.borderColor = T.accentDim;
});
textarea.addEventListener("blur", () => {
  textarea.style.borderColor = T.panelBorder;
});

card.appendChild(textarea);

// Status row
const statusRow = el("div", {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  marginTop: "8px", fontSize: "10px", color: T.textMuted,
  fontFamily: "'SF Mono', 'Fira Code', monospace",
});

const charCount = el("span", {}, "0 chars");
const savedIndicator = el("span", {
  color: T.green, opacity: "0",
  transition: "opacity 0.3s ease",
}, "✓ Saved");

statusRow.appendChild(charCount);
statusRow.appendChild(savedIndicator);
card.appendChild(statusRow);

// ── State management ──
function loadForWeek(weekKey) {
  try {
    const v = window.localStorage.getItem(storageKey(weekKey));
    textarea.value = v || "";
  } catch { textarea.value = ""; }
  charCount.textContent = `${textarea.value.length} chars`;
}

let saveTimer = null;
let savedTimer = null;

function persist() {
  try {
    window.localStorage.setItem(storageKey(activeWeek), textarea.value);
    savedIndicator.style.opacity = "1";
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { savedIndicator.style.opacity = "0"; }, SAVED_HIDE_MS);
  } catch (e) {
    savedIndicator.textContent = "✗ Save failed";
    savedIndicator.style.color = T.red;
    savedIndicator.style.opacity = "1";
  }
}

textarea.addEventListener("input", () => {
  charCount.textContent = `${textarea.value.length} chars`;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 350);
});

// React to week-selector changes elsewhere on the dashboard. The rize-week
// widget mutates its state in place; we re-check on a light interval. Use a
// pausable interval so we don't burn cycles when the dashboard is hidden.
const weekCheckMs = 1500;
let weekCheckId = setInterval(checkWeek, weekCheckMs);
ctx.intervals.push(weekCheckId);
ctx.registerPausable(
  () => { weekCheckId = setInterval(checkWeek, weekCheckMs); ctx.intervals.push(weekCheckId); },
  () => { clearInterval(weekCheckId); }
);

function checkWeek() {
  const next = getActiveWeekKey();
  if (next === activeWeek) return;
  // Persist current week before swapping so unsaved input doesn't disappear.
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; persist(); }
  activeWeek = next;
  // Refresh the badge text in the title row
  const badge = titleRow.querySelector("span:last-child");
  if (badge) badge.textContent = activeWeek;
  loadForWeek(activeWeek);
}

// Expose the value getter so weekly-review can read it without going through localStorage directly
ctx._littlebirdPaste = {
  getForWeek(weekKey) {
    if (weekKey === activeWeek) return textarea.value;
    try { return window.localStorage.getItem(storageKey(weekKey)) || ""; }
    catch { return ""; }
  },
};

loadForWeek(activeWeek);

return section;
