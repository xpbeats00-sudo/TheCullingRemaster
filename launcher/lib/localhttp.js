// Plain http to this PC (http://localhost, http://127.0.0.1) is for testing a
// local server: a dev run of the launcher and the tests allow it, the
// installed launcher doesn't (main.js: allow(!app.isPackaged)), so a settings
// file or a release can't point an installed launcher at something on the
// player's own PC without TLS. Every other address must be https.
"use strict";

let local = true;

function allow(on) { local = !!on; }
const allowed = () => local;

// url: a URL object. https anywhere; http only to this PC, and only when allowed.
function ok(url) {
  if (url.protocol === "https:") return true;
  return local && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

module.exports = { allow, allowed, ok };
