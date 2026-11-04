// Game Sync: install or update a game folder from a release manifest.
//
// manifest.json (made by tools/make_manifest.js):
//   { "version": "1.0.0", "files": [{ "path": "Victory/Content/Paks/x.pak",
//     "size": 123, "sha256": "...", "url": "files/x.pak" }], "servers": [...] }
//
// A release can be the whole game (Engine/, Victory/, the root files) or just
// the Remaster's files. A file is downloaded when it is missing or its size or
// SHA-256 differs. A small state file remembers what was verified (size +
// mtime + hash), so a start-up check doesn't rehash gigabytes each time.
// Downloads go to a ".part" file next to the target and resume from it with an
// HTTP Range request after a dropped connection (a server that ignores ranges
// starts the file over); each file gets a few attempts. A file replaces its
// target only when its size and hash match. The manifest comes from the
// network, so every path must stay inside the game folder (never the
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
const ATTEMPTS = 5;
// Files downloaded at once: one connection already fills a typical line on a
// big file, but most of the game is thousands of tiny files, each costing a
// full round trip when fetched one at a time (measured against the VPS: the
// 3,517 files under 1 MB took 54 s 8 at a time and 28 s 16 at a time, about
// 7 min one by one; a big file runs at full line speed either way).
const PARALLEL = 16;
// A connection that delivers nothing for this long is dropped and resumed.
const STALL_MS = 30000;
// Progress (sync-state.json) is written at most this often while downloading.
const SAVE_EVERY_MS = 2000;
// Windows device names can't be file names, with or without an extension.
const DEVICE_RX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

class SyncError extends Error {}
// apply() was paused (its signal aborted): finished files, and every partial
// one, are kept for the next run to continue from.
class SyncPaused extends SyncError {
  constructor() { super("Game Sync paused"); this.paused = true; }
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
// relative path inside the game folder.
function targetPath(gameRoot, rel) {
  const parts = typeof rel === "string" ? rel.split("/") : [];
  if (!rel || rel.includes("\\") || rel.includes(":") || path.posix.isAbsolute(rel) ||
      parts.some((p) => p === ".." || p === "." || p === "" || DEVICE_RX.test(p) || /[<>"|?*\x00-\x1f]/.test(p)) ||
      parts[0].toLowerCase() === STATE_DIR) {
    throw new SyncError("unsafe path in manifest: " + JSON.stringify(rel));
  }
  const root = path.resolve(gameRoot);
  const full = path.resolve(root, ...parts);
  if (!full.startsWith(root + path.sep)) throw new SyncError("path escapes the game folder: " + rel);
  return full;
}

function validateManifest(m) {
  if (!m || typeof m !== "object" || !Array.isArray(m.files) || typeof m.version !== "string") {
    throw new SyncError("manifest is missing version or files");
  }
  for (const f of m.files) {
    if (!/^[0-9a-f]{64}$/.test(f.sha256 || "") || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.url !== "string") {
      throw new SyncError("bad manifest entry for " + JSON.stringify(f.path));
    }
  }
  return m;
}

// The manifest and its Ed25519 signature (manifest.json.sig, base64). Nothing
// in a manifest is trusted until the signature verifies against the release
// key built into the launcher, so a tampered server can't push files.
async function fetchManifest(manifestUrl, publicKey = RELEASE_KEY) {
  const url = checkUrl(manifestUrl);
  const get = async (u) => {
    const res = await fetch(u, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new SyncError(`${u.pathname.split("/").pop()} request failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const body = await get(url);
  const sig = Buffer.from((await get(new URL(url.href + ".sig"))).toString("utf8").trim(), "base64");
  let ok = false;
  try { ok = crypto.verify(null, body, publicKey, sig); } catch { ok = false; }
  if (!ok) throw new SyncError("the release's signature doesn't match: refusing it");
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

function loadState(gameRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(gameRoot, STATE_DIR, STATE_FILE), "utf8")); } catch { return {}; }
}

function saveState(gameRoot, state) {
  const dir = path.join(gameRoot, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, STATE_FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, path.join(dir, STATE_FILE));
}

// Free bytes on the drive that holds (or will hold) gameRoot.
function freeBytes(gameRoot) {
  let dir = path.resolve(gameRoot);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

// Throws when the drive can't take `bytes` more (plus a little headroom).
function checkSpace(gameRoot, bytes) {
  const free = freeBytes(gameRoot);
  const need = bytes + 256 * 1024 * 1024;
  if (bytes > 0 && free < need) {
    const gb = (n) => (n / 1073741824).toFixed(1) + " GB";
    throw new SyncError(`not enough disk space: ${gb(need)} needed, ${gb(free)} free`);
  }
  return free;
}

// Which manifest files need downloading. onProgress(done, total) while hashing.
async function plan(manifest, gameRoot, onProgress = () => {}) {
  const state = loadState(gameRoot);
  const todo = [];
  let n = 0;
  for (const f of manifest.files) {
    const target = targetPath(gameRoot, f.path);
    let stat = null;
    try { stat = fs.statSync(target); } catch { /* missing */ }
    if (!stat || stat.size !== f.size) {
      todo.push(f);
    } else {
      const known = state[f.path];
      const fresh = known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.sha256 === f.sha256;
      if (!fresh) {
        const hash = await sha256File(target);
        if (hash === f.sha256) state[f.path] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash };
        else todo.push(f);
      }
    }
    onProgress(++n, manifest.files.length);
  }
  // A fresh install's folder isn't created just by looking at it.
  if (fs.existsSync(gameRoot)) saveState(gameRoot, state);
  return todo;
}

// One attempt at a file: resumes from its .part when the server allows it.
// onBytes(n) reports bytes written (negative when a partial file is dropped).
// Stops when `signal` aborts (a pause) or no data arrives for stallMs.
async function attempt(url, f, part, onBytes, signal, stallMs) {
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* no partial download */ }
  if (have > f.size) { fs.rmSync(part, { force: true }); onBytes(-have); have = 0; }
  if (signal && signal.aborted) throw new SyncPaused();
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  if (signal) signal.addEventListener("abort", stop, { once: true });
  let stalled = false;
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ctl.abort(); }, stallMs); };
  try {
    arm();
    const res = await fetch(url, { cache: "no-store", headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: ctl.signal });
    // Bytes are counted by a step inside the pipeline, never by a "data"
    // listener beside it: work done in such a listener (the launcher sends
    // progress to the window from there) could let later chunks reach the file
    // first, scrambling it. Each chunk also re-arms the stall timer.
    const count = () => new Transform({ transform(chunk, _enc, done) { arm(); onBytes(chunk.length); done(null, chunk); } });
    if (res.status === 416 && have === f.size) {
      await res.body?.cancel();                  // already complete
    } else if (res.status === 206 && have > 0) {
      await pipeline(Readable.fromWeb(res.body), count(), fs.createWriteStream(part, { flags: "a" }));
    } else if (res.ok && res.body) {
      if (have > 0) onBytes(-have);              // no range support: the file starts over
      await pipeline(Readable.fromWeb(res.body), count(), fs.createWriteStream(part));
    } else {
      await res.body?.cancel();
      throw new SyncError(`download failed for ${f.path}: HTTP ${res.status}`);
    }
  } catch (e) {
    if (signal && signal.aborted) throw new SyncPaused();
    if (stalled) throw new Error(`${f.path}: no data for ${Math.round(stallMs / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", stop);
  }
}

// opts: retryDelayMs (wait before a retry, growing per attempt), stallMs, signal.
async function download(manifest, f, gameRoot, onBytes, opts) {
  const target = targetPath(gameRoot, f.path);
  const url = checkUrl(new URL(f.url, manifest.baseUrl).href);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = target + ".part";
  let counted = 0;                               // bytes of this file reported so far
  const count = (n) => { counted += n; onBytes(n); };
  // A .part left by an earlier run counts as already downloaded.
  try { count(Math.min(fs.statSync(part).size, f.size)); } catch { /* none */ }
  let lastError = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      await attempt(url, f, part, count, opts.signal, opts.stallMs);
      lastError = null;
      break;
    } catch (e) {
      if (e instanceof SyncPaused) throw e;      // the .part stays for the resume
      lastError = e;
      if (e instanceof SyncError && /HTTP 4\d\d/.test(e.message)) break;   // not worth retrying
      if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, opts.retryDelayMs * (i + 1)));
      if (opts.signal && opts.signal.aborted) throw new SyncPaused();
    }
  }
  if (lastError) { onBytes(-counted); throw lastError; }
  const size = fs.statSync(part).size;
  const digest = size === f.size ? await sha256File(part) : null;
  if (digest !== f.sha256) {
    fs.rmSync(part, { force: true });
    onBytes(-counted);
    throw new SyncError(`${f.path} failed verification (got ${size} bytes${digest ? ", " + digest.slice(0, 12) + "..." : ""})`);
  }
  fs.rmSync(target, { force: true });
  fs.renameSync(part, target);
  const stat = fs.statSync(target);
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: f.sha256 };
}

// Download every planned file, PARALLEL at a time. onProgress({ file,
// doneBytes, totalBytes, active }). opts: signal (abort = pause: throws
// SyncPaused, keeping finished files and partial ones), parallel, stallMs,
// retryDelayMs. One file failing for good stops the others, keeping theirs too.
async function apply(manifest, todo, gameRoot, onProgress = () => {}, opts = {}) {
  const totalBytes = todo.reduce((s, f) => s + f.size, 0);
  checkSpace(gameRoot, totalBytes - partialBytes(todo, gameRoot));
  if (opts.signal && opts.signal.aborted) throw new SyncPaused();
  let doneBytes = 0;
  fs.mkdirSync(gameRoot, { recursive: true });
  const state = loadState(gameRoot);
  const stopAll = new AbortController();
  const onPause = () => stopAll.abort();
  if (opts.signal) opts.signal.addEventListener("abort", onPause, { once: true });
  const dl = {
    signal: stopAll.signal,
    stallMs: opts.stallMs || STALL_MS,
    retryDelayMs: opts.retryDelayMs == null ? 2000 : opts.retryDelayMs
  };
  let lastSave = Date.now();
  const save = (force) => {
    if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
    saveState(gameRoot, state);
    lastSave = Date.now();
  };
  const queue = todo.slice();
  const active = new Set();
  let failure = null;
  const report = (file) => onProgress({ file, doneBytes, totalBytes, active: active.size });
  async function worker() {
    while (queue.length && !stopAll.signal.aborted) {
      const f = queue.shift();
      active.add(f.path);
      report(f.path);
      try {
        state[f.path] = await download(manifest, f, gameRoot, (n) => { doneBytes += n; report(f.path); }, dl);
        save(false);
      } catch (e) {
        if (!failure && !(e instanceof SyncPaused)) failure = e;
        stopAll.abort();
      } finally {
        active.delete(f.path);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel || PARALLEL, queue.length)) }, worker));
  } finally {
    save(true);
    if (opts.signal) opts.signal.removeEventListener("abort", onPause);
  }
  if (failure) throw failure;
  if (opts.signal && opts.signal.aborted) throw new SyncPaused();
  state.version = manifest.version;
  saveState(gameRoot, state);
  return { files: todo.length, bytes: totalBytes };
}

// Bytes of planned files already downloaded in part (.part files).
function partialBytes(todo, gameRoot) {
  let n = 0;
  for (const f of todo) {
    try { n += Math.min(fs.statSync(targetPath(gameRoot, f.path) + ".part").size, f.size); } catch { /* none */ }
  }
  return n;
}

function installedVersion(gameRoot) {
  return loadState(gameRoot).version || null;
}

module.exports = { fetchManifest, validateManifest, plan, apply, partialBytes, targetPath, checkUrl, sha256File, installedVersion,
  freeBytes, checkSpace, SyncError, SyncPaused, STATE_DIR, PARALLEL };
