// The Culling Remaster: the global leaderboard (server/leaderboard.js).
//
// LEADERBOARD (a main menu item, added by make_branding.py) opens a panel with
// one tab per board: Ranked (this season's rating and tier), Wins, Kills, K/D,
// Showdown series won and Time played. Each lists the top players by account
// username; your own row is highlighted, and pinned under the list with your
// position even when you are outside the top. Clicking a row opens that
// player's card (Friends.js). The server answers "remaster-leaderboard-get"
// with every board at once ("remaster-leaderboard"), so switching tabs never
// asks again. Self-contained: builds its own markup and styles.
(function () {
  var BOARDS = {
    ranked: { tab: "Ranked", column: "Rating" },
    wins: { tab: "Wins", column: "Wins", hint: "Matches won." },
    kills: { tab: "Kills", column: "Kills", hint: "Kills across every match." },
    kd: { tab: "K/D", column: "K/D" },
    showdown: { tab: "Showdown", column: "Series won", hint: "Showdown series won." },
    time: { tab: "Time played", column: "Time", hint: "Time alive in matches." }
  };
  var ORDER = ["ranked", "wins", "kills", "kd", "showdown", "time"];
  var CSS = [
    "#remaster-leaderboard { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 100; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.6); font-family: Sucrose-Regular, Arial, sans-serif; color: rgba(235, 235, 235, 1); }",
    "#remaster-leaderboard.hidden { display: none; }",
    "#remaster-leaderboard .lb-panel { position: relative; display: flex; flex-direction: column; width: 46vw; height: 86vh; padding: 2.4vh 1.6vw 2vh; box-sizing: border-box; border-radius: 1.8vh; background: rgba(12, 8, 10, 1); box-shadow: 0 0 0 0.15vw rgba(204, 0, 0, 0.8), 0 1vh 3vh rgba(0, 0, 0, 0.7); }",
    "#remaster-leaderboard .lb-close { position: absolute; right: 1.2vw; top: 1.6vh; width: 2.2vw; height: 2.2vw; text-align: center; border-radius: 50%; font: 1.1vw Sucrose-Bold, Arial, sans-serif; line-height: 2.2vw; background: rgba(255, 255, 255, 0.1); cursor: pointer; }",
    "#remaster-leaderboard .lb-close:hover { background: rgba(204, 0, 0, 1); }",
    "#remaster-leaderboard .lb-title { font: 2.6vw Creepster, Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.15vw; line-height: 1; }",
    "#remaster-leaderboard .lb-sub { margin-top: 0.4vh; font-size: 0.8vw; opacity: 0.65; }",
    "#remaster-leaderboard .lb-tabs { display: flex; flex-wrap: wrap; margin-top: 1.8vh; }",
    "#remaster-leaderboard .lb-tab { flex: 0 0 auto; margin: 0 0.4vw 0.6vh 0; padding: 0.75vh 1vw; border-radius: 3vh; font: 0.72vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.1vw; text-transform: uppercase; white-space: nowrap; background: rgba(255, 255, 255, 0.1); cursor: pointer; }",
    "#remaster-leaderboard .lb-tab:hover { background: rgba(255, 255, 255, 0.22); }",
    "#remaster-leaderboard .lb-tab.on { background: rgba(204, 0, 0, 1); }",
    "#remaster-leaderboard .lb-cols { display: flex; align-items: center; margin-top: 1vh; padding: 0.6vh 0.8vw 0.6vh 0; font: 0.7vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.14vw; text-transform: uppercase; color: rgba(255, 70, 60, 1); border-bottom: 1px solid rgba(255, 255, 255, 0.1); }",
    "#remaster-leaderboard .lb-cols .lb-pos { font: inherit; color: inherit; }",
    "#remaster-leaderboard .lb-cols .lb-who { padding-left: 2.8vw; }",
    "#remaster-leaderboard .lb-scroll { position: relative; flex: 1 1 auto; overflow-y: auto; margin-right: -0.6vw; padding-right: 0.6vw; }",
    "#remaster-leaderboard .lb-row { position: relative; display: flex; align-items: center; height: 5.4vh; margin-top: 0.6vh; padding-right: 0.8vw; border-radius: 1.2vh; background-color: rgba(18, 14, 16, 0.9); background-size: cover; background-position: center; overflow: hidden; cursor: pointer; }",
    "#remaster-leaderboard .lb-row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: linear-gradient(90deg, rgba(8, 6, 8, 0.94) 40%, rgba(8, 6, 8, 0.62) 72%, rgba(8, 6, 8, 0.88)); }",
    "#remaster-leaderboard .lb-row > * { position: relative; }",
    "#remaster-leaderboard .lb-row:hover { box-shadow: inset 0 0 0 0.12vw rgba(255, 255, 255, 0.35); }",
    "#remaster-leaderboard .lb-row.me { box-shadow: inset 0 0 0 0.15vw rgba(204, 0, 0, 1); }",
    "#remaster-leaderboard .lb-row.me::before { background: linear-gradient(90deg, rgba(60, 4, 6, 0.94) 40%, rgba(40, 4, 6, 0.62) 72%, rgba(40, 4, 6, 0.88)); }",
    "#remaster-leaderboard .lb-row.me .lb-name { color: rgba(255, 110, 100, 1); }",
    "#remaster-leaderboard .lb-pos { width: 3.4vw; flex: 0 0 auto; text-align: center; font: 1.1vw Sucrose-Bold, Arial, sans-serif; }",
    "#remaster-leaderboard .lb-row.p1 .lb-pos { color: rgba(245, 196, 66, 1); font-size: 1.4vw; }",
    "#remaster-leaderboard .lb-row.p2 .lb-pos { color: rgba(210, 214, 222, 1); font-size: 1.3vw; }",
    "#remaster-leaderboard .lb-row.p3 .lb-pos { color: rgba(214, 138, 74, 1); font-size: 1.2vw; }",
    "#remaster-leaderboard .lb-level { width: 2vw; height: 2vw; flex: 0 0 auto; margin-right: 0.8vw; text-align: center; border-radius: 50%; font: 0.8vw Sucrose-Bold, Arial, sans-serif; line-height: 2vw; background: rgba(255, 255, 255, 0.12); }",
    "#remaster-leaderboard .lb-who { flex: 1 1 auto; min-width: 0; }",
    "#remaster-leaderboard .lb-name { font: 1vw Sucrose-Bold, Arial, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    "#remaster-leaderboard .lb-detail { margin-top: 0.2vh; font-size: 0.72vw; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    "#remaster-leaderboard .lb-rank { width: 2.4vw; height: 2.4vw; flex: 0 0 auto; margin: 0 0.6vw; }",
    "#remaster-leaderboard .lb-rank.none { visibility: hidden; }",
    "#remaster-leaderboard .lb-value { width: 6.4vw; flex: 0 0 auto; text-align: right; font: 1.25vw Sucrose-Bold, Arial, sans-serif; white-space: nowrap; text-shadow: 0 0 0.6vh black; }",
    "#remaster-leaderboard .lb-cols .lb-value { font: inherit; }",
    "#remaster-leaderboard .lb-hint { padding: 1.2vh 0.2vw; font-size: 0.8vw; opacity: 0.6; }",
    "#remaster-leaderboard .lb-yours { flex: 0 0 auto; margin-top: 1vh; padding-top: 0.4vh; border-top: 1px solid rgba(255, 255, 255, 0.1); }",
    "#remaster-leaderboard .lb-yours .lb-label { margin-top: 0.6vh; font: 0.7vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.14vw; text-transform: uppercase; color: rgba(255, 70, 60, 1); }",
    "#remaster-leaderboard .lb-foot { flex: 0 0 auto; margin-top: 1vh; font-size: 0.72vw; opacity: 0.55; }"
  ].join("\n");

  var data = null;            // the last remaster-leaderboard answer
  var board = "ranked";       // the tab shown
  var panel = null, styled = false;
  var retry = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function style() {
    if (styled) return;
    styled = true;
    var s = el("style");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function emit(name, msg) {
    try {
      if (typeof socketConnection != "undefined" && socketConnection) { socketConnection.emit(name, msg); return true; }
    } catch (e) { /* offline */ }
    return false;
  }

  function cardImage(cardID) {
    var name = (typeof CullingCardImages != "undefined") ? CullingCardImages[String(cardID)] : null;
    return name ? 'url("/images/culling-cards/' + name + '.png")' : "none";
  }

  function emblem(tier) {
    var img = el("img", "lb-rank" + (tier ? "" : " none"));
    if (tier) { img.src = "/images/ranked/" + String(tier).toLowerCase() + ".png"; img.alt = tier; }
    return img;
  }

  function minutes(m) {
    m = Math.round(m || 0);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function valueText(id, v) {
    if (v == null) return "-";
    if (id === "kd") return (+v).toFixed(2);
    if (id === "time") return minutes(v);
    return String(v);
  }

  function detailText(id, e) {
    if (id === "ranked") return (e.rank ? e.rank + " · " : "") + plural(e.matches || 0, "match", "matches") + " · " + plural(e.wins || 0, "win", "wins");
    if (id === "kd") return plural(e.kills || 0, "kill", "kills") + " · " + plural(e.deaths || 0, "death", "deaths");
    if (id === "showdown") return plural(e.lost || 0, "series", "series") + " lost";
    return plural(e.matches || 0, "match", "matches");
  }

  function hintText(id) {
    if (id === "ranked") return (data && data.season ? data.season.name + " rating. " : "") + "Ranked Solo rating moves on placement.";
    if (id === "kd") return "Kills per death, for players with at least " + ((data && data.minMatches) || 10) + " matches.";
    return BOARDS[id].hint;
  }

  // Why you aren't on this board yet.
  function notListed(id, you) {
    if (id === "ranked") return "Play Ranked Solo to get a rating this season.";
    if (id === "kd") return "Play " + plural(you.needMatches || 0, "more match", "more matches") + " to be listed.";
    if (id === "showdown") return "Win a Showdown series to be listed.";
    if (id === "time") return "Play a match to be listed.";
    return "Not on this board yet.";
  }

  function row(id, e, mine, unlisted) {
    var r = el("div", "lb-row" + (mine ? " me" : "") + (e.position && e.position <= 3 ? " p" + e.position : ""));
    r.style.backgroundImage = cardImage(e.cardID);
    if (typeof TrackCullingCardElement == "function") TrackCullingCardElement(r);
    r.appendChild(el("span", "lb-pos", e.position ? String(e.position) : "-"));
    r.appendChild(el("span", "lb-level", String(e.level || 1)));
    var who = el("div", "lb-who");
    who.appendChild(el("div", "lb-name", e.username));
    who.appendChild(el("div", "lb-detail", unlisted ? notListed(id, e) : detailText(id, e)));
    r.appendChild(who);
    r.appendChild(emblem(e.rank));
    r.appendChild(el("span", "lb-value", valueText(id, e.value)));
    r.addEventListener("click", function () {
      if (window.RemasterFriends && window.RemasterFriends.showCard) {
        window.RemasterFriends.showCard({ username: e.username, level: e.level, rank: e.rank, cardID: e.cardID });
      }
    });
    return r;
  }

  function current() {
    if (!data || !data.boards) return null;
    for (var i = 0; i < data.boards.length; i++) if (data.boards[i].id === board) return data.boards[i];
    return null;
  }

  function render() {
    draw();
    if (panel && window.RemasterOverlay) RemasterOverlay.refresh(panel);   // the focus ring on the new rows
  }

  function draw() {
    if (!panel || panel.className === "hidden") return;
    var tabs = panel.querySelectorAll(".lb-tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].className = "lb-tab" + (tabs[i].getAttribute("data-board") === board ? " on" : "");
    panel.querySelector(".lb-cols .lb-value").textContent = BOARDS[board].column;
    var box = panel.querySelector(".lb-scroll");
    var yours = panel.querySelector(".lb-yours");
    box.textContent = "";
    yours.textContent = "";
    var b = current();
    var sub = panel.querySelector(".lb-sub");
    if (!b) {
      sub.textContent = data && data.season ? data.season.name : "";
      box.appendChild(el("div", "lb-hint", data && data.error ? "The leaderboard is unavailable right now." : "Loading..."));
      panel.querySelector(".lb-foot").textContent = "";
      return;
    }
    sub.textContent = data.season.name + " · " + plural(b.players, "player", "players") + " on this board";
    panel.querySelector(".lb-foot").textContent = hintText(board);
    if (!b.top.length) box.appendChild(el("div", "lb-hint", board === "ranked" ? "No ranked ratings this season yet. Be the first." : "Nobody is on this board yet. Be the first."));
    var mine = null;
    for (var j = 0; j < b.top.length; j++) {
      var me = data.you && b.top[j].username === data.you;
      var r = row(board, b.top[j], me, false);
      if (me) mine = r;
      box.appendChild(r);
    }
    // Your own row, pinned under the list.
    yours.appendChild(el("div", "lb-label", "You"));
    if (b.you) yours.appendChild(row(board, b.you, true, !b.you.position));
    else yours.appendChild(el("div", "lb-hint", "Sign in with your account to appear on the leaderboard."));
    box.scrollTop = 0;
    if (mine && mine.offsetTop > box.clientHeight) box.scrollTop = mine.offsetTop - box.clientHeight / 2;
  }

  function buildPanel() {
    if (panel) return panel;
    style();
    panel = el("section", "hidden");
    panel.id = "remaster-leaderboard";
    // Mouse drags over the menu turn the character; not over this panel.
    panel.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    var p = el("div", "lb-panel");
    p.innerHTML = '<div class="lb-close">X</div><div class="lb-title">Leaderboard</div><div class="lb-sub"></div>' +
      '<div class="lb-tabs"></div>' +
      '<div class="lb-cols"><span class="lb-pos">#</span><span class="lb-who">Player</span><span class="lb-value"></span></div>' +
      '<div class="lb-scroll"></div><div class="lb-yours"></div><div class="lb-foot"></div>';
    var tabs = p.querySelector(".lb-tabs");
    ORDER.forEach(function (id) {
      var t = el("span", "lb-tab", BOARDS[id].tab);
      t.setAttribute("data-board", id);
      t.addEventListener("click", function (e) { e.stopPropagation(); board = id; render(); });
      tabs.appendChild(t);
    });
    panel.appendChild(p);
    document.body.appendChild(panel);
    p.querySelector(".lb-close").addEventListener("click", close);
    panel.addEventListener("click", function (e) { if (e.target === panel) close(); });
    // Escape and the gamepad's Back close a player card first, then this
    // panel: RemasterOverlay (Friends.js).
    return panel;
  }

  // What the gamepad focus ring moves over: the tabs, the rows, your row, close.
  function items() {
    var out = [], n = panel.querySelectorAll(".lb-tab, .lb-scroll .lb-row, .lb-yours .lb-row");
    for (var i = 0; i < n.length; i++) out.push(n[i]);
    out.push(panel.querySelector(".lb-close"));
    return out;
  }

  // LT/RT: the previous or next board.
  function page(d) {
    var i = ORDER.indexOf(board) + d;
    if (i < 0 || i >= ORDER.length) return;
    board = ORDER[i];
    render();
  }

  function ask() {
    clearTimeout(retry);
    if (!emit("remaster-leaderboard-get")) {
      data = data || { error: "offline" };
      render();
    }
  }

  function open() {
    buildPanel().className = "";
    if (window.RemasterOverlay) RemasterOverlay.open(panel, { close: close, items: items, page: page,
      initial: ORDER.indexOf(board) });
    render();
    ask();
  }

  function close() {
    if (panel) panel.className = "hidden";
    clearTimeout(retry);
    if (window.RemasterOverlay) RemasterOverlay.close(panel);
  }

  function on(msg) {
    msg = msg || {};
    if (msg.error) {
      // Asked too often: keep what is shown, and ask again shortly if nothing is.
      if (!current() && panel && panel.className !== "hidden") retry = setTimeout(ask, 2500);
      return;
    }
    data = msg;
    render();
  }

  window.RemasterLeaderboard = { open: open, close: close, on: on, show: function (id) { if (BOARDS[id]) board = id; open(); } };

  // The main menu's LEADERBOARD item opens the panel.
  if (typeof BaseMenuScreen != "undefined") {
    var selected = BaseMenuScreen.prototype.OnOptionElemSelected;
    BaseMenuScreen.prototype.OnOptionElemSelected = function (elem) {
      if (elem && elem.id == "remaster-leaderboard-item") return open();
      return selected.apply(this, arguments);
    };
  }
})();
