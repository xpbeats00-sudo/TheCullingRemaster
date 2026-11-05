// The main process's decisions that don't need Electron, kept here so they
// can be tested (test/status.test.js): what PLAY may do, and what the
// start-up checks say.
"use strict";

const STEAM_ACCOUNT = "This install uses your Steam account, so it can't use a Remaster account. Choose an install made by the launcher in Settings";

// Why PLAY can't start the game right now, or null. The order matters: an
// install that uses a real Steam account can't sign in at all, so it is told
// that, not to sign in.
function playBlocker({ busy, check, installed, supported, signedIn }) {
  if (busy) return "Wait for Game Sync to finish";
  if (!check || !check.ok) return (check && check.reason) || "No game folder chosen";
  // Only a finished install starts: a paused one has some files but not all.
  if (!installed) return "The game isn't fully installed yet: press Resume to finish it";
  if (!supported) return STEAM_ACCOUNT;
  // Online play needs a Remaster account: the server lets the game in as the
  // account's Steam ID from this connection, and the username is the name
  // the game shows.
  if (!signedIn) return "Sign in or create an account first";
  return null;
}

module.exports = { playBlocker, STEAM_ACCOUNT };
