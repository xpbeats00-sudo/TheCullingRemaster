// Showdown (patch/make_showdown.py): you against one bot in the Jungle arena,
// first to 4 rounds (server/showdown.js keeps the score).
//
// - The SHOWDOWN tile queues "showdown" (the stock Play screen only queues the
//   Solo and Duo tiles). The server answers "showdown:1v1" and ClientWeb.js
//   opens the arena match (StartTraining with REMASTER_SHOWDOWN_URL).
// - The whole series is one match (the patched exe plays every round,
//   patch/showdown_rounds.c). Back in the menu the server sends
//   "remaster-showdown" "over" once: the final score, or the forfeit of a
//   series quit before its end. Nothing here starts a match by itself: PLAY
//   AGAIN is a click.
(function () {
  var root = null;

  if (typeof PlayScreen != "undefined") {
    var selected = PlayScreen.prototype.OnOptionElemSelected;
    PlayScreen.prototype.OnOptionElemSelected = function (elem) {
      if (!elem || elem.id != "showdown_play") return selected.call(this, elem);
      if (hasClickButton) return;
      hasClickButton = true;
      queue(function () { PopScreenToMainMenu(); }, function () { hasClickButton = false; });
    };
  }

  function queue(onQueued, onFailed) {
    if (!Matchmaking.CanStartMatching() || Matchmaking.IsStartingMatchmaking) {
      if (onFailed) onFailed();
      ShowError("Showdown can't start right now. Please try again in a moment.");
      return;
    }
    QueueMatchmaking("showdown").then(function (result) {
      if (result) {
        if (onQueued) onQueued();
      } else {
        if (onFailed) onFailed();
        ShowError("Failed to join Showdown. Please try again.");
      }
    });
  }

  var CSS = [
    "#remaster-showdown { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 45; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.55); font-family: Sucrose-Regular, Arial, sans-serif; color: rgba(235, 235, 235, 1); }",
    "#remaster-showdown.hidden { display: none; }",
    "#remaster-showdown .sd-card { min-width: 30vw; padding: 3vh 3vw; text-align: center; border-radius: 1.8vh; background: rgba(10, 6, 8, 0.94); box-shadow: 0 0 0 0.15vw rgba(204, 0, 0, 0.8), 0 1vh 3vh rgba(0, 0, 0, 0.7); }",
    "#remaster-showdown .sd-mode { font: 1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.3vw; color: rgba(255, 70, 60, 1); }",
    "#remaster-showdown .sd-title { font: 4vw Creepster, Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.2vw; margin: 1vh 0; white-space: nowrap; }",
    "#remaster-showdown .sd-score { font: 3vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.4vw; }",
    "#remaster-showdown .sd-score span { color: rgba(255, 70, 60, 1); }",
    "#remaster-showdown .sd-rounds { margin: 1.4vh 0; }",
    "#remaster-showdown .sd-rounds i { display: inline-block; width: 1.4vw; height: 1.4vw; margin: 0 0.3vw; border-radius: 50%; background: rgba(255, 255, 255, 0.12); }",
    "#remaster-showdown .sd-rounds i.won { background: rgba(80, 200, 110, 1); }",
    "#remaster-showdown .sd-rounds i.lost, #remaster-showdown .sd-rounds i.left { background: rgba(204, 0, 0, 1); }",
    "#remaster-showdown .sd-note { font-size: 1vw; opacity: 0.75; margin-top: 1vh; }",
    "#remaster-showdown .sd-buttons { margin-top: 2.2vh; }",
    "#remaster-showdown .sd-buttons button { font: 1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.15vw; margin: 0 0.5vw; padding: 1vh 1.6vw; border: none; border-radius: 3vh; color: white; background: rgba(204, 0, 0, 1); cursor: pointer; }",
    "#remaster-showdown .sd-buttons button.sd-quiet { background: rgba(255, 255, 255, 0.14); }"
  ].join("\n");

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function build() {
    if (root) return root;
    var style = el("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    root = el("div", "hidden");
    root.id = "remaster-showdown";
    // The card is on top of the menu: its clicks (and the right click the
    // stock screens take as Back) stay here.
    ["mousedown", "mouseup", "click", "contextmenu"].forEach(function (type) {
      root.addEventListener(type, function (e) { e.stopPropagation(); if (type == "contextmenu") e.preventDefault(); });
    });
    document.body.appendChild(root);
    return root;
  }

  function hide() {
    if (!root) return;
    root.className = "hidden";
    if (window.RemasterOverlay) RemasterOverlay.close(root);
  }

  function card(series, title, note) {
    var r = build();
    r.textContent = "";
    var c = el("div", "sd-card");
    c.appendChild(el("div", "sd-mode", "SHOWDOWN 1V1 · FIRST TO " + series.roundsToWin));
    c.appendChild(el("div", "sd-title", title));
    var score = el("div", "sd-score");
    score.appendChild(document.createTextNode("YOU " + series.wins + " "));
    score.appendChild(el("span", null, "—"));
    score.appendChild(document.createTextNode(" " + series.losses + " RIVAL"));
    c.appendChild(score);
    var dots = el("div", "sd-rounds");
    for (var i = 0; i < series.rounds.length; i++) dots.appendChild(el("i", series.rounds[i]));
    c.appendChild(dots);
    var n = el("div", "sd-note", note || "");
    c.appendChild(n);
    var buttons = el("div", "sd-buttons");
    c.appendChild(buttons);
    r.appendChild(c);
    r.className = "";
    return { note: n, buttons: buttons };
  }

  function button(parent, text, quiet, onClick) {
    var b = el("button", quiet ? "sd-quiet" : null, text);
    b.addEventListener("click", onClick);
    parent.appendChild(b);
    return b;
  }

  function over(series) {
    var title = series.forfeit ? "SHOWDOWN LEFT" : series.won ? "SHOWDOWN VICTORY" : "SHOWDOWN DEFEAT";
    var note = series.forfeit ? "You left before the end: the series counts as lost."
      : series.won ? "You took " + series.wins + " rounds first." : "Your rival took " + series.losses + " rounds first.";
    var ui = card(series, title, note);
    var items = [button(ui.buttons, "CLOSE", false, hide),
      button(ui.buttons, "PLAY AGAIN", true, function () { hide(); queue(null, null); })];
    // Escape / gamepad Back closes it, Select and the D-pad work its buttons
    // (Friends.js's shared overlay stack).
    if (window.RemasterOverlay) RemasterOverlay.open(root, { close: hide, items: items });
  }

  window.RemasterShowdown = {
    onState: function (msg) {
      if (!msg || !msg.series) return;
      if (msg.phase == "over") over(msg.series);
      else if (msg.phase == "left") hide();
    },
    hide: hide
  };
})();
