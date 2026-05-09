// Rize Client Service
// Fetches a week of Rize time entries via the Rize GraphQL API and exposes a
// project-bucketing helper. Internal data shape is snake_case to match the
// shape the Rize MCP returns (start_time, duration_seconds, project_name,
// tag_suggestions[]) so widgets can use the same field names whether they get
// data from this client or, in v2, an MCP bridge.
// Returns: { fetchWeek, bucketEntries, classify, clearCache }

const { nodeFs, nodePath, config } = ctx;

const rizeCfg = config.rize || {};
const apiBaseUrl = rizeCfg.apiBaseUrl || "https://api.rize.io";
const graphqlPath = rizeCfg.graphqlPath || "/api/v1/graphql";
const cacheDurationMs = rizeCfg.cacheDurationMs || 300000;
const secretsPath = expandHome(rizeCfg.secretsFile || "~/.jarvis/secrets.json");
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // safety cap → up to 2000 entries per week

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

const cache = new Map();
let cachedTimezone = undefined; // undefined = not probed; null = probed and unavailable

function cacheKey(start, end) { return `${start}|${end}`; }
function clearCache() { cache.clear(); cachedTimezone = undefined; }

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

// ── GraphQL: time entries query ──
// Field names in the request follow standard GraphQL camelCase. The response
// is normalized to snake_case via normalizeNode() so the rest of the system
// can treat camelCase / snake_case schemas interchangeably.
const TIME_ENTRIES_QUERY = `
  query TimeEntriesForRange($startTime: ISO8601DateTime!, $endTime: ISO8601DateTime!, $cursor: String) {
    currentUser {
      timeEntries(startTime: $startTime, endTime: $endTime, first: ${PAGE_SIZE}, after: $cursor) {
        nodes {
          id
          startTime
          endTime
          title
          description
          durationSeconds
          billable
          source
          status
          project { id name }
          task { id name }
          client { id name }
          tagSuggestions {
            tagName
            tagType
            confidenceScore
          }
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`;

const TIMEZONE_QUERY = `query Tz { currentUser { timezone } }`;

// ── Response normalization (handles snake_case OR camelCase responses) ──
function pick(node, snake, camel) {
  if (node[snake] !== undefined && node[snake] !== null) return node[snake];
  if (node[camel] !== undefined && node[camel] !== null) return node[camel];
  return null;
}

function normalizeNode(node) {
  const proj = node.project || {};
  const task = node.task || {};
  const cli = node.client || {};
  const tagSugs = pick(node, "tag_suggestions", "tagSuggestions") || [];
  const durationSeconds = pick(node, "duration_seconds", "durationSeconds") || 0;
  return {
    id: node.id,
    start_time: pick(node, "start_time", "startTime"),
    end_time: pick(node, "end_time", "endTime"),
    title: node.title || "(untitled)",
    description: node.description || "",
    duration_seconds: durationSeconds,
    duration_hours: durationSeconds / 3600,
    billable: !!node.billable,
    source: node.source || null,
    status: node.status || null,
    project_id: proj.id || pick(node, "project_id", "projectId"),
    project_name: proj.name || pick(node, "project_name", "projectName"),
    task_id: task.id || pick(node, "task_id", "taskId"),
    task_name: task.name || pick(node, "task_name", "taskName"),
    client_id: cli.id || pick(node, "client_id", "clientId"),
    client_name: cli.name || pick(node, "client_name", "clientName"),
    tag_suggestions: tagSugs.map(t => ({
      tag_name: t.tag_name || t.tagName || null,
      tag_type: t.tag_type || t.tagType || null,
      confidence_score: t.confidence_score || t.confidenceScore || null,
    })),
  };
}

function toIsoUtc(dateStr, endOfDay) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = endOfDay
    ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999))
    : new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  return dt.toISOString();
}

async function probeTimezone(token) {
  if (cachedTimezone !== undefined) return cachedTimezone;
  // Allow a static override from config.rize.timezone before hitting the API.
  if (rizeCfg.timezone) {
    cachedTimezone = rizeCfg.timezone;
    return cachedTimezone;
  }
  try {
    const res = await postGraphQL(token, TIMEZONE_QUERY, {});
    if (res?.errors) {
      cachedTimezone = null;
      return null;
    }
    const cu = res?.data?.currentUser || res?.data?.current_user;
    cachedTimezone = (cu && (cu.timezone || cu.time_zone)) || null;
  } catch {
    cachedTimezone = null;
  }
  return cachedTimezone;
}

async function fetchWeek(startDate, endDate) {
  const key = cacheKey(startDate, endDate);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheDurationMs) return hit.value;

  const auth = readToken();
  if (auth.error) return { error: auth.error };

  try {
    const startTimeIso = toIsoUtc(startDate, false);
    const endTimeIso = toIsoUtc(endDate, true);

    const allNodes = [];
    let cursor = null;
    let pageCount = 0;

    while (pageCount < MAX_PAGES) {
      const res = await postGraphQL(auth.token, TIME_ENTRIES_QUERY, {
        startTime: startTimeIso,
        endTime: endTimeIso,
        cursor,
      });
      if (res?.errors && res.errors.length) {
        const msg = res.errors.map(e => e.message).join("; ");
        return { error: `Rize API error: ${msg}` };
      }
      const cu = res?.data?.currentUser || res?.data?.current_user;
      if (!cu) {
        return { error: "Rize API returned no currentUser data. Check token permissions." };
      }
      const te = cu.timeEntries || cu.time_entries || {};
      const nodes = te.nodes || te.entries || [];
      for (const n of nodes) allNodes.push(normalizeNode(n));
      const pi = te.pageInfo || te.page_info || {};
      const hasNext = pi.hasNextPage ?? pi.has_next_page ?? false;
      const next = pi.endCursor ?? pi.end_cursor ?? null;
      pageCount += 1;
      if (!hasNext || !next) break;
      cursor = next;
    }

    allNodes.sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));

    const userTimezone = await probeTimezone(auth.token);
    const totalSeconds = allNodes.reduce((s, e) => s + (e.duration_seconds || 0), 0);
    const value = {
      entries: allNodes,
      totalHours: totalSeconds / 3600,
      userTimezone: userTimezone || null,
      pageCount,
      truncated: pageCount >= MAX_PAGES,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { error: `Failed to fetch Rize data: ${e.message}` };
  }
}

// ── Project bucketing ──
//
// Fallback chain per the brief:
//   1. entry.project_name (the canonical Rize project, when set)
//   2. tag_suggestions[].tag_name matching any keyword in projectMapping
//   3. case-insensitive substring match on title + description against the
//      same projectMapping keywords
//   4. "Untagged"
//
// projectMapping format (from config):
//   { "DisplayName": ["KEYWORD1", "KEYWORD2", …] }
function classify(entry, projectMapping) {
  const mapping = projectMapping || {};
  if (entry.project_name) return entry.project_name;

  const tagNames = (entry.tag_suggestions || [])
    .map(t => t && t.tag_name)
    .filter(Boolean);
  for (const tagName of tagNames) {
    const projName = matchKeywords(tagName, mapping, true /* case-sensitive for tag names */);
    if (projName) return projName;
  }

  const haystack = `${entry.title || ""} ${entry.description || ""}`;
  const projName = matchKeywords(haystack, mapping, false /* case-insensitive for free text */);
  if (projName) return projName;

  return "Untagged";
}

function matchKeywords(text, mapping, caseSensitive) {
  if (!text) return null;
  const t = caseSensitive ? text : text.toLowerCase();
  for (const [projectName, keywords] of Object.entries(mapping)) {
    for (const kw of keywords || []) {
      const k = caseSensitive ? kw : (kw || "").toLowerCase();
      if (k && t.includes(k)) return projectName;
    }
  }
  return null;
}

function bucketEntries(entries, projectMapping) {
  const buckets = new Map();
  let totalSeconds = 0;
  for (const e of (entries || [])) {
    const projName = classify(e, projectMapping);
    const secs = e.duration_seconds || 0;
    totalSeconds += secs;
    if (!buckets.has(projName)) {
      buckets.set(projName, { name: projName, seconds: 0, count: 0, entries: [] });
    }
    const b = buckets.get(projName);
    b.seconds += secs;
    b.count += 1;
    b.entries.push(e);
  }
  return Array.from(buckets.values()).map(b => ({
    name: b.name,
    seconds: b.seconds,
    hours: b.seconds / 3600,
    count: b.count,
    pct: totalSeconds > 0 ? Math.round(b.seconds / totalSeconds * 100) : 0,
    entries: b.entries,
  })).sort((a, b) => b.seconds - a.seconds);
}

return { fetchWeek, bucketEntries, classify, clearCache };
