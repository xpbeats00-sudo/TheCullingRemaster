// Showdown in-match HUD (patch/make_showdown.py, patch/showdown_rounds.c,
// server/showdown.js).
//
// The whole series (first to 4 rounds) is one match. The patched game runs
// the rounds and tells the HUD through ShowGameMessage strings it never shows:
//   SDR|S|<round>|<you>|<rival>|<kit>|<N>   a round starts (kit 0-6)
//   SDR|E|<round>|<you>|<rival>|<W/L/D>|<N> a round is over, the series goes on
//   SDR|O|<round>|<you>|<rival>|<W/L/D>|<N> the last round: the series is over
// N is the team size (1: 1v1; older builds send no N). In team Showdown (2v2
// to 4v4) "you" and "rival" are the teams' round wins: the score reads
// YOUR TEAM w — l RIVALS.
//
// Team Showdown: your death doesn't end the round while a teammate stands.
// It shows no death screen and sends no result (whatever the score): "YOU
// ARE DOWN" until the round ends. Only the series' end decides: lost, the
// death you had is shown and posted then; won, the game's victory is (or, if
// it doesn't come within VICTORY_WAIT_MS, your death's stats as a victory).
// The game's teammate panel finds your teammate's new pawn after each reset
// (the patched exe re-arms it), so "<name> is your Teammate!" is shown once a
// match, not every round.
//
// Between rounds: the round banner and the score, the screen fades to black
// while the game puts both fighters back at their starts with the next kit,
// then fades back in with the pre-round panel. A death that doesn't end the
// series shows no death screen and sends no match result; the round goes to
// the server (/api/showdown/round). The series' last round ends the match the
// normal way: VICTORY, or the death screen, then the menu.
//
// Pre-round panel: the round and score, the round's kit (the same for both
// sides, from the server's server/data/showdown.json) by section - weapons,
// armor, injects, Muscle Man Milk, other - with the game's own item art, and
// what you carry now (the HUD's own inventory slots, refreshed as they change).
(function () {
  var API = (typeof REMASTER_API != "undefined" ? REMASTER_API : "http://127.0.0.1:8000/api");
  var PANEL_SECONDS = 12;
  var VICTORY_WAIT_MS = 4000;
  var BANNER_TO_BLACK_MS = 1000;
  var SECTIONS = [
    { title: "WEAPONS", cats: ["melee", "ranged", "throwable", "trap"] },
    { title: "ARMOR", cats: ["armor"] },
    { title: "INJECTS", cats: ["inject", "healing"] },
    { title: "MUSCLE MILK", cats: ["muscle_milk"] },
    { title: "ADDITIONAL EQUIPMENT", cats: ["utility", "airdrop_token", "currency", "other"] }
  ];
  // Rarity by the game's weapon tier (1-4); untiered items by kind.
  var TIER_COLORS = { 1: "#9aa0a6", 2: "#4caf50", 3: "#3d8bfd", 4: "#a64dff" };
  var CAT_COLORS = { armor: "#e0a030", inject: "#36c2b4", healing: "#36c2b4", muscle_milk: "#f2f2f2", ranged: "#3d8bfd" };
  // The HUD elements the game hides when you die (hud.js HideAllHudElements).
  var HUD_PARTS = ["hud-bottom-left-container", "hud-bottom-right-container", "hud-center-container",
    "compass-container", "location-container", "game-message-container"];

  var CSS = [
    "#sd-hud { position: absolute; right: 2vw; top: 6.5vh; width: 23vw; z-index: 30; font-family: Sucrose-Regular, Arial, sans-serif; color: #ececec; opacity: 0; transform: translateX(2vw); transition: opacity 0.35s ease, transform 0.35s ease; pointer-events: none; }",
    "#sd-hud.on { opacity: 1; transform: none; }",
    "#sd-hud .sd-panel { -webkit-transform-origin: 100% 0; transform-origin: 100% 0; background: linear-gradient(180deg, rgba(14, 10, 12, 0.9), rgba(8, 6, 8, 0.82)); border-right: 0.3vw solid #cc0000; border-radius: 1.2vh 0 0 1.2vh; padding: 1.2vh 1vw 1vh; box-shadow: 0 0.8vh 2.4vh rgba(0, 0, 0, 0.55); }",
    "#sd-hud .sd-head { display: flex; justify-content: space-between; align-items: baseline; }",
    "#sd-hud .sd-mode { font: 0.8vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.25vw; color: #ff463c; }",
    "#sd-hud .sd-round { font: 1.9vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.1vw; }",
    "#sd-hud .sd-score { font: 1.1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.15vw; white-space: nowrap; }",
    "#sd-hud .sd-kit { font-size: 0.8vw; opacity: 0.7; margin: 0.2vh 0 0.6vh; letter-spacing: 0.08vw; }",
    "#sd-hud .sd-sec { font: 0.7vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.22vw; opacity: 0.6; margin: 0.8vh 0 0.3vh; }",
    "#sd-hud .sd-item { display: flex; align-items: center; background: rgba(255, 255, 255, 0.05); border-radius: 0.8vh; padding: 0.35vh 0.5vw; margin-bottom: 0.35vh; border-left: 0.22vw solid #9aa0a6; }",
    // Coherent GT has no object-fit: the item art is a background, scaled to fit.
    "#sd-hud .sd-item .sd-art { width: 4.6vw; height: 2.6vw; background-position: center; background-size: contain; background-repeat: no-repeat; margin-right: 0.7vw; flex-shrink: 0; }",
    "#sd-hud .sd-item .sd-name { font: 0.95vw Sucrose-Bold, Arial, sans-serif; }",
    "#sd-hud .sd-item .sd-desc { font-size: 0.72vw; opacity: 0.7; line-height: 1.2; }",
    "#sd-hud .sd-tag { display: inline-block; margin-left: 0.4vw; padding: 0 0.4vw; border-radius: 0.6vh; font: 0.6vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.08vw; vertical-align: middle; background: rgba(255, 255, 255, 0.12); }",
    "#sd-hud .sd-tag.auto { background: #e0a030; color: #111; }",
    "#sd-hud .sd-none { font: 0.68vw Sucrose-Regular, Arial, sans-serif; letter-spacing: 0.05vw; opacity: 0.7; margin-left: 0.6vw; }",
    // ...and no flex gap: the slots are spaced by their margins.
    "#sd-hud .sd-carry { display: flex; margin-top: 0.4vh; }",
    "#sd-hud .sd-slot { width: 2.2vw; height: 2.2vw; margin-right: 0.35vw; border-radius: 0.6vh; background: rgba(255, 255, 255, 0.07) center / 80% no-repeat; }",
    "#sd-hud .sd-help { font-size: 0.74vw; margin-top: 0.8vh; padding-top: 0.7vh; border-top: 1px solid rgba(255, 255, 255, 0.1); }",
    "#sd-hud .sd-help b { color: #ff463c; }",
    "#sd-black { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 29; background: #000; opacity: 0; transition: opacity 0.7s ease; pointer-events: none; }",
    "#sd-black.on { opacity: 1; }",
    "#sd-banner { position: absolute; left: 50%; top: 22vh; transform: translate(-50%, -1vh); z-index: 31; text-align: center; font-family: Sucrose-Bold, Arial, sans-serif; color: #fff; opacity: 0; transition: opacity 0.4s ease, transform 0.4s ease; pointer-events: none; text-shadow: 0 0.3vh 1vh rgba(0, 0, 0, 0.8); }",
    "#sd-banner.on { opacity: 1; transform: translate(-50%, 0); }",
    "#sd-banner .sd-big { font: 4.4vw Creepster, Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.25vw; white-space: nowrap; }",
    "#sd-banner .sd-big.won { color: #5fd47a; }",
    "#sd-banner .sd-big.lost { color: #ff463c; }",
    "#sd-banner .sd-line { font-size: 1.4vw; letter-spacing: 0.2vw; }"
  ].join("\n");

  var panel = null, hideTimer = null, bannerTimer = null, blackTimer = null;
  // What the server knows (kits, rounds to win) and what the game has said.
  var info = { kits: null, kit: null, roundsToWin: 4 };
  var series = { active: false, round: 1, wins: 0, losses: 0, kit: 0, over: false, reported: {}, size: 1, sizeFromGame: false, held: null };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function style() {
    if (document.getElementById("sd-hud-style")) return;
    var s = el("style");
    s.id = "sd-hud-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function color(item) {
    return item.tier ? TIER_COLORS[item.tier] || "#9aa0a6" : CAT_COLORS[item.category] || "#9aa0a6";
  }

  function kitFor(k) {
    if (info.kits && info.kits.length) return info.kits[((k % info.kits.length) + info.kits.length) % info.kits.length];
    return info.kit;
  }

  function itemRow(item) {
    var row = el("div", "sd-item");
    row.style.borderLeftColor = color(item);
    var art = el("div", "sd-art");
    art.style.backgroundImage = "url('../images/weapons/" + item.icon + ".png')";
    row.appendChild(art);
    var text = el("div");
    var name = el("div", "sd-name", item.name + (item.tier ? "  · T" + item.tier : ""));
    var tag = el("span", "sd-tag" + (item.autoEquip ? " auto" : ""), item.autoEquip ? "ON" : "IN INVENTORY");
    name.appendChild(tag);
    text.appendChild(name);
    text.appendChild(el("div", "sd-desc", item.description));
    row.appendChild(text);
    return row;
  }

  // What the player carries now: the HUD's own slots (hud.js WeaponSlots).
  function carrying(box) {
    box.textContent = "";
    var slots = typeof WeaponSlots != "undefined" ? WeaponSlots : [];
    for (var i = 0; i < slots.length; i++) {
      var s = el("div", "sd-slot");
      var item = slots[i].getAttribute("data-slot-item");
      var locked = slots[i].getAttribute("data-slot-locked") == "true";
      if (locked) s.style.opacity = "0.35";
      if (item && item != "empty") s.style.backgroundImage = "url('images/InventoryIcons/" + item + ".png')";
      box.appendChild(s);
    }
  }

  function show() {
    style();
    var kit = kitFor(series.kit);
    if (!panel) {
      panel = el("div");
      panel.id = "sd-hud";
      document.body.appendChild(panel);
    }
    panel.textContent = "";
    var p = el("div", "sd-panel");
    var head = el("div", "sd-head");
    var left = el("div");
    left.appendChild(el("div", "sd-mode", "SHOWDOWN " + series.size + "V" + series.size));
    left.appendChild(el("div", "sd-round", "ROUND " + series.round));
    head.appendChild(left);
    head.appendChild(el("div", "sd-score", scoreLine(series.wins, series.losses)));
    p.appendChild(head);
    p.appendChild(el("div", "sd-kit", "FIRST TO " + info.roundsToWin + (kit ? " · " + kit.name.toUpperCase() + (series.size > 1 ? " · SAME KIT FOR EVERYONE" : " · SAME KIT FOR BOTH SIDES") : "")));
    var items = kit ? kit.items : [];
    for (var s = 0; s < SECTIONS.length; s++) {
      var sec = SECTIONS[s], mine = [];
      for (var i = 0; i < items.length; i++) if (sec.cats.indexOf(items[i].category) >= 0) mine.push(items[i]);
      var title = el("div", "sd-sec", sec.title);
      // An empty section takes one line.
      if (!mine.length) title.appendChild(el("span", "sd-none", "None this round"));
      p.appendChild(title);
      for (var m = 0; m < mine.length; m++) p.appendChild(itemRow(mine[m]));
    }
    p.appendChild(el("div", "sd-sec", "CARRYING NOW"));
    var carry = el("div", "sd-carry");
    carrying(carry);
    p.appendChild(carry);
    var help = el("div", "sd-help");
    var boost = null;
    for (var b = 0; b < items.length; b++) if (items[b].category == "muscle_milk" || items[b].category == "inject") boost = boost || items[b];
    help.innerHTML = "Everything is already in your inventory" + (items.some(function (x) { return x.autoEquip; }) ? " and your armor is on" : "") + ". " +
      (boost ? "Use the <b>" + boost.name + "</b> before you fight, then switch to your weapon." : "Switch to your weapon and fight.") +
      " The kit changes every 2 rounds.";
    p.appendChild(help);
    panel.appendChild(p);
    panel._carry = carry;
    fit();
    setTimeout(function () { panel.className = "on"; }, 30);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, PANEL_SECONDS * 1000);
  }

  // The panel is sized in vw (it reads the same on every width), so on wide
  // or short screens a big kit would run down into the weapon slots: it is
  // scaled down to end above them, measured from where they really are.
  function fit() {
    var p = panel && panel.firstChild;
    if (!p || !p.getBoundingClientRect) return;
    p.style.webkitTransform = p.style.transform = "";
    var r = p.getBoundingClientRect();
    var slot = document.getElementById("weapon-slot-0");
    var s = slot && slot.getBoundingClientRect ? slot.getBoundingClientRect() : null;
    var limit = (s && s.height) ? s.top : window.innerHeight * 0.97;
    var room = limit - r.top - window.innerHeight * 0.015;
    if (r.height > room && room > 0) {
      var k = "scale(" + (room / r.height).toFixed(3) + ")";
      p.style.webkitTransform = p.style.transform = k;
    }
  }
  if (window.addEventListener) window.addEventListener("resize", fit);

  function hide() {
    if (panel) panel.className = "";
  }

  function black(on) {
    style();
    var b = document.getElementById("sd-black");
    if (!b) {
      b = el("div");
      b.id = "sd-black";
      document.body.appendChild(b);
    }
    b.className = on ? "on" : "";
  }

  function banner(big, good, line, ms) {
    style();
    var b = document.getElementById("sd-banner") || el("div");
    b.id = "sd-banner";
    b.textContent = "";
    b.appendChild(el("div", "sd-big " + (good ? "won" : "lost"), big));
    b.appendChild(el("div", "sd-line", line));
    document.body.appendChild(b);
    setTimeout(function () { b.className = "on"; }, 30);
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { b.className = ""; }, ms || 9000);
  }

  // Refresh "carrying now" whenever the HUD redraws its slots.
  if (typeof RedrawWeaponSlots == "function") {
    var redraw = RedrawWeaponSlots;
    RedrawWeaponSlots = function () {
      redraw.apply(this, arguments);
      if (panel && panel._carry) carrying(panel._carry);
    };
  }

  // Players sharing an address are told apart by their in-game name.
  function nickname() {
    return typeof matchData != "undefined" && matchData.playerName ? String(matchData.playerName) : "";
  }

  function load(then) {
    $.ajax({ type: "GET", url: API + "/showdown?nickname=" + encodeURIComponent(nickname()), dataType: "json", timeout: 8000,
      success: function (state) {
        if (!state) return;
        if (state.kits) info.kits = state.kits;
        if (state.kit) info.kit = state.kit;
        if (state.series && state.series.roundsToWin) info.roundsToWin = state.series.roundsToWin;
        if (state.series && state.series.teamSize && !series.sizeFromGame) series.size = state.series.teamSize;
        if (state.active && state.series && !series.active) {
          series.active = true;
          series.round = state.series.round || 1;
          series.wins = state.series.wins || 0;
          series.losses = state.series.losses || 0;
        }
        if (then) then(state);
      } });
  }

  // The round's result to the server (once per round).
  function report(round, x) {
    if (series.reported[round]) return;
    series.reported[round] = true;
    $.ajax({ type: "POST", url: API + "/showdown/round", contentType: "application/json", timeout: 8000,
      data: JSON.stringify({ round: round, result: x, wins: series.wins, losses: series.losses, nickname: nickname() }),
      error: function () { series.reported[round] = false; } });
  }

  // Back to playing after a reset: the game hid the HUD when you died.
  function restoreHud() {
    for (var i = 0; i < HUD_PARTS.length; i++) {
      var e = document.getElementById(HUD_PARTS[i]);
      if (e) e.classList.remove("hidden");
    }
    if (typeof OnStartPlaying == "function") OnStartPlaying();
    // Trios/Quads-style extra teammate panels (hud.js) hide when you die:
    // back with you.
    if (typeof remasterExtraMates != "undefined" && remasterExtraMates.youDied) {
      remasterExtraMates.youDied = false;
      if (typeof RemasterShowExtraMates == "function") RemasterShowExtraMates();
    }
  }

  function onMessage(text) {
    var f = String(text).split("|");
    if (f.length < 6) return;
    var ev = f[1], round = parseInt(f[2], 10) || 1, x = f[5];
    series.active = true;
    series.round = round;
    series.wins = parseInt(f[3], 10) || 0;
    series.losses = parseInt(f[4], 10) || 0;
    if (f.length > 6 && parseInt(f[6], 10) >= 1) {
      series.size = parseInt(f[6], 10);
      series.sizeFromGame = true;
    }
    var score = scoreLine(series.wins, series.losses);
    if (ev == "S") {
      series.kit = parseInt(x, 10) || 0;
      series.over = false;
      series.held = null;                        // a new round: you stand again
      if (blackTimer) { clearTimeout(blackTimer); blackTimer = null; }
      restoreHud();
      show();
      setTimeout(function () { black(false); }, 400);
    } else if (ev == "E") {
      hide();
      report(round, x);
      var big = x == "W" ? "ROUND " + round + " WON" : x == "L" ? "ROUND " + round + " LOST" : "ROUND " + round + " DRAW";
      banner(big, x == "W", score + "  ·  FIRST TO " + info.roundsToWin, 3200);
      if (blackTimer) clearTimeout(blackTimer);
      blackTimer = setTimeout(function () { black(true); }, BANNER_TO_BLACK_MS);
    } else if (ev == "O") {
      series.over = true;
      hide();
      report(round, x);
      var won = series.wins > series.losses;
      banner(won ? "SHOWDOWN VICTORY" : "SHOWDOWN DEFEAT", won, score, 9000);
      releaseHeld(won);
    }
  }

  function scoreLine(wins, losses) {
    return series.size > 1 ? "YOUR TEAM " + wins + " — " + losses + " RIVALS" : "YOU " + wins + " — " + losses + " RIVAL";
  }

  // Team Showdown: the death held back (below), at the series' end.
  function releaseHeld(won) {
    var held = series.held;
    if (!held) return;
    series.held = null;
    if (!won) {
      // Your whole team is down: hud.js's "wait for the team" rule has
      // nothing left to wait for.
      if (typeof remasterTeam != "undefined") {
        remasterTeam.bMateAlive = false;
        remasterTeam.bPanelMateAlive = false;
      }
      if (typeof remasterExtraMates != "undefined") remasterExtraMates.alive = 0;
      if (setDeathData) setDeathData(held, false);
      return;
    }
    // Your team won the series after your death: the game's victory carries
    // the result; if it doesn't come, your stats as the victory.
    setTimeout(function () {
      if (typeof bLocalMatchResultSent != "undefined" && bLocalMatchResultSent) return;
      if (typeof ReportLocalMatchResult == "function") ReportLocalMatchResult($.extend({}, held, { Rank: 1 }), true);
    }, VICTORY_WAIT_MS);
  }

  // The game's messages: the "SDR|" ones are for us, never shown. In team
  // Showdown "<name> is your Teammate!" comes again each round (the panel
  // finds the new pawn): once a match is enough.
  var mateSeen = {};
  if (typeof AddGameMessage == "function") {
    var addMessage = AddGameMessage;
    AddGameMessage = function (message, duration) {
      if (typeof message == "string" && message.indexOf("SDR|") == 0) return onMessage(message);
      if (series.active && series.size > 1 && typeof message == "string" && / is your Teammate!$/.test(message)) {
        if (mateSeen[message]) return;
        mateSeen[message] = true;
      }
      return addMessage.apply(this, arguments);
    };
  }

  // A death that doesn't end the series: no death screen, no match result
  // (the round goes to the server from the round message). The death that
  // loses the series, and the win that takes it, end the match normally.
  // Team Showdown: every death waits for the series' end (releaseHeld).
  var setDeathData = null;
  if (typeof SetDeathData == "function") {
    setDeathData = SetDeathData;
    SetDeathData = function (deathData, bIsVictory) {
      if (series.active && !series.over && !bIsVictory && series.size > 1) {
        series.held = $.extend({}, deathData);
        hide();
        banner("YOU ARE DOWN", false, "YOUR TEAM FIGHTS ON  ·  " + scoreLine(series.wins, series.losses), 4000);
        return;
      }
      if (series.active && !series.over && !bIsVictory && series.losses + 1 < info.roundsToWin) {
        hide();
        return;
      }
      if (bIsVictory) series.held = null;
      return setDeathData.apply(this, arguments);
    };
  }

  // The match result names the series' round (server/server.js).
  function currentRound() {
    if (!series.active) return 0;
    return series.round;
  }

  // Old servers answer the match result with the series score.
  window.ShowShowdownResult = function (state) {
    if (!state || !state.series || series.over) return;
    var s = state.series, won = s.rounds[s.rounds.length - 1] == "won";
    var big = s.over ? (s.won ? "SHOWDOWN VICTORY" : "SHOWDOWN DEFEAT") : "ROUND " + s.round + (won ? " WON" : " LOST");
    banner(big, s.over ? s.won : won, scoreLine(s.wins, s.losses), 9000);
  };

  // At the start of the match (the HUD page loads with it).
  load(function (state) { if (state.active && state.series) show(); });
  window.ShowdownHud = { show: show, hide: hide, reload: load, round: currentRound, message: onMessage };
})();
