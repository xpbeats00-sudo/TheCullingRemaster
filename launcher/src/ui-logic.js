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

  return { downloadVerb };
});
