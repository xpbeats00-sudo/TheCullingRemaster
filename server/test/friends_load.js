// How much a status change costs when players have many friends online
// (docs/SERVER_AUDIT_2.md, P2). Every status change of a player (searching,
// lobby, match, menu) pushes the whole friends panel to each friend online,
// and each panel lists all of that friend's friends: O(friends x their
// friends) entries built and sent per change.
//
// usage: node test/friends_load.js [--players 101] [--changes 20]
// Seeds accounts.json and a fully connected friends.json (everyone friends
// with everyone: --players 201 is the 200-friend cap), logs everyone in on
// their own address, then one player queues and cancels --changes times;
// prints the server's own timing of those socket events from /metrics.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const ioClient = require("socket.io-client");
const { startServer } = require("./helpers");

const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i > 0 ? parseInt(process.argv[i + 1], 10) : def; };
const N = arg("players", 101), CHANGES = arg("changes", 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ids = Array.from({ length: N }, (_, i) => "steam:7656119000" + String(i).padStart(7, "0"));
  const accounts = {}, users = {};
  ids.forEach((id, i) => {
    accounts["player" + i] = { username: "Player" + i, email: "p" + i + "@example.test", userID: id, password: "scrypt$x", createdAt: 1 };
    users[id] = { friends: ids.filter((x) => x !== id), incoming: [], outgoing: [], seen: null };
  });
  const srv = startServer({ files: { "accounts.json": { version: 1, accounts, tokens: {}, grants: {} }, "friends.json": { version: 1, users } },
    vars: { CULLING_LOBBY_GATHER_MS: "60000", CULLING_ACCESS_LOG: "0", NODE_ENV: "production" } });
  const sockets = [];
  try {
    await srv.ready();
    const ipOf = (i) => "10.1." + (i >> 8) + "." + (i & 255);
    let received = 0, bytes = 0;
    const per = {};
    for (let i = 0; i < N; i++) {
      const r = await srv.request("POST", "/api/login", { userid: ids[i] }, { "X-Forwarded-For": ipOf(i) });
      const s = ioClient(`http://127.0.0.1:${srv.port}`, { transports: ["websocket"], forceNew: true, reconnection: false, forceNode: true,
        extraHeaders: { "X-Forwarded-For": ipOf(i) } });
      await new Promise((res) => s.once("login_ready", res));
      const ok = new Promise((res) => s.once("auth-response", res));
      s.emit("login", { token: r.json.token });
      await ok;
      s.on("remaster-friends", (f) => { received++; per[i] = (per[i] || 0) + 1; if (i === N - 1) bytes = JSON.stringify(f).length; });
      sockets.push(s);
    }
    await sleep(2500);                         // the logins' own pushes settle
    received = 0;
    for (const k of Object.keys(per)) delete per[k];
    const me = sockets[0];
    const t0 = Date.now();
    for (let c = 0; c < CHANGES; c++) {
      me.emit("join-mm", { queueName: "ffa" });   // menu -> searching
      await sleep(150);
      me.emit("leave-mm");                         // searching -> menu
      await sleep(150);
    }
    await sleep(1000);
    for (let i = 0; i < 100 && received < 2 * CHANGES * (N - 1); i++) await sleep(100);
    const m = (await srv.request("GET", "/metrics")).json;
    const byName = Object.assign({}, (m.lastMinute || {}).socketEventsByName || {}, (m.currentMinute || {}).socketEventsByName || {});
    const pick = (name) => byName[name] || null;
    console.log(JSON.stringify({ players: N, friendsEach: N - 1, statusChanges: 2 * CHANGES, panelPushes: received,
      panelBytesEach: bytes, joinMm: pick("join-mm"), leaveMm: pick("leave-mm"), friendsPush: pick("(friends push)"), wallMs: Date.now() - t0,
      eventLoopDelay: m.eventLoopDelay && m.eventLoopDelay.sinceLastMinute, errors: m.totals.errors }, null, 1));
    if (process.env.FL_DEBUG) console.log("pushes per socket:", JSON.stringify(per));
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
