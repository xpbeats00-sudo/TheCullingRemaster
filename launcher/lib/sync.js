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
const ATTEMPTS = 3;
// Windows device names can't be file names, with or without an extension.
const DEVICE_RX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

class SyncError extends Error {}

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
async function attempt(url, f, part, onBytes) {
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* no partial download */ }
  if (have > f.size) { fs.rmSync(part, { force: true }); onBytes(-have); have = 0; }
  const res = await fetch(url, { cache: "no-store", headers: have > 0 ? { Range: `bytes=${have}-` } : {} });
  // Bytes are counted by a step inside the pipeline, never by a "data"
  // listener beside it: work done in such a listener (the launcher sends
  // progress to the window from there) could let later chunks reach the file
  // first, scrambling it.
  const count = () => new Transform({ transform(chunk, _enc, done) { onBytes(chunk.length); done(null, chunk); } });
  if (res.status === 416 && have === f.size) {
    await res.body?.cancel();                    // already complete
  } else if (res.status === 206 && have > 0) {
    await pipeline(Readable.fromWeb(res.body), count(), fs.createWriteStream(part, { flags: "a" }));
  } else if (res.ok && res.body) {
    if (have > 0) onBytes(-have);                // no range support: the file starts over
    await pipeline(Readable.fromWeb(res.body), count(), fs.createWriteStream(part));
  } else {
    await res.body?.cancel();
    throw new SyncError(`download failed for ${f.path}: HTTP ${res.status}`);
  }
}

async function download(manifest, f, gameRoot, onBytes, retryDelayMs) {
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
      await attempt(url, f, part, count);
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      if (e instanceof SyncError && /HTTP 4\d\d/.test(e.message)) break;   // not worth retrying
      if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, retryDelayMs * (i + 1)));
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

// Download every planned file. onProgress({ file, doneBytes, totalBytes }).
// opts.retryDelayMs: wait before a retry (grows per attempt).
async function apply(manifest, todo, gameRoot, onProgress = () => {}, opts = {}) {
  const totalBytes = todo.reduce((s, f) => s + f.size, 0);
  checkSpace(gameRoot, totalBytes);
  let doneBytes = 0;
  fs.mkdirSync(gameRoot, { recursive: true });
  const state = loadState(gameRoot);
  for (const f of todo) {
    onProgress({ file: f.path, doneBytes, totalBytes });
    state[f.path] = await download(manifest, f, gameRoot, (n) => {
      doneBytes += n;
      onProgress({ file: f.path, doneBytes, totalBytes });
    }, opts.retryDelayMs == null ? 2000 : opts.retryDelayMs);
    saveState(gameRoot, state);
  }
  state.version = manifest.version;
  saveState(gameRoot, state);
  return { files: todo.length, bytes: totalBytes };
}

function installedVersion(gameRoot) {
  return loadState(gameRoot).version || null;
}

module.exports = { fetchManifest, validateManifest, plan, apply, targetPath, checkUrl, sha256File, installedVersion,
  freeBytes, checkSpace, SyncError, STATE_DIR };
