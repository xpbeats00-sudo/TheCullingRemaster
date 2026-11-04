// Game Sync: install, update and repair a game folder from a signed release
// manifest.
//
// manifest.json (made by tools/make_manifest.js, signed: manifest.json.sig):
//   { "version": "1.0.0", "files": [{ "path": "Victory/Content/Paks/x.pak",
//     "size": 123, "sha256": "...", "url": "files/x.pak" }], "servers": [...] }
//
// A release can be the whole game (Engine/, Victory/, the root files) or just
// the Remaster's files. Only missing or changed files download: a file whose
// size and SHA-256 match is reused, and a state file remembers what was
// verified (size + mtime + hash) so a start-up check doesn't rehash gigabytes;
// Repair rehashes everything.
//
// Updates are staged and committed:
//   1. downloads go to <game>/.remaster/staging/<path> (".part" while
//      incomplete, resumed with HTTP Range + If-Range), each verified by size
//      and SHA-256 as it completes;
//   2. once every file is staged, a journal is written and the files are moved
//      into place, the files they replace (and launcher-managed files the new
//      release no longer has) going to <game>/.remaster/backup/;
//   3. the release is marked installed only when the commit finishes. A crash
//      mid-commit is finished from the journal on the next start; a locked
//      file (the game running) rolls the commit back, keeping the downloads.
// The previous version's replaced files stay in backup/ until the next update,
// so it can be restored (rollback()).
//
// The manifest comes from the network, so it is trusted only after its
// signature verifies, every path must stay inside the game folder (never the
// launcher's own state folder) and every URL must be https (http only for
// localhost, for testing).

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const RELEASE_KEY = require("./releasekey");

const STATE_DIR = ".remaster";
const STATE_FILE = "sync-state.json";
const JOURNAL_FILE = "journal.json";
const LAST_COMMIT_FILE = "last-commit.json";
// Tries per file; between them the wait doubles (1, 2, 4, 8, 16 s by default,
// each with +-25% jitter so many players don't retry in step).
const ATTEMPTS = 6;
const TOTAL_TRIES = 40;
// Files downloaded at once: one connection already fills a typical line on a
// big file, but most of the game is thousands of tiny files, each costing a
// full round trip when fetched one at a time (measured against the VPS: the
// 3,517 files under 1 MB took 54 s 8 at a time and 28 s 16 at a time, about
// 7 min one by one; a big file runs at full line speed either way). When
// connections stall or fail, fewer run at once until things recover.
const PARALLEL = 16;
const MIN_PARALLEL = 2;
const RECOVER_MS = 20000;            // a slot comes back after this long without trouble
// A connection that delivers nothing for this long is dropped and resumed.
const STALL_MS = 30000;
// Progress (sync-state.json) is written at most this often while downloading.
const SAVE_EVERY_MS = 2000;
// Resume metadata (.part.json: hash + ETag) is kept only for files this big;
// smaller ones simply start over.
const META_MIN = 1 << 20;
// Kept free beyond what an update needs (logs, the file system's own needs).
const SPACE_MARGIN = 512 * 1024 * 1024;
// Windows device names can't be file names, with or without an extension.
const DEVICE_RX = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(\..*)?$/i;
// File errors that retrying can't fix.
const DISK_CODES = new Set(["ENOSPC", "EROFS", "EACCES", "EPERM", "EDQUOT"]);

let fetchImpl = (url, init) => fetch(url, init);
// The launcher passes Electron's net.fetch, which uses the system proxy and
// the Windows certificate store (antivirus HTTPS scanning installs its own).
function useFetch(fn) { fetchImpl = fn; }

class SyncError extends Error {
  constructor(message, kind = "error") { super(message); this.kind = kind; }
}
// apply() was paused (its signal aborted): finished files, and every partial
// one, are kept for the next run to continue from.
class SyncPaused extends SyncError {
  constructor() { super("Game Sync paused", "paused"); this.paused = true; }
}

function checkUrl(u) {
  const url = new URL(u);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SyncError("refusing non-https URL " + url.href);
  }
  return url;
}

// The absolute target for a manifest path, or an error if it isn't a plain
// relative path inside the game folder. Windows drops trailing dots and spaces
// from names (so "a." is "a"), which would let two entries name one file.
function targetPath(gameRoot, rel) {
  const parts = typeof rel === "string" ? rel.split("/") : [];
  if (!rel || rel.includes("\\") || rel.includes(":") || path.posix.isAbsolute(rel) ||
      parts.some((p) => p === ".." || p === "." || p === "" || DEVICE_RX.test(p) || /[<>"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /~\d/.test(p)) ||
      parts[0].toLowerCase() === STATE_DIR) {
    throw new SyncError("unsafe path in manifest: " + JSON.stringify(rel));
  }
  const root = path.resolve(gameRoot);
  const full = path.resolve(root, ...parts);
  if (!full.startsWith(root + path.sep)) throw new SyncError("path escapes the game folder: " + rel);
  return full;
}

const stateDir = (gameRoot) => path.join(gameRoot, STATE_DIR);
// Where a file is staged; its path was checked by targetPath first.
const stagedPath = (gameRoot, rel) => path.join(stateDir(gameRoot), "staging", ...rel.split("/"));
const backupPath = (gameRoot, rel) => path.join(stateDir(gameRoot), "backup", ...rel.split("/"));

function validateManifest(m) {
  if (!m || typeof m !== "object" || !Array.isArray(m.files) || typeof m.version !== "string") {
    throw new SyncError("manifest is missing version or files");
  }
  if (m.servers !== undefined) {
    if (!Array.isArray(m.servers)) throw new SyncError("manifest servers must be a list");
    for (const sv of m.servers) {
      if (!sv || typeof sv.id !== "string" || typeof sv.name !== "string" || typeof sv.api !== "string") {
        throw new SyncError("bad server entry in manifest");
      }
      checkUrl(sv.api);
      if (sv.status !== undefined) checkUrl(sv.status);
    }
  }
  // The current launcher (lib/selfupdate.js checks it in full).
  if (m.launcher !== undefined && (!m.launcher || typeof m.launcher.version !== "string" || typeof m.launcher.url !== "string")) {
    throw new SyncError("bad launcher entry in manifest");
  }
  const seen = new Set();
  for (const f of m.files) {
    if (!f || !/^[0-9a-f]{64}$/.test(f.sha256 || "") || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.url !== "string") {
      throw new SyncError("bad manifest entry for " + JSON.stringify(f && f.path));
    }
    targetPath("C:\\check", f.path);
    // Windows paths don't distinguish case: two entries for one file are refused.
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new SyncError("manifest lists a file twice: " + f.path);
    seen.add(key);
  }
  return m;
}

// The manifest and its Ed25519 signature (manifest.json.sig, base64). Nothing
// in a manifest is trusted until the signature verifies against the release
// key built into the launcher, so a tampered server can't push files.
// A publish replaces manifest.json and its .sig one after the other, so a
// mismatch is tried once more before the release is refused.
async function fetchManifest(manifestUrl, publicKey = RELEASE_KEY, retryMs = 1500) {
  const url = checkUrl(manifestUrl);
  const get = async (u) => {
    // Generous: the manifest of a whole-game release is about 1 MB.
    const res = await fetchImpl(u.href, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new SyncError(`${u.pathname.split("/").pop()} request failed: HTTP ${res.status}`, "http");
    return Buffer.from(await res.arrayBuffer());
  };
  let body = null;
  let ok = false;
  for (let i = 0; i < 2 && !ok; i++) {
    if (i) await sleep(retryMs);
    body = await get(url);
    const sig = Buffer.from((await get(new URL(url.href + ".sig"))).toString("utf8").trim(), "base64");
    try { ok = crypto.verify(null, body, publicKey, sig); } catch { ok = false; }
  }
  if (!ok) throw new SyncError("the release's signature doesn't match: refusing it", "signature");
  let parsed;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { throw new SyncError("manifest isn't valid JSON"); }
  const m = validateManifest(parsed);
  m.baseUrl = url.href;
  return m;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

// ---------------------------------------------------------------- state
// { format: 2, version, previous, files: { path: record }, staged: { path: record } }
// record: { size, mtimeMs, sha256 } of a verified file. The first launchers
// kept records and "version" side by side at the top level; those load too.
function loadState(gameRoot) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(path.join(stateDir(gameRoot), STATE_FILE), "utf8")); } catch { /* none yet */ }
  if (s.format === 2) return Object.assign({ version: null, previous: null, files: {}, staged: {} }, s);
  const files = {};
  for (const [k, v] of Object.entries(s)) if (k !== "version" && v && typeof v === "object") files[k] = v;
  return { format: 2, version: s.version || null, previous: null, files, staged: {} };
}

// Written to a temporary file, flushed and swapped in, so a crash leaves the
// old state or the new one, never half of one.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

const saveState = (gameRoot, state) => writeJson(path.join(stateDir(gameRoot), STATE_FILE), state);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// A file on disk still matches its verified record.
function fresh(stat, record, sha256) {
  return !!stat && !!record && record.size === stat.size && record.mtimeMs === stat.mtimeMs && record.sha256 === sha256;
}

const recordOf = (file, sha256) => { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs, sha256 }; };
const statOrNull = (file) => { try { return fs.statSync(file); } catch { return null; } };

// ---------------------------------------------------------------- disk
// Free bytes on the drive that holds (or will hold) gameRoot.
function freeBytes(gameRoot) {
  let dir = path.resolve(gameRoot);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

// Throws when the drive can't take `bytes` more (plus a margin).
function checkSpace(gameRoot, bytes) {
  const free = freeBytes(gameRoot);
  const need = bytes + SPACE_MARGIN;
  if (bytes > 0 && free < need) {
    const gb = (n) => (n / 1073741824).toFixed(2) + " GB";
    throw new SyncError(`not enough disk space: ${gb(need)} needed, ${gb(free)} free`, "disk");
  }
  return free;
}

// The game folder must be writable before anything downloads.
function checkWritable(gameRoot) {
  const probe = path.join(stateDir(gameRoot), "write-test.tmp");
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch (e) {
    throw new SyncError(`can't write to the game folder (${e.code || e.message}): choose another folder in Settings`, "disk");
  }
}

// Moves a file, creating the destination folder; replaces an existing one.
function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 4 || !["EBUSY", "EPERM", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1));
    }
  }
}

// ---------------------------------------------------------------- planning
// Which manifest files aren't installed as they should be. Each entry is the
// manifest entry plus `staged: true` when it is already downloaded and
// verified in staging (it only needs committing). onProgress(done, total)
// while checking. opts.full (Repair) rehashes every file instead of trusting
// the verified records. The result carries `report`: counts of ok, missing,
// changed (size or hash differ) and staged files.
async function plan(manifest, gameRoot, onProgress = () => {}, opts = {}) {
  recover(gameRoot);
  const state = loadState(gameRoot);
  const todo = [];
  const report = { ok: 0, missing: 0, changed: 0, staged: 0 };
  let n = 0;
  for (const f of manifest.files) {
    if (opts.signal && opts.signal.aborted) {
      if (fs.existsSync(gameRoot)) saveState(gameRoot, state);
      throw new SyncPaused();
    }
    const target = targetPath(gameRoot, f.path);
    const stat = statOrNull(target);
    let ok = false;
    if (stat && stat.isFile() && stat.size === f.size) {
      if (!opts.full && fresh(stat, state.files[f.path], f.sha256)) ok = true;
      else if (await sha256File(target) === f.sha256) { state.files[f.path] = recordOf(target, f.sha256); ok = true; }
    }
    if (ok) {
      report.ok++;
      // The first launchers downloaded next to the target: a leftover .part
      // beside a verified file is theirs.
      if (statOrNull(target + ".part")) fs.rmSync(target + ".part", { force: true });
    } else {
      delete state.files[f.path];
      if (stat) report.changed++; else report.missing++;
      const staged = stagedPath(gameRoot, f.path);
      const sstat = statOrNull(staged);
      let isStaged = fresh(sstat, state.staged[f.path], f.sha256);
      if (!isStaged && sstat && sstat.size === f.size && await sha256File(staged) === f.sha256) {
        state.staged[f.path] = recordOf(staged, f.sha256);
        isStaged = true;
      }
      if (!isStaged) delete state.staged[f.path];
      else report.staged++;
      todo.push(Object.assign({}, f, { staged: isStaged }));
    }
    onProgress(++n, manifest.files.length);
  }
  // A fresh install's folder isn't created just by looking at it.
  if (fs.existsSync(gameRoot)) saveState(gameRoot, state);
  Object.defineProperty(todo, "report", { value: report, enumerable: false });
  return todo;
}

// Bytes of planned files already on disk: staged ones in full, partial
// downloads up to their expected size.
function partialBytes(todo, gameRoot) {
  let n = 0;
  for (const f of todo) {
    if (f.staged) { n += f.size; continue; }
    const st = statOrNull(stagedPath(gameRoot, f.path) + ".part");
    if (st) n += Math.min(st.size, f.size);
  }
  return n;
}

// ---------------------------------------------------------------- download
// A shared bandwidth cap: take(n) resolves once n bytes may pass.
function bandwidth(bytesPerSec) {
  if (!bytesPerSec) return { take: async () => {} };
  let tokens = bytesPerSec;
  let at = Date.now();
  let chain = Promise.resolve();
  return {
    take(n) {
      chain = chain.then(async () => {
        for (;;) {
          const now = Date.now();
          tokens = Math.min(bytesPerSec, tokens + (now - at) / 1000 * bytesPerSec);
          at = now;
          if (tokens >= n || tokens >= bytesPerSec) { tokens -= n; return; }
          await new Promise((r) => setTimeout(r, Math.ceil((n - tokens) / bytesPerSec * 1000)));
        }
      });
      return chain;
    }
  };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener("abort", done); resolve(); }
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

// What went wrong, as one of: stall, network, http, range, disk, verify.
function classify(e) {
  if (e instanceof SyncError) return e.kind;
  if (DISK_CODES.has(e && e.code)) return "disk";
  return "network";
}

// One attempt at a file: resumes from its .part when the server allows it.
// onBytes(n) reports bytes written (negative when partial data is dropped).
// Stops when `signal` aborts (a pause) or no data arrives for stallMs.
async function attempt(url, f, part, onBytes, o) {
  const metaFile = part + ".json";
  let have = statOrNull(part) ? statOrNull(part).size : 0;
  const meta = readJson(metaFile);
  // Partial data of another release's file (or more than the file) is dropped.
  if (have > f.size || (have > 0 && meta && meta.sha256 !== f.sha256)) {
    fs.rmSync(part, { force: true });
    onBytes(-Math.min(have, f.size));
    have = 0;
  }
  if (o.signal && o.signal.aborted) throw new SyncPaused();
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  if (o.signal) o.signal.addEventListener("abort", stop, { once: true });
  let stalled = false;
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ctl.abort(); }, o.stallMs); };
  const headers = {};
  if (have > 0) {
    headers.Range = `bytes=${have}-`;
    // The server sends the rest only if the file is still the one we started.
    if (meta && meta.etag) headers["If-Range"] = meta.etag;
  }
  try {
    arm();
    const res = await fetchImpl(url, { cache: "no-store", redirect: "error", headers, signal: ctl.signal });
    // Bytes are counted by a step inside the pipeline, never by a "data"
    // listener beside it: work done in such a listener (the launcher sends
    // progress to the window from there) could let later chunks reach the file
    // first, scrambling it. Each chunk re-arms the stall timer, and waits its
    // turn under the bandwidth cap.
    const count = () => new Transform({
      transform(chunk, _enc, done) {
        arm();
        o.limit.take(chunk.length).then(() => { arm(); onBytes(chunk.length); done(null, chunk); }, done);
      }
    });
    const remember = () => {
      if (f.size >= META_MIN) writeJson(metaFile, { sha256: f.sha256, etag: res.headers.get("etag") || null });
    };
    if (res.status === 416) {
      await res.body?.cancel();
      if (have === f.size) return;               // already complete
      fs.rmSync(part, { force: true });
      onBytes(-have);
      throw new SyncError(`${f.path}: the server refused the resume point (416); starting over`, "range");
    } else if (res.status === 206) {
      // Only the bytes asked for, of a file of the expected size, are appended.
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") || "");
      if (!m || Number(m[1]) !== have || Number(m[2]) !== f.size - 1 || Number(m[3]) !== f.size) {
        await res.body?.cancel();
        fs.rmSync(part, { force: true });
        onBytes(-have);
        throw new SyncError(`${f.path}: unexpected Content-Range "${res.headers.get("content-range")}"; starting over`, "range");
      }
      remember();
      await pipeline(Readable.fromWeb(res.body), count(), fs.createWriteStream(part, { flags: "a" }));
    } else if (res.ok && res.body) {
      // A whole file (no range support, or it changed): the partial data goes.
      if (have > 0) onBytes(-have);
      remember();
      await pipeline(Readable.fromWeb(res.body), count(), fs.createWriteStream(part));
    } else {
      await res.body?.cancel();
      throw Object.assign(new SyncError(`download failed for ${f.path}: HTTP ${res.status}`, "http"), { status: res.status });
    }
  } catch (e) {
    if (o.signal && o.signal.aborted) throw new SyncPaused();
    if (stalled) throw new SyncError(`${f.path}: no data for ${Math.round(o.stallMs / 1000)} s`, "stall");
    throw e;
  } finally {
    clearTimeout(timer);
    if (o.signal) o.signal.removeEventListener("abort", stop);
  }
}

const retryable = (e) => {
  const kind = classify(e);
  if (kind === "disk") return false;
  if (kind === "http") return e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500;
  return true;
};

// Downloads one file into staging and verifies it. o: signal, stallMs,
// retryDelayMs (first wait), limit, onRetry(kind).
async function download(manifest, f, gameRoot, onBytes, o) {
  targetPath(gameRoot, f.path);
  const url = checkUrl(new URL(f.url, manifest.baseUrl).href);
  const staged = stagedPath(gameRoot, f.path);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  const part = staged + ".part";
  let counted = 0;                               // bytes of this file reported so far
  const count = (n) => { counted += n; onBytes(n); };
  // A .part left by an earlier run counts as already downloaded.
  const st = statOrNull(part);
  if (st) count(Math.min(st.size, f.size));
  // Tries count only failures without progress: a long download over a flaky
  // line that keeps moving forward isn't given up on (TOTAL_TRIES bounds it).
  let lastError = null;
  let fails = 0;
  for (let total = 0; total < TOTAL_TRIES; total++) {
    const before = counted;
    try {
      await attempt(url, f, part, count, o);
      // Only a complete file with the signed hash is kept; anything else
      // (a stale .part, corruption) starts over within the same budget.
      const size = statOrNull(part) ? statOrNull(part).size : -1;
      const digest = size === f.size ? await sha256File(part) : null;
      if (digest === f.sha256) { lastError = null; break; }
      fs.rmSync(part, { force: true });
      fs.rmSync(part + ".json", { force: true });
      count(-counted);
      throw new SyncError(`${f.path} failed verification (got ${size} bytes${digest ? ", " + digest.slice(0, 12) + "..." : ""})`, "verify");
    } catch (e) {
      if (e instanceof SyncPaused) throw e;      // the .part stays for the resume
      lastError = e;
      if (!retryable(e)) break;
      fails = counted > before && e.kind !== "verify" ? 0 : fails + 1;
      if (fails >= ATTEMPTS) break;
      o.onRetry(classify(e), e, fails);
      await sleep(o.retryDelayMs * 2 ** Math.max(0, fails - 1) * (0.75 + Math.random() * 0.5), o.signal);
      if (o.signal && o.signal.aborted) throw new SyncPaused();
    }
  }
  if (lastError) { onBytes(-counted); throw lastError; }
  move(part, staged);
  fs.rmSync(part + ".json", { force: true });
  return recordOf(staged, f.sha256);
}

// ---------------------------------------------------------------- commit
// Moves every staged file of the journal into place. Idempotent: after a
// crash, running it again finishes the job. For each file, in order: the
// current file goes to backup (once), then the staged one takes its place.
function commitFiles(gameRoot, journal) {
  for (const e of journal.files) {
    const target = targetPath(gameRoot, e.path);
    const staged = stagedPath(gameRoot, e.path);
    const backup = backupPath(gameRoot, e.path);
    if (!fs.existsSync(staged)) continue;                       // already in place
    if (fs.existsSync(target) && !fs.existsSync(backup)) move(target, backup);
    move(staged, target);
    fs.rmSync(target + ".part", { force: true });                // left by the first launchers
  }
  for (const rel of journal.obsolete) {
    const target = targetPath(gameRoot, rel);
    if (fs.existsSync(target)) move(target, backupPath(gameRoot, rel));
  }
}

// Undoes commitFiles for the files already moved (a failed commit): the new
// file goes back to staging, the backup back into place.
function uncommitFiles(gameRoot, journal) {
  for (const e of journal.files) {
    const target = targetPath(gameRoot, e.path);
    const staged = stagedPath(gameRoot, e.path);
    const backup = backupPath(gameRoot, e.path);
    if (!fs.existsSync(staged) && fs.existsSync(target)) move(target, staged);
    if (fs.existsSync(backup) && !fs.existsSync(target)) move(backup, target);
  }
  for (const rel of journal.obsolete) {
    const backup = backupPath(gameRoot, rel);
    if (fs.existsSync(backup) && !fs.existsSync(targetPath(gameRoot, rel))) move(backup, targetPath(gameRoot, rel));
  }
}

// Marks a finished commit in the state, and keeps what rollback() needs.
function finishCommit(gameRoot, state, journal) {
  for (const e of journal.files) {
    state.files[e.path] = recordOf(targetPath(gameRoot, e.path), e.sha256);
    delete state.staged[e.path];
  }
  for (const rel of journal.obsolete) delete state.files[rel];
  state.previous = journal.from;
  state.version = journal.version;
  saveState(gameRoot, state);
  writeJson(path.join(stateDir(gameRoot), LAST_COMMIT_FILE), journal);
  fs.rmSync(path.join(stateDir(gameRoot), JOURNAL_FILE), { force: true });
  removeEmptyDirs(path.join(stateDir(gameRoot), "staging"));
}

// Removes a folder tree's empty folders (left in staging after a commit);
// anything with a file in it stays.
function removeEmptyDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* in use: harmless */ }
}

// Finishes a commit a crash interrupted (start-up, and before any plan).
function recover(gameRoot) {
  const journal = readJson(path.join(stateDir(gameRoot), JOURNAL_FILE));
  if (!journal || !Array.isArray(journal.files)) return false;
  commitFiles(gameRoot, journal);
  finishCommit(gameRoot, loadState(gameRoot), journal);
  return true;
}

// Commits the staged release. Throws (with everything put back as it was, the
// downloads kept) when a file can't be replaced, e.g. the game is running.
function commit(gameRoot, manifest, todo, state, onProgress) {
  const wanted = new Set(manifest.files.map((f) => f.path));
  // Launcher-managed files the new release doesn't have. Files the launcher
  // never installed (the player's own) are never touched.
  const obsolete = Object.keys(state.files).filter((p) => !wanted.has(p)).filter((p) => {
    try { targetPath(gameRoot, p); return true; } catch { return false; }
  });
  const journal = {
    version: manifest.version,
    from: state.version,
    files: todo.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, hadOld: fs.existsSync(targetPath(gameRoot, f.path)) })),
    obsolete,
    oldRecords: Object.fromEntries(todo.concat(obsolete.map((p) => ({ path: p })))
      .filter((f) => state.files[f.path]).map((f) => [f.path, state.files[f.path]]))
  };
  // The previous update's backups make way for this one's.
  fs.rmSync(path.join(stateDir(gameRoot), "backup"), { recursive: true, force: true });
  fs.rmSync(path.join(stateDir(gameRoot), LAST_COMMIT_FILE), { force: true });
  writeJson(path.join(stateDir(gameRoot), JOURNAL_FILE), journal);
  onProgress({ phase: "install", done: 0, total: journal.files.length });
  try {
    commitFiles(gameRoot, journal);
  } catch (e) {
    uncommitFiles(gameRoot, journal);
    fs.rmSync(path.join(stateDir(gameRoot), JOURNAL_FILE), { force: true });
    const busy = e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES";
    throw new SyncError(busy
      ? `a game file is in use (${path.basename(e.path || "")}): close the game, then press Resume`
      : `installing the update failed (${e.code || e.message}); your previous files were put back`, "commit");
  }
  finishCommit(gameRoot, state, journal);
  onProgress({ phase: "install", done: journal.files.length, total: journal.files.length });
}

// Restores the version before the last update from backup/. Returns the
// restored version, or throws when there is nothing to restore.
function rollback(gameRoot) {
  recover(gameRoot);
  const last = readJson(path.join(stateDir(gameRoot), LAST_COMMIT_FILE));
  if (!last || !last.from) throw new SyncError("there is no previous version to restore");
  const state = loadState(gameRoot);
  for (const e of last.files) {
    const target = targetPath(gameRoot, e.path);
    const backup = backupPath(gameRoot, e.path);
    if (e.hadOld && !fs.existsSync(backup)) throw new SyncError("the previous version's files are no longer kept");
    fs.rmSync(target, { force: true });
    if (e.hadOld) move(backup, target);
    if (last.oldRecords[e.path]) state.files[e.path] = recordOf(target, last.oldRecords[e.path].sha256);
    else delete state.files[e.path];
  }
  for (const rel of last.obsolete) {
    const backup = backupPath(gameRoot, rel);
    if (fs.existsSync(backup)) {
      move(backup, targetPath(gameRoot, rel));
      if (last.oldRecords[rel]) state.files[rel] = recordOf(targetPath(gameRoot, rel), last.oldRecords[rel].sha256);
    }
  }
  state.version = last.from;
  state.previous = null;
  saveState(gameRoot, state);
  fs.rmSync(path.join(stateDir(gameRoot), LAST_COMMIT_FILE), { force: true });
  return last.from;
}

// The version rollback() would restore, or null.
function previousVersion(gameRoot) {
  const last = readJson(path.join(stateDir(gameRoot), LAST_COMMIT_FILE));
  return last && last.from ? last.from : null;
}

// ---------------------------------------------------------------- apply
// Downloads every planned file into staging, then commits them.
// onProgress({ phase: "download", file, doneBytes, totalBytes, active,
// filesDone, filesTotal }) and then ({ phase: "install", done, total }).
// opts: signal (abort = pause: throws SyncPaused, keeping finished and
// partial downloads), parallel, maxBytesPerSec, stallMs, retryDelayMs,
// log(event, data). A file that keeps failing doesn't stop the others; the
// sync then fails listing it, and the next run only fetches what is missing.
async function apply(manifest, todo, gameRoot, onProgress = () => {}, opts = {}) {
  const log = opts.log || (() => {});
  const totalBytes = todo.reduce((s, f) => s + f.size, 0);
  fs.mkdirSync(gameRoot, { recursive: true });
  checkWritable(gameRoot);
  recover(gameRoot);
  checkSpace(gameRoot, totalBytes - partialBytes(todo, gameRoot));
  if (opts.signal && opts.signal.aborted) throw new SyncPaused();
  const state = loadState(gameRoot);
  const stopAll = new AbortController();
  const onPause = () => stopAll.abort();
  if (opts.signal) opts.signal.addEventListener("abort", onPause, { once: true });

  const maxParallel = Math.max(1, opts.parallel || PARALLEL);
  let parallel = maxParallel;                   // lowered while connections misbehave
  let lastTrouble = 0;
  const o = {
    signal: stopAll.signal,
    stallMs: opts.stallMs || STALL_MS,
    retryDelayMs: opts.retryDelayMs == null ? 1000 : opts.retryDelayMs,
    limit: bandwidth(opts.maxBytesPerSec || 0),
    onRetry(kind, e, n) {
      retries++;
      log("retry", { file: e.message, kind, attempt: n });
      if (kind === "stall" || kind === "network") {
        lastTrouble = Date.now();
        const next = Math.max(Math.min(MIN_PARALLEL, maxParallel), Math.floor(parallel / 2));
        if (next < parallel) { parallel = next; log("parallel", { now: parallel, why: kind }); }
      }
    }
  };
  let retries = 0;
  let doneBytes = 0;
  let filesDone = 0;
  let lastSave = Date.now();
  const save = (force) => {
    if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
    try { saveState(gameRoot, state); } catch (e) { log("state", { error: e.message }); }
    lastSave = Date.now();
  };
  const queue = [];
  for (const f of todo) {
    if (f.staged) { doneBytes += f.size; filesDone++; } else queue.push(f);
  }
  const toDownload = queue.length;
  const active = new Set();
  const failed = [];
  let fatal = null;
  const report = (file) => onProgress({ phase: "download", file, doneBytes, totalBytes, active: active.size, filesDone, filesTotal: todo.length });
  const t0 = Date.now();

  async function worker() {
    while (queue.length && !stopAll.signal.aborted) {
      // Fewer at once after trouble; one more slot each RECOVER_MS without any.
      if (parallel < maxParallel && Date.now() - lastTrouble > RECOVER_MS) {
        parallel++;
        lastTrouble = Date.now();
        log("parallel", { now: parallel, why: "recovered" });
      }
      if (active.size >= parallel) { await sleep(100, stopAll.signal); continue; }
      const f = queue.shift();
      active.add(f.path);
      report(f.path);
      try {
        state.staged[f.path] = await download(manifest, f, gameRoot, (n) => { doneBytes += n; report(f.path); }, o);
        f.staged = true;
        filesDone++;
        save(false);
      } catch (e) {
        if (!(e instanceof SyncPaused)) {
          log("failed", { file: f.path, kind: classify(e), error: e.message });
          if (classify(e) === "disk") { fatal = fatal || e; stopAll.abort(); }
          else failed.push({ path: f.path, error: e.message, kind: classify(e) });
        }
      } finally {
        active.delete(f.path);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(maxParallel, queue.length)) }, worker));
  } finally {
    save(true);
    if (opts.signal) opts.signal.removeEventListener("abort", onPause);
  }
  const seconds = (Date.now() - t0) / 1000;
  log("download", { files: toDownload, seconds, retries, failed: failed.length });
  if (fatal) throw fatal;
  if (opts.signal && opts.signal.aborted) throw new SyncPaused();
  if (failed.length) {
    const e = new SyncError(`${failed.length} file(s) couldn't be downloaded (${failed[0].error}); press Resume to try them again`, failed[0].kind);
    e.failed = failed;
    throw e;
  }
  commit(gameRoot, manifest, todo, state, onProgress);
  log("commit", { version: manifest.version, files: todo.length });
  return { files: todo.length, bytes: totalBytes, seconds, retries };
}

// Compares dotted versions ("1.10.0" > "1.9.2"); non-numeric parts as text.
function compareVersions(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || "0", y = pb[i] || "0";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const c = !isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (c) return c < 0 ? -1 : 1;
  }
  return 0;
}

// Bytes downloaded towards the next install or update (staged files and
// partial downloads), read from disk alone: shown while the server can't be
// reached, when there is no manifest to plan against.
function stagedBytes(gameRoot) {
  let n = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.endsWith(".part.json")) { const st = statOrNull(p); if (st) n += st.size; }
    }
  };
  walk(path.join(stateDir(gameRoot), "staging"));
  return n;
}

function installedVersion(gameRoot) {
  return loadState(gameRoot).version || null;
}

module.exports = { fetchManifest, validateManifest, plan, apply, partialBytes, targetPath, checkUrl, sha256File, installedVersion,
  freeBytes, checkSpace, recover, rollback, previousVersion, stagedBytes, bandwidth, compareVersions, useFetch,
  SyncError, SyncPaused, STATE_DIR, PARALLEL };
