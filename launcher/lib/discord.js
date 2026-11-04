// Discord Rich Presence: while the game runs, Discord shows "Playing The
// Culling Remaster" with the mask art instead of an unknown game's "?".
//
// Talks to the Discord desktop app over its local IPC pipe
// (\\.\pipe\discord-ipc-0..9): each frame is a little-endian opcode and
// length, then JSON. Opcode 0 is the handshake with the application id,
// opcode 1 a command (SET_ACTIVITY). The art and the name shown come from the
// Discord application (Developer Portal): its name, and the Rich Presence art
// asset named ASSET. Discord not running, or no application id: nothing
// happens and nothing fails.
"use strict";

const net = require("net");
const crypto = require("crypto");

// Application ID from the Discord Developer Portal (public, not a secret).
const APP_ID = "1567661293802889430";
const ASSET = "mask";
const PIPE = "\\\\.\\pipe\\discord-ipc-";

function frame(op, body) {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

// Reads whole frames from a socket's data events.
function reader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const len = buf.readUInt32LE(4);
      if (buf.length < 8 + len) break;
      let body = null;
      try { body = JSON.parse(buf.subarray(8, 8 + len).toString("utf8")); } catch { /* skip a bad frame */ }
      onFrame(buf.readUInt32LE(0), body);
      buf = buf.subarray(8 + len);
    }
  };
}

// One connection: resolves with the socket once Discord says READY.
function connect(pipe, appId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("discord: no answer")); }, timeoutMs);
    sock.once("error", (e) => { clearTimeout(timer); reject(e); });
    sock.once("connect", () => sock.write(frame(0, { v: 1, client_id: appId })));
    sock.on("data", reader((op, body) => {
      if (body && body.evt === "READY") { clearTimeout(timer); resolve(sock); }
      else if (op === 2 || (body && body.evt === "ERROR")) { clearTimeout(timer); sock.destroy(); reject(new Error("discord: " + JSON.stringify(body))); }
    }));
  });
}

// The activity shown in Discord.
function activity({ started, links }) {
  const a = {
    details: "In the arena",
    timestamps: { start: Math.floor(started / 1000) },
    assets: { large_image: ASSET, large_text: "The Culling Remaster" },
    instance: false
  };
  const buttons = [];
  if (links && /^https:\/\//.test(links.discord || "")) buttons.push({ label: "Join the Discord", url: links.discord });
  if (links && /^https:\/\//.test(links.website || "")) buttons.push({ label: "Play The Culling Remaster", url: links.website });
  if (buttons.length) a.buttons = buttons;
  return a;
}

// Presence for one play session: start() shows it (retrying while Discord is
// closed), stop() clears it. pid: the process Discord ties the activity to.
function createPresence({ appId = APP_ID, pipe = PIPE, pid = process.pid, links = null, log = () => {},
  retryMs = 15000, timeoutMs = 5000 } = {}) {
  let sock = null, started = 0, timer = null, active = false;

  async function open() {
    for (let i = 0; i < 10; i++) {
      try { return await connect(pipe + i, appId, timeoutMs); } catch { /* next pipe */ }
    }
    return null;
  }

  function set(act) {
    if (!sock || sock.destroyed) return false;
    sock.write(frame(1, { cmd: "SET_ACTIVITY", args: { pid, activity: act }, nonce: crypto.randomUUID() }));
    return true;
  }

  async function attempt() {
    timer = null;
    if (!active) return;
    sock = await open();
    if (!active) { if (sock) sock.destroy(); sock = null; return; }
    if (!sock) { timer = setTimeout(attempt, retryMs); return; }
    log("discord: presence on");
    sock.on("close", () => { sock = null; if (active && !timer) timer = setTimeout(attempt, retryMs); });
    sock.on("error", () => {});
    set(activity({ started, links }));
  }

  return {
    enabled: !!appId,
    start() {
      if (!appId || active) return;
      active = true;
      started = Date.now();
      attempt();
    },
    stop() {
      active = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (sock) { set(null); const s = sock; sock = null; setTimeout(() => s.destroy(), 200); log("discord: presence off"); }
    },
    get connected() { return !!sock && !sock.destroyed; }
  };
}

module.exports = { createPresence, activity, frame, reader, APP_ID, ASSET };
