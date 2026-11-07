// Turns low-level failures into messages a player can act on. Messages the
// launcher already writes for players pass through unchanged; the technical
// detail stays in brackets for support (and in launcher.log).
"use strict";

const NETWORK = /fetch failed|net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|timed? ?out|socket hang up/i;
const DIAGNOSE = "If it keeps happening, use Copy diagnostics in Settings and send it to support.";

const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);
const LOCKED = new Set(["EBUSY", "EACCES", "EPERM"]);

// The message for a game folder that is gone (an unplugged drive, a deleted
// or renamed folder).
function missingFolder(gamePath) {
  return `Your game folder ${gamePath ? gamePath + " " : ""}can't be found: reconnect the drive or choose the folder in Settings`;
}

// e.op says what the launcher was doing, so a refusal names the right thing:
//   "setup"   starting a downloaded launcher update
//   "launch"  starting the game (Func.Launcher.exe)
//   "play"    writing the game's sign-in files and client just before PLAY
//   "appdata" writing the launcher's own settings (AppData)
// Anything else on disk is the game folder. ctx.gamePath and
// ctx.gameFolderMissing (the folder is gone) come from the caller.
function friendly(e, ctx = {}) {
  const msg = String((e && e.message) || e || "Something went wrong");
  const code = e && e.code;
  const kind = e && e.kind;
  const op = e && e.op;
  const detail = (d) => ` (${d.length > 120 ? d.slice(0, 117) + "..." : d})`;
  if (kind === "signature") {
    return "The update server sent a release this launcher can't verify, so nothing was installed. Try again later. " + DIAGNOSE;
  }
  // A finished download Windows wouldn't let the launcher move (lib/sync.js):
  // a lock, most likely an antivirus scanning it, not the drive or the folder.
  if (kind === "locked") {
    return "A downloaded game file is locked, most likely by your antivirus while it scans it. Wait a minute, then press Resume. " +
      "If it keeps happening, add the game folder to your antivirus's exclusions." + detail(msg);
  }
  if (op === "setup") {
    return "Windows didn't let the launcher update start (an antivirus or app control may have blocked it). Download the new launcher from the website." + detail(msg);
  }
  if (op === "launch" && (DENIED.has(code) || code === "UNKNOWN" || code === "ENOENT")) {
    return "Windows didn't let The Culling start (an antivirus or app control may have blocked Func.Launcher.exe). Allow it, then press Play again." + detail(msg);
  }
  if (code === "ENOSPC" || /ENOSPC/.test(msg)) {
    return "Your drive is full. Free up some space, or choose another game folder in Settings, then press Resume." + detail(msg);
  }
  if (ctx.gameFolderMissing && (code === "ENOENT" || DENIED.has(code) || code === "ENODEV" || code === "EINVAL" || code === "EIO")) {
    return missingFolder(ctx.gamePath);
  }
  if (op === "play" && LOCKED.has(code)) {
    return "A game file is locked, most likely because The Culling is still running. Close it, then press Play again." + detail(msg);
  }
  if (op === "appdata" && DENIED.has(code)) {
    return "Windows refused access to the launcher's own settings folder (in AppData). Check that your antivirus isn't blocking the launcher, then restart it." + detail(msg);
  }
  if (DENIED.has(code) && kind !== "commit") {
    return "Windows refused access to the game folder. Choose another folder in Settings (one inside your user folder works best)." + detail(msg);
  }
  // Chromium refuses some ports outright (6000, 6665-6669, ...): an address in
  // the settings or the release, not the player's connection (seen in
  // launcher.log as net::ERR_UNSAFE_PORT, which read as "check your internet").
  if (/ERR_UNSAFE_PORT/.test(msg)) {
    return "The update server's address uses a port the launcher isn't allowed to connect to. This is a server setup problem, " +
      "not your connection: tell support." + detail(msg);
  }
  const http = /HTTP (5\d\d)/.exec(msg);
  if (http && /manifest/.test(msg)) {
    return `The update server is having trouble right now (HTTP ${http[1]}). Try again in a few minutes.`;
  }
  if (NETWORK.test(msg) || NETWORK.test(String(code || ""))) {
    return "Can't reach the update server. Check your internet connection, then try again. " + DIAGNOSE + detail(msg);
  }
  return msg;
}

module.exports = { friendly, missingFolder };
