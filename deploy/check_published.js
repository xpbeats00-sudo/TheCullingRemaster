// After a publish: checks the release the way a launcher sees it, over HTTPS.
//   - manifest.json and its signature, against the launcher's release key
//     (and, with --expect, that it is exactly the release just published);
//   - every object it names is there at the right size: with --updates <dir>
//     on the VPS's disk (seconds), with --sweep over HTTPS (minutes from home);
//   - the files that changed (since --changed-from's manifest) and the
//     launcher setup are downloaded in full and checked against their SHA-256;
//   - the website's launcher.json and setup match the launcher the release offers.
// Exits 1 on any problem, listing each one.
//
// usage: node deploy/check_published.js <release base URL> [--expect <manifest.json>]
//          [--changed-from <previous manifest.json>] [--website <https://site>] [--updates <dir>] [--sweep] [--all]
//   e.g. node deploy/check_published.js https://xplab.shop:8443/remaster/ --website https://xplab.shop
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY = require(path.join(__dirname, "..", "launcher", "lib", "releasekey.js"));
const PARALLEL = 8;

function args(argv) {
  const o = { base: null, expect: null, changedFrom: null, website: null, updates: null, sweep: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expect") o.expect = argv[++i];
    else if (a === "--changed-from") o.changedFrom = argv[++i];
    else if (a === "--website") o.website = argv[++i];
    else if (a === "--updates") o.updates = argv[++i];
    else if (a === "--all") o.all = true;
    else if (a === "--sweep") o.sweep = true;
    else if (!o.base) o.base = a;
    else throw new Error("unexpected argument " + a);
  }
  if (!o.base) throw new Error("usage: node check_published.js <release base URL> [--expect m.json] [--changed-from m.json] [--website https://site] [--all]");
  if (!o.base.endsWith("/")) o.base += "/";
  return o;
}

// One request, tried three times (a dropped connection isn't a missing file).
async function get(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, Object.assign({ cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10 * 60000) }, init));
      if (res.ok || res.status === 404 || attempt === 3) {
        if (!res.ok) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { final: true });
        return res;
      }
    } catch (e) {
      if (e.final || attempt === 3) throw e;
    }
    await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
  }
}

async function sha256Of(url) {
  const res = await get(url);
  const h = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of res.body) { h.update(chunk); size += chunk.length; }
  return { sha256: h.digest("hex"), size };
}

// Runs fn over items, PARALLEL at a time.
async function each(items, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

async function check(o, log = console.log) {
  const problems = [];
  const t0 = Date.now();

  // 1. The manifest, as launchers get it.
  const body = Buffer.from(await (await get(o.base + "manifest.json")).arrayBuffer());
  const sig = (await (await get(o.base + "manifest.json.sig")).text()).trim();
  let signed = false;
  try { signed = crypto.verify(null, body, o.key || KEY, Buffer.from(sig, "base64")); } catch { signed = false; }
  if (!signed) problems.push("manifest.json's signature doesn't verify with the launcher's release key");
  const m = JSON.parse(body);
  log(`live release ${m.version}: ${m.files.length} files, signature ${signed ? "ok" : "BAD"}`);
  if (o.expect) {
    const want = fs.readFileSync(o.expect);
    if (!want.equals(body)) problems.push(`the live manifest isn't the one just published (${o.expect})`);
    else log("  it is exactly the release just published");
  }

  // 2. Every object is served, at its size.
  const objects = new Map();
  for (const f of m.files) if (!objects.has(f.sha256)) objects.set(f.sha256, f);
  if (m.launcher) objects.set(m.launcher.sha256, { path: "launcher setup " + m.launcher.version, size: m.launcher.size, sha256: m.launcher.sha256, url: m.launcher.url });
  // Where launchers fetch it: the entry's URL, relative to the manifest.
  const urlOf = (f) => new URL(f.url || "objects/" + f.sha256, o.base).href;
  const list = [...objects.values()];
  let missing = 0;
  if (o.updates || o.sweep) await each(list, async (f) => {
    if (o.updates) {
      // On the VPS: the file Caddy serves for this URL.
      let size = -1;
      try { size = fs.statSync(path.join(o.updates, ...new URL(urlOf(f)).pathname.slice(new URL(o.base).pathname.length).split("/").map(decodeURIComponent))).size; } catch { /* missing */ }
      if (size !== f.size) { missing++; problems.push(`${f.path}: ${size < 0 ? "missing" : size + " bytes, expected " + f.size} on disk`); }
      return;
    }
    try {
      const res = await get(urlOf(f), { method: "HEAD" });
      const len = Number(res.headers.get("content-length"));
      if (len !== f.size) { missing++; problems.push(`${f.path}: served ${len} bytes, expected ${f.size}`); }
    } catch (e) { missing++; problems.push(`${f.path}: ${e.message}`); }
  });
  if (o.updates || o.sweep) log(`  ${list.length - missing}/${list.length} objects ${o.updates ? "on disk" : "served"} at the right size`);

  // 3. Changed files (and the launcher) downloaded and hashed.
  let before = new Map();
  if (o.changedFrom) {
    try { before = new Map(JSON.parse(fs.readFileSync(o.changedFrom, "utf8")).files.map((f) => [f.path, f.sha256])); } catch { /* first publish */ }
  }
  const deep = list.filter((f) => o.all || !o.changedFrom || f.path.startsWith("launcher setup") || before.get(f.path) !== f.sha256);
  let bytes = 0;
  await each(deep, async (f) => {
    try {
      const got = await sha256Of(urlOf(f));
      bytes += got.size;
      if (got.sha256 !== f.sha256 || got.size !== f.size) problems.push(`${f.path}: downloaded content doesn't match its SHA-256`);
    } catch (e) { problems.push(`${f.path}: ${e.message}`); }
  });
  log(`  ${deep.length} changed object(s) downloaded and hash-checked (${(bytes / 1048576).toFixed(1)} MB)`);

  // 4. The website's launcher.
  if (o.website && m.launcher) {
    const site = o.website.replace(/\/+$/, "");
    try {
      const info = await (await get(site + "/download/launcher.json")).json();
      if (info.version !== m.launcher.version || info.sha256 !== m.launcher.sha256 || info.size !== m.launcher.size) {
        problems.push(`website launcher.json says ${info.version}, the release offers ${m.launcher.version}`);
      }
      const setup = await sha256Of(site + "/download/TheCullingRemasterSetup.exe");
      if (setup.sha256 !== m.launcher.sha256) problems.push("the website's setup isn't the launcher the release offers");
      log(`  website: launcher ${info.version}, setup ${setup.sha256 === m.launcher.sha256 ? "matches" : "DOESN'T match"} the release`);
    } catch (e) { problems.push("website: " + e.message); }
  }

  log(`checked in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (problems.length) {
    log(`${problems.length} problem(s):`);
    for (const p of problems.slice(0, 30)) log("  " + p);
  } else {
    log("update OK: launchers will get it");
  }
  return problems;
}

module.exports = { check };
if (require.main === module) {
  let o;
  try { o = args(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  check(o).then((p) => { process.exitCode = p.length ? 1 : 0; }, (e) => { console.error(e.message); process.exit(1); });
}
