// The launcher updating itself.
//
// A release's signed manifest names the current launcher:
//   "launcher": { "version": "1.3.0", "size": <bytes>, "sha256": <hex>, "url": "objects/<sha256>" }
// (tools/make_manifest.js --setup adds it; the setup is published as one more
// object next to the game files). A launcher older than that downloads the
// setup, checks its size and SHA-256 against the signed manifest, runs it
// silently and quits; the setup installs over this launcher, in the same
// folder, and starts the new one. Nothing unsigned ever runs: the manifest's
// signature is checked before any of this (lib/sync.js fetchManifest).
//
// A setup that doesn't actually update the launcher (a mislabelled build)
// would offer itself again on every start; after two tries at one version the
// launcher stops and only reports it.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const sync = require("./sync");

const MAX_TRIES = 2;
const STALL_MS = 30000;

function validate(l) {
  if (!l || typeof l !== "object" || typeof l.version !== "string" || !/^\d+(\.\d+){1,3}$/.test(l.version) ||
      !Number.isSafeInteger(l.size) || l.size <= 0 || !/^[0-9a-f]{64}$/.test(l.sha256 || "") || typeof l.url !== "string") {
    throw new sync.SyncError("bad launcher entry in manifest");
  }
  return l;
}

// The newer launcher the manifest offers, or null.
function offered(manifest, current) {
  if (!manifest || manifest.launcher === undefined) return null;
  const l = validate(manifest.launcher);
  return sync.compareVersions(l.version, current) > 0 ? l : null;
}

const attemptsFile = (dir) => path.join(dir, "attempts.json");
function attempts(dir) {
  try { return JSON.parse(fs.readFileSync(attemptsFile(dir), "utf8")) || {}; } catch { return {}; }
}

// Whether this version may still be tried (see the top).
function mayTry(dir, version) {
  return (attempts(dir)[version] || 0) < MAX_TRIES;
}

function recordTry(dir, version) {
  const a = attempts(dir);
  a[version] = (a[version] || 0) + 1;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(attemptsFile(dir), JSON.stringify(a));
}

// Up to date: downloaded setups and the try counts are no longer needed.
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function hashFile(file) {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

// Downloads the offered setup into `dir` and returns its path once its size
// and SHA-256 match the manifest. A setup already there and intact is reused.
async function download(manifest, dir, { fetchImpl, onProgress = () => {}, stallMs = STALL_MS } = {}) {
  const l = validate(manifest.launcher);
  const url = sync.checkUrl(new URL(l.url, manifest.baseUrl).href);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `TheCullingRemasterSetup-${l.version}.exe`);
  try {
    if (fs.statSync(file).size === l.size && await hashFile(file) === l.sha256) { onProgress(l.size, l.size); return file; }
  } catch { /* not downloaded yet */ }

  const part = file + ".part";
  const abort = new AbortController();
  let stall = setTimeout(() => abort.abort(), stallMs);
  const out = fs.createWriteStream(part);
  const h = crypto.createHash("sha256");
  let done = 0;
  try {
    const res = await fetchImpl(url.href, { cache: "no-store", redirect: "error", signal: abort.signal });
    if (!res.ok || !res.body) throw new sync.SyncError(`launcher update request failed: HTTP ${res.status}`, "http");
    for await (const chunk of res.body) {
      clearTimeout(stall);
      stall = setTimeout(() => abort.abort(), stallMs);
      const buf = Buffer.from(chunk);
      done += buf.length;
      if (done > l.size) throw new sync.SyncError("the launcher update is larger than the release says: refusing it", "verify");
      h.update(buf);
      if (!out.write(buf)) await new Promise((r) => out.once("drain", r));
      onProgress(done, l.size);
    }
  } catch (e) {
    if (abort.signal.aborted) throw new sync.SyncError("the launcher update stopped arriving: try again later", "stall");
    throw e;
  } finally {
    clearTimeout(stall);
    await new Promise((r) => out.end(r));
  }
  if (done !== l.size || h.digest("hex") !== l.sha256) {
    fs.rmSync(part, { force: true });
    throw new sync.SyncError("the launcher update doesn't match the signed release: not installing it", "verify");
  }
  fs.renameSync(part, file);
  return file;
}

// Runs the setup silently: it waits for this launcher to close, installs over
// it and starts the new launcher (--force-run). Resolves once the setup is
// running (the caller quits then); rejects when it can't start, e.g. an
// antivirus or AppLocker blocks it (the error carries op "setup").
function install(file, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const fail = (e) => reject(Object.assign(e instanceof Error ? e : new Error(String(e)), { op: "setup" }));
    let child;
    try {
      child = spawnImpl(file, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true });
    } catch (e) {
      return fail(e);
    }
    child.once("error", fail);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

module.exports = { offered, validate, download, install, mayTry, recordTry, cleanup, MAX_TRIES };
