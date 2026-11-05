// HUD harness (patch/hud_harness.py): stands in for the game in a browser.
//
// Loaded last by harness.html (the built hud.html plus this script). It
// answers the HUD's engine.call()s, fires the engine events a match sends
// for one scenario, then measures where the HUD's parts ended up:
//   window.HudHarness.ready      true once the scenario has run
//   window.HudHarness.measure()  { name: {x, y, w, h, visible} } for PARTS
//   window.HudHarness.clipped()  text that doesn't fit its box
// Scenarios (?scenario=): match, duo, spectate, showdown, scoreboard.
// ?names=long gives the players 20-character names (the longest allowed).
(function () {
  "use strict";
  var params = {};
  location.search.replace(/^\?/, "").split("&").forEach(function (kv) {
    if (kv) params[decodeURIComponent(kv.split("=")[0])] = decodeURIComponent(kv.split("=")[1] || "");
  });
  var scenario = params.scenario || "match";
  var longNames = params.names == "long";

  // ---- the game's side of engine.call(): every call resolves (stock coherent.js
  // only resolves calls that have a mock, so the HUD would wait forever).
  var answers = {
    IsConsole: false, IsLocalGame: false, RefreshSpectateMode: scenario == "spectate",
    GetGameplaySettings: { showPing: true }, GetActionMaps: [], GetAxisMaps: [], GetPlayerList: [],
    GetCraftingRecipes: [], IsBindingFinished: true
  };
  engine.SendMessage = function (name, id) {
    var deferred = engine._ActiveRequests[id];
    delete engine._ActiveRequests[id];
    setTimeout(function () { if (deferred) deferred.resolve(answers[name]); }, 0);
  };
  engine.TriggerEvent = function () {};

  // ---- the Remaster server (ShowdownHud.js, match results): sample answers, no network.
  var KIT = {
    name: "Brawler", items: [
      { name: "Machete", category: "melee", tier: 3, description: "Fast heavy blade. Bleeds on a charged hit.", icon: "Machete" },
      { name: "Compound Bow", category: "ranged", tier: 2, description: "Silent, arcing, slow to draw.", icon: "Bow" },
      { name: "Bear Trap", category: "trap", tier: 1, description: "Roots whoever steps in it.", icon: "BearTrap" },
      { name: "Light Armor", category: "armor", description: "Absorbs 30 damage.", icon: "Armor", autoEquip: true },
      { name: "Stamina Shot", category: "inject", description: "Instantly refills stamina.", icon: "StaminaShot" },
      { name: "Muscle Man Milk", category: "muscle_milk", description: "More melee damage for a while.", icon: "MuscleMilk" },
      { name: "Smoke Bomb", category: "utility", description: "Blocks sight for 8 seconds.", icon: "SmokeBomb" }
    ]
  };
  var pageAjax = $.ajax;
  $.ajax = function (o) {
    var url = String((o && o.url) || "");
    // The page's own files (localization, item JSON) load normally.
    if (url.indexOf(REMASTER_API) != 0) return pageAjax.apply($, arguments);
    if (/\/showdown(\?|$)/.test(url) && scenario.indexOf("showdown") == 0) {
      setTimeout(function () {
        o.success && o.success({ active: true, series: { round: 3, wins: 1, losses: 1, roundsToWin: 4 }, kits: [KIT] });
      }, 0);
    } else if (o.error) {
      setTimeout(function () { o.error({ status: 0 }, "error"); }, 0);
    }
    return { abort: function () {} };
  };

  function name(base) {
    // Account names are at most 20 characters (server/accounts.js).
    return longNames ? (base + "_Shadow_Reaper_2026").slice(0, 20) : base;
  }

  function wounds() {
    return [
      { WoundType: 4, bIsBuff: true, DurationPerc: 0.8 },
      { WoundType: 10, bIsBuff: true, DurationPerc: 0.6 },
      { WoundType: 11, bIsBuff: true, DurationPerc: 0.4 },
      { WoundType: 12, bIsBuff: true, DurationPerc: 0.3 },
      { WoundType: 1, bIsBuff: false, DurationPerc: 0.5 }
    ];
  }

  function scoreboardPlayers() {
    var out = [];
    for (var i = 0; i < 24; i++) {
      out.push({ playerID: i, name: name("Contestant" + (i + 1)), team: longNames ? i % 12 : i, kills: (i * 7) % 5,
        bIsAlive: i % 3, bIsBot: i > 1, killedBy: i % 3 ? "" : name("Contestant" + (i + 2)), damage: 100 + i * 13,
        deathOrder: i });
    }
    return out;
  }

  function startMatch() {
    engine.trigger("OnStartPlaying");
    engine.trigger("OnPlayerHealthChanged", 72, 100, 100);
    engine.trigger("OnPlayerStaminaChanged", 64, 100);
    engine.trigger("OnWoundsModified", wounds(), 30);
    woundData.Armor = 60;
    engine.trigger("SetMatchTime", 754, "");
    engine.trigger("SetAirdropProgress", 0.4, 100, 40, 40, false);
    engine.trigger("SetPlayerHeading", 45);
    engine.trigger("SetItemForSlot", "Machete", 0, "");
    engine.trigger("SetItemForSlot", "Bow", 1, "12");
    engine.trigger("SetItemForSlot", "BearTrap", 2, "2");
    engine.trigger("SetWeaponSlotEnabled", 3, true);
    engine.trigger("SetItemForSlot", "SmokeBomb", 3, "1");
    engine.trigger("SelectWeaponSlot", 0);
    engine.trigger("ShowLocationUpdate", "THE SHIPWRECK");
    // The kill feed: game messages, newest first.
    var kills = [name("Butcher") + " eliminated " + name("Rookie"), name("XP") + " eliminated " + name("Bot_Kessler"),
      "AIRDROP INCOMING", name("Vex") + " eliminated " + name("Moth"), "THE GAS IS CLOSING IN"];
    for (var i = 0; i < kills.length; i++) engine.trigger("ShowGameMessage", kills[i], 60000);
  }

  var steps = {
    match: function () { startMatch(); },
    duo: function () {
      startMatch();
      engine.trigger("OnTeamMemberAdded", name("Teammate"));
      engine.trigger("SetTeamMemberStatus", 55, 100, 80, 100);
      engine.trigger("UpdateTeamMemberPosition", 1, 0.5, 1, 4200);
      engine.trigger("OnMessageReceived", true, name("Teammate"), "airdrop by the shipwreck, come");
    },
    spectate: function () {
      engine.trigger("OnStartSpectating");
      engine.trigger("SetSpectatorTargetData", name("Butcher"), 64, 80, wounds(), 30);
      if (typeof PushScreen == "function" && typeof SpectateMatchScreen != "undefined") {
        try { PushScreen(SpectateMatchScreen); } catch (e) { console.warn("spectate screen", e); }
      }
      var sc = document.getElementById("SpectateContainer");
      if (sc) sc.classList.remove("hidden");
    },
    // The pre-round panel with the round's kit (loaded from the server first).
    showdown: function (done) {
      startMatch();
      ShowdownHud.reload(function () {
        engine.trigger("ShowGameMessage", "SDR|S|3|1|1|0", 4000);
        done();
      });
      return true;
    },
    // The round's result banner.
    "showdown-end": function (done) {
      startMatch();
      ShowdownHud.reload(function () {
        engine.trigger("ShowGameMessage", "SDR|S|3|1|1|0", 4000);
        setTimeout(function () { engine.trigger("ShowGameMessage", "SDR|E|3|2|1|W", 4000); done(); }, 500);
      });
      return true;
    },
    // The end-of-match screen's scoreboard tab with a full 24-player match.
    scoreboard: function (done) {
      startMatch();
      engine.trigger("UpdateScoreboardList", scoreboardPlayers());
      engine.trigger("SetDeathData", { TimeAlive: 412, NumKills: 3, DamageDone: 640, KillerName: name("Butcher"),
        KillerLevel: 12, DamageType: 1, KillerWeapon: "Machete", KillerDamage: 38, KillerPerks: [], FUNC: 40,
        DistanceTraveled: 2300, MatchStartXP: 1200 }, false);
      // Past the death screen (OutcomeScreen) to the end-of-match screen, then its
      // scoreboard tab, as the player's clicks would.
      setTimeout(function () {
        try { PushScreen("EndOfMatchScreen"); } catch (e) { console.warn("eom screen", e); }
        setTimeout(function () {
          var tab = document.getElementById("EOMScoreboard");
          try { GetActiveScreen().MouseTabClick(tab); } catch (e) { console.warn("scoreboard tab", e); }
          done();
        }, 300);
      }, 600);
      return true;
    }
  };

  // ---- what is measured
  var PARTS = {
    bottomLeft: "#hud-bottom-left-container",
    airdrop: "#airdrop-container",
    func: "#func",
    movement: "#movement-icon-container",
    armor: "#hud-bottom-left-container .armor-icon-container",
    buffs: "#hud-bottom-left-container .player-buff-container",
    health: "#health-bar-container",
    stamina: "#stamina-bar-container",
    party: "#party-member-container",
    partyName: "#party-member-name",
    compass: "#compass-container",
    location: "#location-container",
    killfeed: "#game-message-container",
    killfeedFirst: "#game-message-container .game-message",
    timerBox: "#hud-top-left-box",
    timer: "#match-timer",
    ping: "#match-ping",
    weapons: "#hud-bottom-right-container",
    weapon0: "#weapon-slot-0",
    weapon4: "#weapon-slot-4",
    weaponTip: "#weapon-tooltip-container",
    crosshair: "#crosshair-container",
    chat: "#chat-display",
    wounds: "#player-wound-container",
    spectator: "#spectator-player-element",
    spectatorName: "#spectator-player-name",
    spectateButtons: "#SpectateContainer .action-button-container",
    showdown: "#sd-hud .sd-panel",
    showdownBanner: "#sd-banner",
    eomScoreboard: "#EOMScoreboard-container",
    eomScoreboardRows: "#scoreboard-players-container"
  };

  function shown(e) {
    for (var n = e; n && n.nodeType == 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.display == "none" || cs.visibility == "hidden" || n.classList.contains("hidden")) return false;
      if (parseFloat(cs.opacity) == 0) return false;
    }
    return true;
  }

  function measure() {
    var out = {};
    for (var k in PARTS) {
      var e = document.querySelector(PARTS[k]);
      if (!e) { out[k] = null; continue; }
      var r = e.getBoundingClientRect();
      out[k] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        visible: shown(e) && r.width > 0 && r.height > 0 };
    }
    return out;
  }

  // Text cut off by its own box (overflow hidden / ellipsis) among the shown parts.
  function clipped() {
    var out = [];
    var sel = ["#party-member-name", "#spectator-player-name", ".game-message-text", "#sd-hud .sd-score",
      "#sd-hud .sd-round", "#sd-hud .sd-name", "#match-timer", ".location-entry", "#sd-banner .sd-big"];
    sel.forEach(function (s) {
      var list = document.querySelectorAll(s);
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!shown(e)) continue;
        var cs = getComputedStyle(e);
        if (e.scrollWidth > e.clientWidth + 1 && cs.overflow != "visible")
          // One line ending in "..." is a deliberate cut; wrapped-and-hidden text is not.
          out.push({ sel: s, text: e.textContent.trim().slice(0, 60), need: e.scrollWidth, have: e.clientWidth,
            ellipsis: cs.textOverflow == "ellipsis" && cs.whiteSpace == "nowrap" });
        else if (e.scrollHeight > e.clientHeight + 2 && cs.overflow != "visible")
          out.push({ sel: s, text: e.textContent.trim().slice(0, 60), need: e.scrollHeight, have: e.clientHeight,
            ellipsis: false, wrapped: true });
      }
    });
    return out;
  }

  // The scoreboard's rows: how many, and whether the ones past the box can be scrolled to.
  function scoreboard() {
    var box = document.getElementById("scoreboard-players-container");
    if (!box || !shown(box)) return null;
    var rows = box.querySelectorAll(".scoreboard-players");
    var scroller = null;
    for (var n = box; n && n.nodeType == 1; n = n.parentElement) {
      var oy = getComputedStyle(n).overflowY;
      if (oy == "auto" || oy == "scroll") { scroller = n; break; }
    }
    var last = rows.length ? rows[rows.length - 1].getBoundingClientRect() : null;
    return { rows: rows.length, lastBottom: last ? Math.round(last.bottom) : null,
      scrolls: !!scroller, scroller: scroller ? (scroller.id || scroller.className) : null };
  }

  window.HudHarness = { scoreboard: scoreboard, ready: false, scenario: scenario, measure: measure, clipped: clipped, parts: PARTS };

  function settle(then) { setTimeout(then, 900); }    // CSS transitions (the Showdown panel: 0.35 s)

  $(function () {
    // A mid-grey "world" behind the HUD, so white text shows in screenshots.
    document.documentElement.style.background = "#56606a";
    engine.trigger("UIBound");
    // The HUD binds once its localization files and player data are in.
    var tries = 0;
    (function wait() {
      var bound = !document.getElementById("hud-bottom-left-container").classList.contains("hidden");
      if (bound || ++tries > 100) {
        window.HudHarness.bound = bound;
        var finish = function () { settle(function () { window.HudHarness.ready = true; }); };
        if (!steps[scenario](finish)) finish();
      } else setTimeout(wait, 50);
    })();
  });
})();
