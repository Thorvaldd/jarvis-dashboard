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
  // Apply patch, then strip empty-string/null keys ONLY from the patched entry
  // so callers can clear an override (icon = "" → falls back to default palette).
  const merged = { ...current[index], ...patch };
  const cleaned = {};
  for (const k of Object.keys(merged)) {
    if (merged[k] !== "" && merged[k] != null) cleaned[k] = merged[k];
  }
  const next = current.map((p, i) => i === index ? cleaned : p);
  write(next);
  return next;
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

// Best-effort label derivation. The encoding is lossy (single-dash separator
// is also used inside folder names with hyphens), so we just return the last
// "-"-separated token. Callers should let the user rename if it looks wrong.
function decodeLabel(encodedDir) {
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
