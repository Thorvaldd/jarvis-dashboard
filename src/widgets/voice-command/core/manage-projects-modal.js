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
