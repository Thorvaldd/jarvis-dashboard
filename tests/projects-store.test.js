// Standalone test harness for src/services/projects-store.js
// Run: node tests/projects-store.test.js
// The store is a dataviewjs-style module: it destructures ctx and returns an
// object. We load it the same way the dashboard does — via new Function — but
// inject real fs/path from Node and a sandbox tmp dir.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const TMP = path.resolve(__dirname, ".tmp");
const STORE_SRC = path.resolve(__dirname, "../src/services/projects-store.js");

function makeCtx({ configDir }) {
  return {
    nodeFs: fs,
    nodePath: path,
    config: { projects: { rootPath: "/fake/root" } },
    _configDir: configDir,
  };
}

function loadStore(ctx) {
  const code = fs.readFileSync(STORE_SRC, "utf8");
  return new Function("ctx", code)(ctx);
}

function freshSandbox(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function bootstrapStore(name) {
  const dir = freshSandbox(name);
  const ctx = makeCtx({ configDir: dir });
  return { dir, store: loadStore(ctx) };
}

function runTest(name, fn) {
  try {
    fn();
    console.log("PASS  " + name);
  } catch (e) {
    console.error("FAIL  " + name);
    console.error(e.stack || e.message);
    process.exitCode = 1;
  }
}

// ── 1. write() creates config.local.json when missing ──
runTest("write creates config.local.json when missing", () => {
  const { dir, store } = bootstrapStore("t1");
  const arr = [{ dir: "-Users-foo", label: "Foo" }];
  store.write(arr);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "config.local.json"), "utf8"));
  assert.deepStrictEqual(written.projects.tracked, arr);
});

// ── 2. write() preserves unrelated keys ──
runTest("write preserves unrelated keys in config.local.json", () => {
  const { dir, store } = bootstrapStore("t2");
  fs.writeFileSync(path.join(dir, "config.local.json"), JSON.stringify({
    network: { token: "abc" },
    projects: { tracked: [{ dir: "-old", label: "Old" }] },
  }, null, 2));
  store.write([{ dir: "-new", label: "New" }]);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "config.local.json"), "utf8"));
  assert.strictEqual(written.network.token, "abc");
  assert.deepStrictEqual(written.projects.tracked, [{ dir: "-new", label: "New" }]);
});

// ── 3. write() is atomic (uses tmp + rename) ──
runTest("write uses tmp file then rename", () => {
  const { dir, store } = bootstrapStore("t3");
  store.write([{ dir: "-x", label: "X" }]);
  // After write, no .tmp file should be left behind
  const tmpExists = fs.existsSync(path.join(dir, "config.local.json.tmp"));
  assert.strictEqual(tmpExists, false);
  const real = JSON.parse(fs.readFileSync(path.join(dir, "config.local.json"), "utf8"));
  assert.deepStrictEqual(real.projects.tracked, [{ dir: "-x", label: "X" }]);
});

// ── 4. addProject appends to current tracked ──
runTest("addProject appends to provided tracked array", () => {
  const { dir, store } = bootstrapStore("t4");
  const current = [{ dir: "-a", label: "A" }];
  const next = store.addProject(current, { dir: "-b", label: "B" });
  assert.deepStrictEqual(next, [
    { dir: "-a", label: "A" },
    { dir: "-b", label: "B" },
  ]);
  // And it persisted
  const written = JSON.parse(fs.readFileSync(path.join(dir, "config.local.json"), "utf8"));
  assert.deepStrictEqual(written.projects.tracked, next);
});

// ── 5. addProject is a no-op when dir already tracked ──
runTest("addProject ignores duplicate dir", () => {
  const { dir, store } = bootstrapStore("t5");
  const current = [{ dir: "-a", label: "A" }];
  const next = store.addProject(current, { dir: "-a", label: "Different" });
  assert.deepStrictEqual(next, current);
  // No-op should not have created the config file
  assert.strictEqual(fs.existsSync(path.join(dir, "config.local.json")), false);
});

// ── 6. updateProject patches by index ──
runTest("updateProject patches the entry at index", () => {
  const { store } = bootstrapStore("t6");
  const current = [
    { dir: "-a", label: "A" },
    { dir: "-b", label: "B" },
  ];
  const next = store.updateProject(current, 1, { label: "Beta", color: "#ff0" });
  assert.deepStrictEqual(next, [
    { dir: "-a", label: "A" },
    { dir: "-b", label: "Beta", color: "#ff0" },
  ]);
});

// ── 7. removeProject splices out the index ──
runTest("removeProject splices out the entry at index", () => {
  const { store } = bootstrapStore("t7");
  const current = [
    { dir: "-a", label: "A" },
    { dir: "-b", label: "B" },
    { dir: "-c", label: "C" },
  ];
  const next = store.removeProject(current, 1);
  assert.deepStrictEqual(next, [
    { dir: "-a", label: "A" },
    { dir: "-c", label: "C" },
  ]);
});

// ── 8. encodePath converts /Users/foo/bar → -Users-foo-bar ──
runTest("encodePath produces dash-encoded form", () => {
  const { store } = bootstrapStore("t8");
  assert.strictEqual(store.encodePath("/Users/foo/bar"), "-Users-foo-bar");
  assert.strictEqual(store.encodePath("/a/b"), "-a-b");
});

// ── 9. decodeLabel derives the last segment ──
runTest("decodeLabel returns last segment of dash-encoded dir", () => {
  const { store } = bootstrapStore("t9");
  // The encoding is lossy: encodePath replaces every "/" with "-", so
  // hyphens in original folder names are unrecoverable. decodeLabel
  // takes the last "-"-separated token as a best-effort label.
  assert.strictEqual(store.decodeLabel("-Users-foo-bar"), "bar");
  assert.strictEqual(store.decodeLabel("-foo"), "foo");
  assert.strictEqual(store.decodeLabel("-tmp-myrepo"), "myrepo");
});

// ── 10. scanAvailable lists dirs minus already-tracked ──
runTest("scanAvailable returns untracked dirs from rootPath", () => {
  const { dir, store } = bootstrapStore("t10");
  const root = path.join(dir, "claude-projects");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "-Users-a"));
  fs.mkdirSync(path.join(root, "-Users-b"));
  fs.mkdirSync(path.join(root, "-Users-c"));
  fs.writeFileSync(path.join(root, "not-a-project"), "x"); // no leading dash, ignored
  const available = store.scanAvailable(root, ["-Users-b"]);
  const dirs = available.map(p => p.dir).sort();
  assert.deepStrictEqual(dirs, ["-Users-a", "-Users-c"]);
});

console.log("\nDone.");
