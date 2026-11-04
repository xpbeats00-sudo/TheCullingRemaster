// Game Sync: bring a game install up to date with a release manifest.
//
// manifest.json (made by tools/make_manifest.js):
//   { "version": "1.0.0", "files": [{ "path": "Victory/Content/Paks/x.pak",
//     "size": 123, "sha256": "...", "url": "files/x.pak" }], "servers": [...] }
//
// A file is downloaded when it is missing or its size or SHA-256 differs. A
// small state file remembers what was verified (size + mtime + hash), so a
// start-up check doesn't rehash hundreds of MB each time. Downloads go to a
// ".part" file next to the target, are hashed while streaming, and replace
// the target only when size and hash match. The manifest comes from the
// network, so every path must stay inside the game's Victory folder and every
// URL must be https (http only for localhost, for testing).

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const STATE_DIR = ".remaster";
const STATE_FILE = "sync-state.json";
const ALLOWED_ROOT = "Victory/";

class SyncError extends Error {}

function checkUrl(u) {
  const url = new URL(u);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SyncError("refusing non-https URL " + url.href);
  }
  return url;
}

// The absolute target for a manifest path, or an error if it leaves the
// game's Victory folder.
function targetPath(gameRoot, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\\") || path.posix.isAbsolute(rel) ||
      rel.split("/").some((p) => p === ".." || p === "." || p === "") || !rel.startsWith(ALLOWED_ROOT)) {
    throw new SyncError("unsafe path in manifest: " + JSON.stringify(rel));
  }
  const root = path.resolve(gameRoot);
  const full = path.resolve(root, ...rel.split("/"));
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

async function fetchManifest(manifestUrl) {
  const url = checkUrl(manifestUrl);
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new SyncError(`manifest request failed: HTTP ${res.status}`);
  const m = validateManifest(await res.json());
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
  saveState(gameRoot, state);
  return todo;
}

async function download(manifest, f, gameRoot, onBytes) {
  const target = targetPath(gameRoot, f.path);
  const url = checkUrl(new URL(f.url, manifest.baseUrl).href);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = target + ".part";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok || !res.body) throw new SyncError(`download failed for ${f.path}: HTTP ${res.status}`);
  const hash = crypto.createHash("sha256");
  let size = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => { hash.update(chunk); size += chunk.length; onBytes(chunk.length); });
  try {
    await pipeline(body, fs.createWriteStream(part));
    const digest = hash.digest("hex");
    if (size !== f.size || digest !== f.sha256) {
      throw new SyncError(`${f.path} failed verification (got ${size} bytes, ${digest.slice(0, 12)}...)`);
    }
    fs.renameSync(part, target);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  const stat = fs.statSync(target);
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: f.sha256 };
}

// Download every planned file. onProgress({ file, doneBytes, totalBytes }).
async function apply(manifest, todo, gameRoot, onProgress = () => {}) {
  const totalBytes = todo.reduce((s, f) => s + f.size, 0);
  let doneBytes = 0;
  const state = loadState(gameRoot);
  for (const f of todo) {
    onProgress({ file: f.path, doneBytes, totalBytes });
    state[f.path] = await download(manifest, f, gameRoot, (n) => {
      doneBytes += n;
      onProgress({ file: f.path, doneBytes, totalBytes });
    });
    saveState(gameRoot, state);
  }
  state.version = manifest.version;
  saveState(gameRoot, state);
  return { files: todo.length, bytes: totalBytes };
}

function installedVersion(gameRoot) {
  return loadState(gameRoot).version || null;
}

module.exports = { fetchManifest, validateManifest, plan, apply, targetPath, checkUrl, sha256File, installedVersion, SyncError };
