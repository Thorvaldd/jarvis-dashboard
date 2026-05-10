// Manage Projects Widget — gear button that opens the manage-projects modal.
// Standalone so it can sit in any layout, independent of voice-command.
// Hidden when projects.mode !== "manual" (auto-discovery owns the list).
// Returns: HTMLElement

const { el, T, config } = ctx;

const isManualMode = (config.projects?.mode || "manual") === "manual";

const section = el("div", {
  position: "relative",
  zIndex: "2",
  display: isManualMode ? "flex" : "none",
  alignItems: "center",
  justifyContent: "flex-end",
  marginBottom: "16px",
});

if (!isManualMode) return section;

// Lazy-load the modal sub-module from voice-command/core (it's the canonical
// home for manage-projects UI — keeping it there avoids duplicating ~330 lines).
const code = ctx.nodeFs.readFileSync(
  ctx.nodePath.join(ctx._srcDir, "widgets", "voice-command", "core", "manage-projects-modal.js"),
  "utf8"
);
const { createManageProjectsModal } = new Function("ctx", code)(ctx);
const manageModal = createManageProjectsModal();
ctx.cleanups.push(() => manageModal.close());

const button = el("div", {
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: "11px",
  fontWeight: "600",
  letterSpacing: "0.5px",
  textTransform: "uppercase",
  color: T.textMuted,
  background: T.panelBg,
  border: `1px solid ${T.panelBorder}`,
  borderRadius: "8px",
  transition: "color 0.15s ease, border-color 0.15s ease",
  userSelect: "none",
});
button.appendChild(el("span", { fontSize: "14px", lineHeight: "1" }, "⚙"));
button.appendChild(el("span", {}, "Manage projects"));

button.addEventListener("mouseenter", () => {
  button.style.color = T.accent;
  button.style.borderColor = T.accent + "55";
});
button.addEventListener("mouseleave", () => {
  button.style.color = T.textMuted;
  button.style.borderColor = T.panelBorder;
});
button.addEventListener("click", (e) => { e.stopPropagation(); manageModal.open(); });

section.appendChild(button);

return section;
