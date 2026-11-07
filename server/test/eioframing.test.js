// The binary polling frames the game's socket.io 1.x client reads
// (server.js always frames polling payloads as binary): the fast encoder
// must produce exactly the stock engine.io-parser bytes (performance review
// P3: the stock one UTF-8-encodes with utf8.js and writes byte by byte).
"use strict";

const assert = require("assert");
const eio = require("engine.io-parser");
const { encodePayloadAsBinary } = require("../eioframing");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

const stock = eio.encodePayloadAsBinary;
const encode = (fn, packets) => { let out = null; fn(packets, (b) => { out = b; }); return out; };
const same = (packets, what) => {
  const a = encode(stock, packets), b = encode(encodePayloadAsBinary, packets);
  assert.ok(Buffer.isBuffer(b), what + ": a buffer");
  assert.ok(a.equals(b), what + ": the same bytes\n stock " + a.toString("hex").slice(0, 120) + "\n fast  " + b.toString("hex").slice(0, 120));
};

test("ASCII messages, one and several, and every packet type", () => {
  same([{ type: "message", data: '2["get-cards",{"users":["a"]}]' }], "one message");
  same([{ type: "message", data: "2[\"x\"]" }, { type: "ping" }, { type: "pong", data: "probe" }, { type: "noop" }], "several");
  for (const type of Object.keys(eio.packets)) same([{ type, data: "x" }], type);
  same([{ type: "message", data: "" }], "empty data");
  same([{ type: "message", data: 12345 }], "a number");
});

test("non-ASCII: accents, CJK, emoji (surrogate pairs), a 10-digit length", () => {
  same([{ type: "message", data: '2["remaster-friends",{"you":"Zoë Ærøskøbing 東京 🎮🔥"}]' }], "mixed");
  same([{ type: "message", data: "é".repeat(70000) }], "long, two-byte");
  same([{ type: "message", data: "🎮".repeat(30000) }, { type: "message", data: "ok" }], "long, four-byte");
});

test("lone surrogates and binary data still come out as the stock encoder's", () => {
  same([{ type: "message", data: "a\ud800b" }], "a lone high surrogate");
  same([{ type: "message", data: "\udc00" }], "a lone low surrogate");
  same([{ type: "message", data: Buffer.from([1, 2, 3, 255]) }], "a buffer");
  same([{ type: "message", data: "text" }, { type: "message", data: Buffer.from([0, 9]) }], "text then a buffer");
  same([], "no packets");
});

test("random strings", () => {
  for (let n = 0; n < 300; n++) {
    let s = "";
    const len = Math.floor(Math.random() * 200);
    for (let i = 0; i < len; i++) s += String.fromCharCode(Math.floor(Math.random() * 0x10000));
    same([{ type: "message", data: s }], "random #" + n);
  }
});

console.log("all %d eio framing tests passed", passed);
