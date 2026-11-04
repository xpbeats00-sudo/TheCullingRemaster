// Turns low-level failures into messages a player can act on. Messages the
// launcher already writes for players pass through unchanged; the technical
// detail stays in brackets for support (and in launcher.log).
"use strict";

const NETWORK = /fetch failed|net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|timed? ?out|socket hang up/i;
const DIAGNOSE = "If it keeps happening, use Copy diagnostics in Settings and send it to support.";

function friendly(e) {
  const msg = String((e && e.message) || e || "Something went wrong");
  const code = e && e.code;
  const kind = e && e.kind;
  const detail = (d) => ` (${d.length > 120 ? d.slice(0, 117) + "..." : d})`;
  if (kind === "signature") {
    return "The update server sent a release this launcher can't verify, so nothing was installed. Try again later. " + DIAGNOSE;
  }
  if (code === "ENOSPC" || /ENOSPC/.test(msg)) {
    return "Your drive is full. Free up some space, or choose another game folder in Settings, then press Resume." + detail(msg);
  }
  if ((code === "EACCES" || code === "EPERM" || code === "EROFS") && kind !== "commit") {
    return "Windows refused access to the game folder. Choose another folder in Settings (one inside your user folder works best)." + detail(msg);
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

module.exports = { friendly };
