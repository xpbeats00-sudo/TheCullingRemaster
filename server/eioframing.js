// Binary polling frames (server.js frames every polling payload as binary for
// the game's socket.io 1.x client), fast. engine.io-parser 2.x builds each
// string packet with utf8.js (a JS byte string) and copies it into a Buffer
// one writeUInt8 at a time; Buffer.from(..., 'utf8') gives the same bytes
// natively (performance review P3). The output is byte for byte the stock
// encoder's (test/eioframing.test.js); anything the fast path doesn't cover
// (binary data, a lone surrogate, which utf8.js encodes differently, an
// unknown packet type) goes to the stock encoder.
"use strict";

const eio = require("engine.io-parser");

const stockEncodePayloadAsBinary = eio.encodePayloadAsBinary;

// A string packet's bytes ("<type digit><data>" as UTF-8), or null.
function stringPacketBytes(p) {
  const type = eio.packets[p.type];
  if (type === undefined) return null;
  const d = p.data;
  if (d !== undefined && d !== null && (Buffer.isBuffer(d) || (d.buffer || d) instanceof ArrayBuffer)) return null;
  const s = d === undefined ? "" : String(d);
  if (!s.isWellFormed()) return null;
  return Buffer.from(type + s, "utf8");
}

// [0 (a string), the length's decimal digits as bytes, 255] then the bytes.
function frame(bytes) {
  const digits = String(bytes.length);
  const head = Buffer.allocUnsafe(digits.length + 2);
  head[0] = 0;
  for (let i = 0; i < digits.length; i++) head[i + 1] = digits.charCodeAt(i) - 48;
  head[head.length - 1] = 255;
  return head;
}

function encodePayloadAsBinary(packets, callback) {
  if (!packets.length) return stockEncodePayloadAsBinary.call(eio, packets, callback);
  const parts = [];
  for (const p of packets) {
    const bytes = stringPacketBytes(p);
    if (!bytes) return stockEncodePayloadAsBinary.call(eio, packets, callback);
    parts.push(frame(bytes), bytes);
  }
  return callback(Buffer.concat(parts));
}

module.exports = { encodePayloadAsBinary, stockEncodePayloadAsBinary };
