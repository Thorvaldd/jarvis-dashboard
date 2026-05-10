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

    // Initial render
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
  }

  return { open, close, isOpen };
}

return { createManageProjectsModal };
