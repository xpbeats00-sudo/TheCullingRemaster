// The main process's decisions that don't need Electron, kept here so they
// can be tested (test/status.test.js): what PLAY may do, and what the
// start-up checks say.
"use strict";

const STEAM_ACCOUNT = "This install uses your Steam account, so it can't use a Remaster account. Choose an install made by the launcher in Settings";

// Why PLAY can't start the game right now, or null. The order matters: an
// install that uses a real Steam account can't sign in at all, so it is told
// that, not to sign in.
function playBlocker({ running, busy, check, installed, supported, signedIn }) {
  // A second copy would fight the first over its files and the server.
  if (running) return "The Culling is already running";
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

// Follows the game once PLAY started it (or it was found running): it counts
// as running until it was seen and is gone, or never appeared within startMs
// (the game takes a while to start after the Func launcher). onChange(running)
// on every change, onExit() once it is gone. isRunning() returns a promise.
function createGameWatch({ isRunning, onChange = () => {}, onExit = () => {}, pollMs = 10000, startMs = 3 * 60 * 1000 }) {
  let timer = null;
  let running = false;
  let seen = false;
  let since = 0;
  let checking = false;
  const set = (v) => { if (v !== running) { running = v; onChange(v); } };
  function stop() { clearInterval(timer); timer = null; }
  async function tick() {
    if (checking) return;
    checking = true;
    try {
      const up = await isRunning();
      if (!timer) return;                          // stopped meanwhile
      if (up) { seen = true; return; }
      if (!seen && Date.now() - since < startMs) return;
      stop();
      set(false);
      onExit();
    } catch {
      /* a failed check: try again next time */
    } finally {
      checking = false;
    }
  }
  function start({ alreadyRunning = false } = {}) {
    stop();
    since = Date.now();
    seen = alreadyRunning;
    set(true);
    timer = setInterval(tick, pollMs);
  }
  return { start, stop, get running() { return running; } };
}

// What a finished sync tells the window: what apply() did, and for a Repair
// what the check found (the plan's report). Read before the plan is reset.
function syncOutcome(result, todo, repair) {
  return { synced: result, repaired: repair ? (todo && todo.report) || null : null };
}

// The window's size on a screen whose work area (without the taskbar) is
// { width, height }: the designed size, or the whole work area on a smaller
// screen; the minimum size never exceeds it either.
const WINDOW = { width: 1280, height: 760, minWidth: 1100, minHeight: 660 };
function windowSize(workArea) {
  const w = workArea && workArea.width > 0 ? Math.floor(workArea.width) : WINDOW.width;
  const h = workArea && workArea.height > 0 ? Math.floor(workArea.height) : WINDOW.height;
  const width = Math.min(WINDOW.width, w), height = Math.min(WINDOW.height, h);
  return { width, height, minWidth: Math.min(WINDOW.minWidth, width), minHeight: Math.min(WINDOW.minHeight, height) };
}

// The start-up screen's last line. check: game.check(); todo: the plan (null
// without a release to plan against).
function bootLabel({ online, check, todo, installed, release }) {
  // A vanished folder isn't a place to install into.
  if (check && check.missing) return "Game folder not found";
  if (!online) return "Offline";
  if (!check || !check.ok) return check && check.installable ? "Ready to install" : "Choose a game folder";
  if (todo && todo.length) return isDrift(installed, release, todo) ? `Repair needed (${changedFiles(todo.length)})` : "Update available";
  return "Ready";
}

// Files that differ from the release the install already has (a player's
// own edit, a damaged file): a repair, not an update.
function isDrift(installed, release, todo) {
  return !!installed && !!release && installed === release && !!todo && todo.length > 0;
}
const changedFiles = (n) => `${n} file${n === 1 ? "" : "s"} changed`;

// Runs the start-up checks so that the start-up screen always finishes:
// checks() resolves to the last label, or HANDED_OFF when a launcher update
// took over (the screen stays until the launcher quits). A check that throws
// still finishes it, with onError(e)'s label. Never rejects.
const HANDED_OFF = Symbol("handed off");
async function finishBoot(checks, progress, onError) {
  let label;
  try {
    const r = await checks();
    if (r === HANDED_OFF) return r;
    label = r;
  } catch (e) {
    try { label = onError(e); } catch { label = "Start-up checks failed"; }
  }
  progress(1, label);
  return label;
}

module.exports = { playBlocker, createGameWatch, syncOutcome, windowSize, bootLabel, isDrift, finishBoot, HANDED_OFF, STEAM_ACCOUNT };
