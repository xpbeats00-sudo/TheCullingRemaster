// Showdown (patch/make_showdown.py): you against one bot in the Jungle arena,
// or your team against another (2v2, 3v3, 4v4: you and AI teammates against
// AI rivals), first to 4 rounds (server/showdown.js keeps the score).
//
// - The SHOWDOWN tile opens the Showdown card: the team size (1V1, 2V2, 3V3,
//   4V4; the last one picked is remembered) and PLAY, which queues
//   "showdown", "showdown_duo", "showdown_trio" or "showdown_quad" (the stock
//   Play screen only queues the Solo and Duo tiles). 1v1 starts at once; a
//   team size goes through a lobby of one team (your party, up to its size:
//   MatchLobby.js shows it).
// - The server answers "showdown:1v1" or "showdown:<n>" and ClientWeb.js opens
//   the arena match (StartTraining with RemasterShowdownURL: the arena URL,
//   with ?TeamSize=n for a team).
// - The whole series is one match (the patched exe plays every round,
//   patch/showdown_rounds.c). Back in the menu the server sends
//   "remaster-showdown" "over" once: the final score, or the forfeit of a
//   series quit before its end. Nothing here starts a match by itself: PLAY
//   AGAIN is a click (the same size again).
// ES5 only (Coherent UI): patch/lint_es5.py.
(function () {
  var root = null;
  var SIZES = [
    { size: 1, label: "1V1", queue: "showdown", note: "You against one rival." },
    { size: 2, label: "2V2", queue: "showdown_duo", note: "You and an AI teammate against two rivals. A party of 2 plays together." },
    { size: 3, label: "3V3", queue: "showdown_trio", note: "You and two AI teammates against three rivals. A party of up to 3 plays together." },
    { size: 4, label: "4V4", queue: "showdown_quad", note: "You and three AI teammates against four rivals. A party of up to 4 plays together." }
  ];
  var STORE = "remaster.showdown.size";
  var picked = load();

  function load() {
    var n = 1;
    try { n = parseInt(window.localStorage.getItem(STORE), 10) || 1; } catch (e) { n = 1; }
    return n >= 1 && n <= 4 ? n : 1;
  }

  function save(n) {
    try { window.localStorage.setItem(STORE, String(n)); } catch (e) { /* per-viewer convenience only */ }
  }

  function sizeOf(n) {
    for (var i = 0; i < SIZES.length; i++) if (SIZES[i].size == n) return SIZES[i];
    return SIZES[0];
  }

  if (typeof PlayScreen != "undefined") {
    var selected = PlayScreen.prototype.OnOptionElemSelected;
    PlayScreen.prototype.OnOptionElemSelected = function (elem) {
      if (!elem || elem.id != "showdown_play") return selected.call(this, elem);
      if (hasClickButton) return;
      pick();
    };
  }

  function queue(n, onQueued, onFailed) {
    var s = sizeOf(n);
    if (!Matchmaking.CanStartMatching() || Matchmaking.IsStartingMatchmaking) {
      if (onFailed) onFailed();
      ShowError("Showdown can't start right now. Please try again in a moment.");
      return;
    }
    QueueMatchmaking(s.queue).then(function (result) {
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
    "#remaster-showdown .sd-note { font-size: 1vw; opacity: 0.75; margin-top: 1vh; max-width: 34vw; margin-left: auto; margin-right: auto; }",
    "#remaster-showdown .sd-sizes { margin: 2vh 0 0.6vh; white-space: nowrap; }",
    "#remaster-showdown .sd-sizes button { font: 1.5vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.15vw; margin: 0 0.35vw; padding: 1vh 1.3vw; min-width: 6vw; border: none; border-radius: 1vh; color: white; background: rgba(255, 255, 255, 0.12); cursor: pointer; }",
    "#remaster-showdown .sd-sizes button.sd-on { background: rgba(204, 0, 0, 1); box-shadow: 0 0 1.2vh rgba(255, 60, 50, 0.6); }",
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

  function shell() {
    var r = build();
    r.textContent = "";
    var c = el("div", "sd-card");
    r.appendChild(c);
    r.className = "";
    return c;
  }

  function card(series, title, note) {
    var c = shell();
    var n = series.teamSize || 1;
    c.appendChild(el("div", "sd-mode", "SHOWDOWN " + n + "V" + n + " · FIRST TO " + series.roundsToWin));
    c.appendChild(el("div", "sd-title", title));
    var score = el("div", "sd-score");
    score.appendChild(document.createTextNode((n > 1 ? "YOUR TEAM " : "YOU ") + series.wins + " "));
    score.appendChild(el("span", null, "—"));
    score.appendChild(document.createTextNode(" " + series.losses + (n > 1 ? " RIVALS" : " RIVAL")));
    c.appendChild(score);
    var dots = el("div", "sd-rounds");
    for (var i = 0; i < series.rounds.length; i++) dots.appendChild(el("i", series.rounds[i]));
    c.appendChild(dots);
    var nt = el("div", "sd-note", note || "");
    c.appendChild(nt);
    var buttons = el("div", "sd-buttons");
    c.appendChild(buttons);
    return { note: nt, buttons: buttons };
  }

  function button(parent, text, cls, onClick) {
    var b = el("button", cls || null, text);
    b.addEventListener("click", onClick);
    parent.appendChild(b);
    return b;
  }

  // The SHOWDOWN tile: the team size, then PLAY.
  function pick() {
    var c = shell();
    c.appendChild(el("div", "sd-mode", "SHOWDOWN · FIRST TO 4 ROUNDS"));
    c.appendChild(el("div", "sd-title", "SHOWDOWN"));
    var row = el("div", "sd-sizes");
    c.appendChild(row);
    var note = el("div", "sd-note", sizeOf(picked).note);
    c.appendChild(note);
    var buttons = el("div", "sd-buttons");
    c.appendChild(buttons);
    var sizeButtons = [];
    function mark() {
      for (var k = 0; k < sizeButtons.length; k++) sizeButtons[k].className = SIZES[k].size == picked ? "sd-on" : "";
      note.textContent = sizeOf(picked).note;
    }
    for (var i = 0; i < SIZES.length; i++) {
      (function (s) {
        sizeButtons.push(button(row, s.label, null, function () {
          picked = s.size;
          save(picked);
          mark();
        }));
      })(SIZES[i]);
    }
    mark();
    var play = button(buttons, "PLAY", null, function () {
      if (hasClickButton) return;
      hasClickButton = true;
      hide();
      queue(picked, function () { PopScreenToMainMenu(); }, function () { hasClickButton = false; });
    });
    var back = button(buttons, "BACK", "sd-quiet", hide);
    // Escape / gamepad Back closes it, Select and the D-pad work its buttons
    // (Friends.js's shared overlay stack). The focus starts on PLAY.
    if (window.RemasterOverlay) {
      RemasterOverlay.open(root, { close: hide, items: sizeButtons.concat([play, back]), initial: SIZES.length });
    }
  }

  function over(series) {
    var n = series.teamSize || 1;
    var title = series.forfeit ? "SHOWDOWN LEFT" : series.won ? "SHOWDOWN VICTORY" : "SHOWDOWN DEFEAT";
    var note = series.forfeit ? "You left before the end: the series counts as lost."
      : series.won ? (n > 1 ? "Your team took " : "You took ") + series.wins + " rounds first."
        : (n > 1 ? "The rivals took " : "Your rival took ") + series.losses + " rounds first.";
    var ui = card(series, title, note);
    var items = [button(ui.buttons, "CLOSE", null, hide),
      button(ui.buttons, "PLAY AGAIN", "sd-quiet", function () { hide(); queue(n, null, null); })];
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
    hide: hide,
    pick: pick,
    sizes: SIZES
  };
})();
