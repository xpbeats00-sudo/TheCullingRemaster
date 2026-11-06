#!/usr/bin/env node
// UDP probe for the network join test (docs/MULTIPLAYER_NETPLAY_FEASIBILITY.md).
//
// Listens where a game server would (default 0.0.0.0:7777) and logs every
// datagram: time, sender, size and the first bytes. It never answers, so a
// client that joins it sends its connection handshake for a while, then gives
// up. Packets arriving here prove the client half of a network match works
// (the game resolved the address, opened its net driver and sent its first
// handshake packets); nothing arriving, with the port reachable, means it
// didn't.
//
//   node deploy/netplay_udp_probe.js [port] [--seconds N]
//   node deploy/netplay_udp_probe.js --selftest
//
// On the VPS the port must be open for inbound UDP (Windows Firewall); that
// is a system setting for the operator to change, not this script.
"use strict";

const dgram = require("dgram");

function describe(msg, rinfo) {
  const head = msg.subarray(0, 24).toString("hex").replace(/(..)/g, "$1 ").trim();
  return `${new Date().toISOString()}  ${rinfo.address}:${rinfo.port}  ${msg.length} bytes  ${head}`;
}

function probe(port, { seconds = 0, log = console.log, host = "0.0.0.0" } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const senders = new Map();
    let count = 0;
    const done = () => {
      sock.close();
      resolve({ count, senders: [...senders.entries()].map(([who, n]) => ({ who, packets: n })) });
    };
    sock.on("error", reject);
    sock.on("message", (msg, rinfo) => {
      count++;
      const who = rinfo.address + ":" + rinfo.port;
      senders.set(who, (senders.get(who) || 0) + 1);
      log(describe(msg, rinfo));
    });
    sock.bind(port, host, () => {
      log(`listening on udp ${host}:${sock.address().port}` + (seconds ? ` for ${seconds} s` : " (Ctrl+C to stop)"));
      if (seconds) setTimeout(done, seconds * 1000);
      process.once("SIGINT", done);
    });
    probe.socket = sock;
  });
}

async function selftest() {
  const lines = [];
  const running = probe(0, { seconds: 1, host: "127.0.0.1", log: (l) => lines.push(l) });
  await new Promise((r) => setTimeout(r, 100));
  const port = probe.socket.address().port;
  const out = dgram.createSocket("udp4");
  await new Promise((r) => out.send(Buffer.from([0x01, 0x02, 0x03]), port, "127.0.0.1", r));
  out.close();
  const result = await running;
  if (result.count !== 1 || !/3 bytes {2}01 02 03$/.test(lines[1] || "")) {
    console.error("selftest failed", result, lines);
    process.exit(1);
  }
  console.log("selftest ok");
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    selftest();
  } else {
    const i = args.indexOf("--seconds");
    const seconds = i >= 0 ? Number(args[i + 1]) : 0;
    const port = Number(args.find((a, j) => /^\d+$/.test(a) && args[j - 1] !== "--seconds") || 7777);
    probe(port, { seconds }).then((r) => {
      console.log(`${r.count} packets from ${r.senders.length} sender(s)`);
      for (const s of r.senders) console.log(`  ${s.who}: ${s.packets}`);
    }, (e) => { console.error(e.message); process.exit(1); });
  }
}

module.exports = { probe, describe };
