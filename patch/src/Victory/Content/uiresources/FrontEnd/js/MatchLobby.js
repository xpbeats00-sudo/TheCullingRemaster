// The Culling Remaster: matchmaking lobby.
// While searching, the server sends "remaster-lobby" (server/matchlobby.js):
// everyone in the same playlist's lobby with their calling card, level, rank
// and name, the lobby's state, and the countdown. This panel shows it on the
// right of the menu, in place of a bare "players queued" count:
//   SEARCHING -> PLAYERS FOUND -> STARTING MATCH 0:04
// Self-contained: builds its own markup and styles (only .js files are kept
// in the patch tree), so it can also be previewed outside the game.
(function () {
  var MODES = { ffa: "Solo", coop2: "Duo", lightning: "Lightning", ranked_ffa: "Ranked Solo" };
  var ROWS = 10;                    // rows that fit under the player card at any resolution
  var CSS = [
    "#remaster-lobby { position: absolute; right: 2.6vw; top: 21vh; width: 25vw; max-height: 72vh; z-index: 40;",
    "  font-family: Sucrose-Regular, Arial, sans-serif; color: rgba(235, 235, 235, 1); pointer-events: none; }",
    "#remaster-lobby.hidden { display: none; }",
    "#remaster-lobby .rl-head { padding: 1.2vh 1vw 1vh; background: linear-gradient(90deg, rgba(10, 6, 8, 0.92), rgba(10, 6, 8, 0.72));",
    "  border-left: 0.3vw solid rgba(204, 0, 0, 1); }",
    "#remaster-lobby .rl-state { font: 2.6vw Creepster, Impact, sans-serif; letter-spacing: 0.15vw; line-height: 1; color: rgba(204, 0, 0, 1); }",
    "#remaster-lobby .rl-sub { display: flex; justify-content: space-between; align-items: baseline; margin-top: 0.6vh;",
    "  font: 0.85vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.08vw; text-transform: uppercase; opacity: 0.85; }",
    "#remaster-lobby .rl-clock { font: 1.6vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.05vw; opacity: 1; color: white; }",
    "#remaster-lobby .rl-list { list-style: none; margin: 0.5vh 0 0; padding: 0; }",
    "#remaster-lobby .rl-row { position: relative; display: flex; align-items: center; height: 4.6vh; margin-top: 0.4vh;",
    "  background-color: rgba(18, 14, 16, 0.86); background-size: cover; background-position: center; overflow: hidden; }",
    "#remaster-lobby .rl-row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 70%;",
    "  background: linear-gradient(90deg, rgba(8, 6, 8, 0.92), rgba(8, 6, 8, 0)); }",
    "#remaster-lobby .rl-row > * { position: relative; }",
    "#remaster-lobby .rl-level { width: 2.8vw; text-align: center; font: 1.3vw Sucrose-Bold, Arial, sans-serif; }",
    "#remaster-lobby .rl-name { flex: 1 1 auto; font: 1.1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.05vw;",
    "  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 0 0.4vh black; }",
    "#remaster-lobby .rl-rank { width: 2.4vw; height: 2.4vw; margin-right: 0.5vw; flex: 0 0 auto; }",
    "#remaster-lobby .rl-row.me { box-shadow: inset 0.25vw 0 0 rgba(204, 0, 0, 1); }",
    "#remaster-lobby .rl-row.empty { background: rgba(18, 14, 16, 0.55); border: 1px dashed rgba(255, 255, 255, 0.14); }",
    "#remaster-lobby .rl-row.empty::before { display: none; }",
    "#remaster-lobby .rl-row.more { background: rgba(18, 14, 16, 0.75); }",
    "#remaster-lobby .rl-row.more::before { display: none; }",
    "#remaster-lobby .rl-row.empty .rl-name { font: 0.85vw Sucrose-Regular, Arial, sans-serif; opacity: 0.55; letter-spacing: 0.1vw; text-transform: uppercase; }",
    "#remaster-lobby .rl-row.joined { animation: rl-in 0.35s ease-out; }",
    "@keyframes rl-in { from { opacity: 0; transform: translateX(1.5vw); } to { opacity: 1; transform: none; } }",
    "#remaster-lobby .rl-note { margin-top: 0.8vh; font-size: 0.75vw; opacity: 0.6; text-align: right; }"
  ].join("\n");

  var panel = null, last = null, received = 0, ticker = null, shownNames = {};

  function build() {
    if (panel) return panel;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    panel = document.createElement("section");
    panel.id = "remaster-lobby";
    panel.className = "hidden";
    panel.innerHTML = '<div class="rl-head"><div class="rl-state"></div>' +
      '<div class="rl-sub"><span class="rl-what"></span><span class="rl-clock"></span></div></div>' +
      '<ul class="rl-list"></ul><div class="rl-note"></div>';
    document.body.appendChild(panel);
    return panel;
  }

  function cardImage(cardID) {
    var name = (typeof CullingCardImages != "undefined") ? CullingCardImages[String(cardID)] : null;
    return name ? 'url("/images/culling-cards/' + name + '.png")' : "none";
  }

  function myName() {
    return (typeof PlayerProfileData != "undefined" && PlayerProfileData.Nickname) ? String(PlayerProfileData.Nickname) : null;
  }

  function clock(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  function text(el, value) { el.textContent = value; return el; }

  function row(p, me) {
    var li = document.createElement("li");
    li.className = "rl-row" + (me ? " me" : "") + (shownNames[p.name] ? "" : " joined");
    li.style.backgroundImage = cardImage(p.cardID);
    li.appendChild(text(document.createElement("span"), String(p.level || 1))).className = "rl-level";
    li.appendChild(text(document.createElement("span"), p.name || "Player")).className = "rl-name";
    if (p.rank) {
      var img = document.createElement("img");
      img.className = "rl-rank";
      img.src = "/images/ranked/" + String(p.rank).toLowerCase() + ".png";
      img.alt = p.rank;
      li.appendChild(img);
    }
    return li;
  }

  function emptyRow() {
    var li = document.createElement("li");
    li.className = "rl-row empty";
    li.appendChild(document.createElement("span")).className = "rl-level";
    li.appendChild(text(document.createElement("span"), "Looking for player...")).className = "rl-name";
    return li;
  }

  // The header: state, what's being searched, and the clock.
  function renderHead() {
    var l = last, el = build();
    var elapsed = Date.now() - received;
    var state, what, time;
    if (l.state === "starting" || l.state === "started") {
      state = "Starting Match";
      what = "Get ready";
      time = clock((l.startsInMs || 0) - elapsed);
    } else {
      state = l.players.length > 1 ? "Players Found" : "Searching";
      what = l.players.length + "/" + l.maxPlayers + " players";
      time = clock((l.searchingMs || 0) + elapsed);
    }
    text(el.querySelector(".rl-state"), state);
    text(el.querySelector(".rl-what"), (MODES[l.queue] || l.queue) + " · " + what);
    text(el.querySelector(".rl-clock"), time);
  }

  function render(lobby) {
    last = lobby;
    received = Date.now();
    var el = build();
    var list = el.querySelector(".rl-list");
    var me = myName();
    list.textContent = "";
    var names = {};
    // A full lobby of 16 doesn't fit: the last row counts the rest.
    var shown = lobby.players.length > ROWS ? ROWS - 1 : lobby.players.length;
    for (var i = 0; i < lobby.players.length; i++) {
      var p = lobby.players[i];
      if (i < shown) list.appendChild(row(p, me && p.name === me));
      names[p.name] = true;
    }
    if (shown < lobby.players.length) {
      var more = emptyRow();
      more.className = "rl-row more";
      text(more.querySelector(".rl-name"), "+" + (lobby.players.length - shown) + " more players");
      list.appendChild(more);
    }
    // Open slots while the lobby still takes players, up to ROWS in all.
    if (lobby.state === "searching") {
      var open = Math.min(lobby.maxPlayers, ROWS) - Math.min(lobby.players.length, ROWS);
      for (var j = 0; j < open; j++) list.appendChild(emptyRow());
    }
    shownNames = names;
    text(el.querySelector(".rl-note"), lobby.note || "");
    renderHead();
    el.className = "";
    if (!ticker) ticker = setInterval(function () { if (last) renderHead(); }, 250);
  }

  function hide() {
    if (panel) panel.className = "hidden";
    last = null;
    shownNames = {};
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  window.RemasterLobby = { show: render, hide: hide };

  // Leaving the queue (cancel, forced) hides the lobby; ClientWeb.js hides it
  // on match-ready too.
  if (typeof StoppedMatchmaking == "function") {
    var stopped = StoppedMatchmaking;
    window.StoppedMatchmaking = function () { hide(); return stopped.apply(this, arguments); };
  }
})();
