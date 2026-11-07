// The Culling Remaster autotest: what the in-match HUD receives and shows,
// posted to the local server's /api/uitrace (logged as "ui-trace AT|...").
// Only in the pak patch/autotest/run.py builds for its test copy of the game
// (it is never in patch/src, so no release has it). Loaded after hud.js and
// ShowdownHud.js; it only listens and reads, and changes nothing on the page.
(function () {
  var URL = (typeof REMASTER_API != "undefined" ? REMASTER_API : "http://127.0.0.1:8000/api") + "/uitrace";
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(URL)) return;
  var seq = 0;

  function post(msg) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", URL, true);
      xhr.setRequestHeader("Content-Type", "text/plain");
      xhr.send("AT|" + msg);
    } catch (e) { /* the log is best effort */ }
  }

  // The server keeps 300 characters of a trace: long ones go in numbered parts.
  function send(tag, text) {
    var id = ++seq, n = Math.max(1, Math.ceil(text.length / 200));
    for (var i = 0; i < n; i++) post(tag + "|" + id + "|" + i + "/" + n + "|" + text.substr(i * 200, 200));
  }

  function pick(d, keys) {
    var out = {};
    for (var i = 0; d && i < keys.length; i++) out[keys[i]] = d[keys[i]];
    return out;
  }
  var DEATH_KEYS = ["Rank", "NumKills", "KillerName", "bWasSuicide", "TimeAlive", "DamageDone"];

  send("load", JSON.stringify({ api: URL, at: Date.now() }));

  var tmsAt = 0;
  engine.on("ShowGameMessage", function (message) {
    var m = String(message);
    if (m.indexOf("TMS|") == 0) {
      if (Date.now() - tmsAt < 5000) return;
      tmsAt = Date.now();
    }
    send("msg", m);
  });
  engine.on("SetDeathData", function (d) {
    var o = pick(d, DEATH_KEYS);
    o.at = Date.now();
    o.hudRank = typeof deathData != "undefined" && deathData ? deathData.Rank : null;
    send("death", JSON.stringify(o));
  });
  engine.on("SetVictoryData", function (d) { send("victory", JSON.stringify(pick(d, DEATH_KEYS))); });
  engine.on("OnTeamMemberAdded", function (name) { send("mate", String(name)); });
  // Where the game's Rank comes from: SetRewardRank (hud.js keeps it in deathData.Rank) and
  // the match stats, with when they come relative to SetDeathData.
  engine.on("SetRewardRank", function (rank) { send("rank", JSON.stringify({ rank: rank, at: Date.now() })); });
  engine.on("SetMatchStats", function (json) {
    var placed = null;
    try { placed = JSON.parse(json).currentMatch.placed; } catch (e) { /* not ours to judge */ }
    send("stats", JSON.stringify({ placed: placed, at: Date.now() }));
  });

  var boardAt = 0;
  engine.on("UpdateScoreboardList", function (players) {
    if (Date.now() - boardAt < 5000) return;
    boardAt = Date.now();
    var list = players || [], teams = {}, dead = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {};
      teams[p.team] = (teams[p.team] || 0) + 1;
      if (p.bIsAlive == 0 && dead.length < 6) dead.push(pick(p, ["name", "playerName", "killedBy", "KilledBy", "team"]));
    }
    send("board", JSON.stringify({ n: list.length, teams: teams, keys: list.length ? Object.keys(list[0]).join(",") : "",
      dead: dead }));
  });

  // The result hud.js posts, with the raw Rank the game gave it.
  if (typeof ReportLocalMatchResult == "function") {
    var report = ReportLocalMatchResult;
    ReportLocalMatchResult = function (deathData, bIsVictory) {
      var body = typeof LocalMatchResultBody == "function" ? LocalMatchResultBody(deathData, bIsVictory) : {};
      send("result", JSON.stringify({ victory: bIsVictory, rawRank: deathData ? deathData.Rank : null, body: body,
        sent: typeof bLocalMatchResultSent != "undefined" ? bLocalMatchResultSent : null }));
      return report.apply(this, arguments);
    };
  }

  // What the page shows: the Showdown banner, the death screen, the
  // teammates' panels (the game's own and the stacked extra ones).
  var last = "";
  setInterval(function () {
    var b = document.getElementById("sd-banner");
    var extra = document.querySelectorAll(".remaster-party-extra"), shown = 0;
    for (var i = 0; i < extra.length; i++) if (!extra[i].classList.contains("hidden")) shown++;
    var mate = document.getElementById("party-member-container");
    var state = JSON.stringify({
      banner: b && b.classList.contains("on") ? b.textContent : "",
      deathScreen: typeof deathData != "undefined" && deathData ? Boolean(deathData.bDeathScreenShown) : null,
      extraPanels: extra.length, extraShown: shown,
      matePanel: mate ? !mate.classList.contains("hidden") && mate.style.display != "none" : null
    });
    if (state != last) { last = state; send("page", state); }
  }, 500);
})();
