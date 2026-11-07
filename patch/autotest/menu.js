// The autotest's stand-in for the game's menu (patch/autotest/run.py): logs a
// player in to the local server, queues a playlist the way the menu does
// (POST /api/matchqueue) and prints the server's match-ready, with the match
// URL the menu would open for it (ClientWeb.js's own functions, loaded from
// the built page), as one JSON line. Then it stays connected, as the menu
// does while its player is in the match, until stdin closes.
//
//   node menu.js <port> <userid> <queue> <ClientWeb.js>
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");

const [port, userid, queue, clientWeb] = process.argv.slice(2);
const SERVER = path.join(__dirname, "..", "..", "server");
const ioClient = require(require.resolve("socket.io-client", { paths: [SERVER] }));

function post(url, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) };
    if (token) headers.Authorization = "Bearer " + token;
    const req = http.request({ host: "127.0.0.1", port, path: url, method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on("error", reject);
    req.end(data);
  });
}

// The menu's own mapping from a match-ready answer to the URL it opens.
function menuUrls(file) {
  const src = fs.readFileSync(file, "utf8");
  const from = src.indexOf("var REMASTER_DUO_URLS");
  const to = src.indexOf("var socketConnection");
  if (from < 0 || to < from) throw new Error("ClientWeb.js: the Remaster URL section is not where it was");
  const ctx = {};
  vm.runInNewContext(src.slice(from, to) + "\nthis.out = { REMASTER_DUO_URLS, REMASTER_TEAM_URLS, REMASTER_CUSTOM_URLS," +
    " RemasterShowdownURL, RemasterMapUrl };", ctx);
  return ctx.out;
}

function urlFor(m, answer) {
  let r;
  if ((r = /^offline:(\d*)$/.exec(answer))) return m.REMASTER_CUSTOM_URLS[parseInt(r[1], 10) === 1 ? 1 : 0];
  if ((r = /^duo:(\d*)$/.exec(answer))) return m.REMASTER_DUO_URLS[parseInt(r[1], 10) === 1 ? 1 : 0];
  if ((r = /^(trio|quad):(\d*)$/.exec(answer))) return m.REMASTER_TEAM_URLS[r[1]][parseInt(r[2], 10) === 1 ? 1 : 0];
  if (answer.indexOf("map:") === 0) return m.RemasterMapUrl(answer);
  if (answer.indexOf("showdown:") === 0) return m.RemasterShowdownURL(answer);
  return null;
}

async function main() {
  const urls = menuUrls(clientWeb);
  const login = await post("/api/login", { userid, authType: "steam", appid: "437220", build: "autotest" });
  if (!login.json || !login.json.token) throw new Error("login failed: " + login.status);
  const token = login.json.token;
  const socket = ioClient("http://127.0.0.1:" + port, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((resolve) => socket.once("login_ready", resolve));
  const authed = new Promise((resolve, reject) => {
    socket.once("auth-response", resolve);
    socket.once("auth-fail", () => reject(new Error("socket login refused")));
  });
  socket.emit("login", { token });
  await authed;
  const ready = new Promise((resolve, reject) => {
    socket.once("match-ready", resolve);
    socket.once("join-mm-fail", (m) => reject(new Error("queue refused: " + JSON.stringify(m))));
    setTimeout(() => reject(new Error("no match-ready in 60 s")), 60000);
  });
  const q = await post("/api/matchqueue", { queueName: queue }, token);
  if (q.status !== 200) throw new Error("matchqueue: " + q.status + " " + JSON.stringify(q.json));
  const msg = await ready;
  const url = urlFor(urls, String(msg.gameServer || ""));
  process.stdout.write(JSON.stringify({ ready: msg, url }) + "\n");
  process.stdin.resume();
  process.stdin.on("end", () => { socket.close(); process.exit(0); });
}

main().catch((e) => { process.stdout.write(JSON.stringify({ error: e.message }) + "\n"); process.exit(1); });
