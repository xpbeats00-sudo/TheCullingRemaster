// Point the player's own Func client at the Remaster server.
//
// The Func mod's Func.Client.dll has its ClientWeb address built in (UTF-16).
// Instead of shipping a modified copy of Func's DLL, the launcher writes
// Func.Client.Local.dll next to it with the address replaced (the same edit
// as patch/patch_client_dll.py) and starts the game with that copy.
"use strict";

const fs = require("fs");
const path = require("path");

const ORIGINAL = "https://theculling.atch.ooo/api";
const SOURCE = "Func.Client.dll";
const TARGET = "Func.Client.Local.dll";

function utf16(s) { return Buffer.from(s, "utf16le"); }

// The URL slot: the original address, padded with zeros to its length.
function slot(url) {
  const out = Buffer.alloc(utf16(ORIGINAL).length);
  utf16(url).copy(out);
  return out;
}

// Writes Func.Client.Local.dll for apiUrl unless it is already there.
// Returns "unchanged" or "written"; throws when the DLL can't be patched.
function ensure(win64, apiUrl) {
  if (apiUrl.length > ORIGINAL.length) throw new Error(`server address too long for the client (max ${ORIGINAL.length} characters)`);
  if (!/^https:\/\//.test(apiUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(apiUrl)) {
    throw new Error("the client may only use an https server");
  }
  const target = path.join(win64, TARGET);
  const want = slot(apiUrl);
  if (fs.existsSync(target) && fs.readFileSync(target).includes(want)) return "unchanged";
  const src = path.join(win64, SOURCE);
  if (!fs.existsSync(src)) throw new Error("Func.Client.dll is missing: install the Func mod for The Culling first");
  const data = fs.readFileSync(src);
  const at = data.indexOf(utf16(ORIGINAL));
  if (at < 0) throw new Error("this Func.Client.dll has an unexpected server address (different Func version?)");
  want.copy(data, at);
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
  return "written";
}

module.exports = { ensure, ORIGINAL, SOURCE, TARGET };
