// The main screen's decisions, kept apart from the page so they can be tested
// without a window (test/ui.test.js): main-ui.js renders what these return.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.UiLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // What a download in progress is doing: connections failing one after
  // another read as "Reconnecting" (Game Sync pauses by itself if the
  // connection doesn't come back).
  function downloadVerb(p, pausing) {
    if (pausing) return "Pausing";
    if (p && p.reconnecting) return "Reconnecting";
    return "Downloading";
  }

  // The launcher updating itself, from its progress events: the status line
  // and the operation card, or null once it failed (p.error): the card goes
  // and the screen shows the launcher's normal state again.
  function launcherUpdateView(p, bytes) {
    if (!p || p.error || !p.total) return null;
    const pct = Math.floor(p.done / p.total * 100);
    const going = p.done < p.total;
    return {
      title: "Updating launcher",
      sub: going ? `Version ${p.version} · ${pct}%` : `Version ${p.version} · restarting`,
      op: { launcher: true, kind: "Operation in progress · Updating launcher", title: `Launcher ${p.version}`,
        file: going ? "The launcher restarts by itself when it's done" : "Restarting",
        frac: p.done / p.total, size: `${bytes(p.done)} / ${bytes(p.total)}` }
    };
  }

  // The operation card to keep after a state refresh: a launcher update's card
  // goes once the update failed.
  function keepOp(opLive, state) {
    if (opLive && opLive.launcher && (!state.launcherUpdate || state.launcherUpdate.error)) return null;
    return opLive;
  }

  // The host of an address, for display; never throws.
  function hostOf(url) {
    try { return new URL(url).host || "-"; } catch { return "-"; }
  }

  // The selected server, or the first; null when there is none.
  function selectedServer(state) {
    const list = (state && state.servers) || [];
    return list.find((s) => s.id === state.settings.serverId) || list[0] || null;
  }

  // The PLAY button: { label, look ("working", "secondary" or ""), disabled }.
  // f: syncing, pausing, resume (a paused download to continue),
  // notInstalled, accountNeeded.
  function playView(state, f) {
    const v = (label, look = "", disabled = false) => ({ label, look, disabled });
    if (f.syncing) return v(f.pausing ? "Pausing" : "Pause", "working", !!f.pausing);
    // The game started from here (or found running): no second copy.
    if (state.gameRunning) return v("Running", "secondary", true);
    if (f.resume && state.online) return v("Resume", "working");
    if (f.notInstalled && state.online) return v("Install", "working");
    if (f.notInstalled) return v("Offline", "secondary", true);
    if (!state.game.ok) return v("Set game folder", "secondary");
    if (state.pending && state.pending.files) return v("Update", "working");
    if (f.accountNeeded) return v("Sign in", "secondary");
    return v("Play");
  }

  return { downloadVerb, launcherUpdateView, keepOp, hostOf, selectedServer, playView };
});
