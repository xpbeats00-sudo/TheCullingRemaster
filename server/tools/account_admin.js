#!/usr/bin/env node
// Operator commands for player accounts. Run on the VPS while the service is
// running: it talks to the server over loopback (http://127.0.0.1:<port>),
// which is the only way the /admin endpoints answer.
//
//   node tools/account_admin.js [--port 8100] import <username> <profiles.json> <localUserID>
//       Replaces the account's profile with <localUserID>'s profile from a
//       local server's profiles.json (the old profile is backed up first in
//       <data>\import-backups). Prints the before/after summary.
//   node tools/account_admin.js [--port 8100] reset-password <username>
//       Sets a random temporary password, signs the account out everywhere and
//       prints the password (give it to the player; it is not stored anywhere).
"use strict";

const fs = require("fs");
const http = require("http");

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage:\n  node tools/account_admin.js [--port 8100] import <username> <profiles.json> <localUserID>\n" +
    "  node tools/account_admin.js [--port 8100] reset-password <username>");
  process.exit(2);
}

function post(port, url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: url, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

function fail(r) {
  const why = r.status === 404 && r.json && !r.json.error
    ? "refused: run this on the server itself (loopback, not through the proxy)"
    : (r.json && r.json.error) || "HTTP " + r.status;
  console.error("failed:", why);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let port = 8100;
  const i = args.indexOf("--port");
  if (i >= 0) {
    port = parseInt(args[i + 1], 10);
    if (!(port > 0 && port < 65536)) usage("bad --port");
    args.splice(i, 2);
  }
  const [cmd, ...rest] = args;

  if (cmd === "import") {
    if (rest.length !== 3) usage();
    const [username, file, localUserID] = rest;
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    const has = (id) => Object.prototype.hasOwnProperty.call(all, id);
    const id = has(localUserID) ? localUserID : has("steam:" + localUserID) ? "steam:" + localUserID : null;
    if (!id) {
      console.error(`no profile "${localUserID}" in ${file}; it has: ${Object.keys(all).slice(0, 20).join(", ")}`);
      process.exit(1);
    }
    const r = await post(port, "/admin/import-profile", { username, profile: all[id] });
    if (r.status !== 200) fail(r);
    const { before, after } = r.json;
    console.log(`imported ${id} into ${r.json.username} (${r.json.userID})`);
    if (r.json.backup) console.log("previous profile saved to " + r.json.backup);
    const fmt = (s) => (s ? `credits ${s.credits}, xp ${s.xp}, level ${s.level}, wins ${s.wins}, kills ${s.kills}, owned ${s.owned}` : "(none)");
    console.log("before: " + fmt(before));
    console.log("after:  " + fmt(after));
  } else if (cmd === "reset-password") {
    if (rest.length !== 1) usage();
    const r = await post(port, "/admin/reset-password", { username: rest[0] });
    if (r.status !== 200) fail(r);
    console.log(`temporary password for ${r.json.username}: ${r.json.password}`);
    console.log(`${r.json.revokedTokens} sign-ins revoked. Give the password to the player privately; there is no` +
      " change-password endpoint yet, so it stays their password until the next reset.");
  } else {
    usage(cmd ? "unknown command: " + cmd : "");
  }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
