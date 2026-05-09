// Rize Client Service
// Fetches a week of Rize time entries via the Rize GraphQL API.
// Returns: { fetchWeek, getProjects, clearCache }

const { nodeFs, nodePath, config } = ctx;

const rizeCfg = config.rize || {};
const apiBaseUrl = rizeCfg.apiBaseUrl || "https://api.rize.io";
const graphqlPath = rizeCfg.graphqlPath || "/api/v1/graphql";
const cacheDurationMs = rizeCfg.cacheDurationMs || 300000;
const secretsPath = expandHome(rizeCfg.secretsFile || "~/.jarvis/secrets.json");

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~")) return nodePath.join(require("os").homedir(), p.slice(1));
  return p;
}

function readToken() {
  try {
    const raw = nodeFs.readFileSync(secretsPath, "utf8");
    const parsed = JSON.parse(raw);
    const token = parsed.rizeApiToken;
    if (!token || token === "your-rize-api-token-here") {
      return { error: `Set rizeApiToken in ${secretsPath} (copy src/config/secrets.example.json).` };
    }
    return { token };
  } catch (e) {
    if (e.code === "ENOENT") {
      return { error: `Secrets file not found: ${secretsPath}. Copy src/config/secrets.example.json there and add your Rize API token.` };
    }
    return { error: `Could not read ${secretsPath}: ${e.message}` };
  }
}

// ── In-memory cache, keyed by date range ──
const cache = new Map();

function cacheKey(startDate, endDate) {
  return `${startDate}|${endDate}`;
}

function clearCache() { cache.clear(); }

// ── GraphQL POST via Obsidian's requestUrl (CORS-safe, works on mobile) ──
async function postGraphQL(token, query, variables) {
  const url = apiBaseUrl.replace(/\/$/, "") + graphqlPath;
  const body = JSON.stringify({ query, variables });

  if (typeof requestUrl === "function") {
    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body,
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}: ${typeof res.text === "string" ? res.text.slice(0, 200) : ""}`);
    }
    return res.json;
  }

  // Fallback: Node https (only used outside Obsidian)
  const https = require("https");
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Time entries query ──
// Field names follow Rize's documented GraphQL conventions (camelCase) and
// match the shape exposed by the Rize MCP. If the schema differs the resulting
// errors propagate to the widget, which renders a clear message.
const TIME_ENTRIES_QUERY = `
  query TimeEntriesForRange($startTime: ISO8601DateTime!, $endTime: ISO8601DateTime!) {
    currentUser {
      timeEntries(startTime: $startTime, endTime: $endTime, first: 500) {
        nodes {
          id
          startTime
          endTime
          title
          description
          source
          status
          durationSeconds
          billable
          project {
            id
            name
          }
          task {
            id
            name
          }
          client {
            id
            name
          }
        }
      }
    }
  }
`;

function toIsoUtc(dateStr, endOfDay) {
  // dateStr is YYYY-MM-DD (local); convert to UTC ISO 8601 day boundary.
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = endOfDay
    ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999))
    : new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  return dt.toISOString();
}

function summarize(entries) {
  let totalSeconds = 0;
  const byProject = new Map();
  for (const e of entries) {
    const secs = e.durationSeconds || 0;
    totalSeconds += secs;
    const projectName = e.project?.name || "(no project)";
    const cur = byProject.get(projectName) || { name: projectName, seconds: 0, count: 0 };
    cur.seconds += secs;
    cur.count += 1;
    byProject.set(projectName, cur);
  }
  const projectSummary = Array.from(byProject.values())
    .map(p => ({
      ...p,
      hours: p.seconds / 3600,
      pct: totalSeconds > 0 ? Math.round((p.seconds / totalSeconds) * 100) : 0,
    }))
    .sort((a, b) => b.seconds - a.seconds);
  return { projectSummary, totalHours: totalSeconds / 3600 };
}

async function fetchWeek(startDate, endDate) {
  const key = cacheKey(startDate, endDate);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheDurationMs) return hit.value;

  const auth = readToken();
  if (auth.error) return { error: auth.error };

  try {
    const variables = {
      startTime: toIsoUtc(startDate, false),
      endTime: toIsoUtc(endDate, true),
    };
    const res = await postGraphQL(auth.token, TIME_ENTRIES_QUERY, variables);
    if (res.errors && res.errors.length) {
      const msg = res.errors.map(e => e.message).join("; ");
      return { error: `Rize API error: ${msg}` };
    }
    const nodes = res.data?.currentUser?.timeEntries?.nodes || [];
    const entries = nodes
      .map(n => ({
        id: n.id,
        startTime: n.startTime,
        endTime: n.endTime,
        title: n.title || "(untitled)",
        description: n.description || "",
        durationSeconds: n.durationSeconds || 0,
        durationHours: (n.durationSeconds || 0) / 3600,
        projectId: n.project?.id || null,
        projectName: n.project?.name || null,
        taskId: n.task?.id || null,
        taskName: n.task?.name || null,
        clientName: n.client?.name || null,
        billable: !!n.billable,
        source: n.source || null,
        status: n.status || null,
      }))
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    const { projectSummary, totalHours } = summarize(entries);
    const value = { entries, projectSummary, totalHours };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { error: `Failed to fetch Rize data: ${e.message}` };
  }
}

return { fetchWeek, clearCache };
