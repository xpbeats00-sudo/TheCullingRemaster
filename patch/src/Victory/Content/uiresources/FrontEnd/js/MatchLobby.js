// The Culling Remaster: matchmaking lobby.
// While searching, the server sends "remaster-lobby" (server/matchlobby.js):
// everyone in the playlist's lobby with their calling card, level, rank and
// name, each player's map vote, the vote count per map, the lobby's state and
// its countdown. This screen shows it over the menu, in two columns:
//   left:  SEARCHING / PLAYERS FOUND / STARTING MATCH, the playlist, the clock,
//          and the map vote (Jungle or Prison; click to vote, until the
//          countdown locks the winner in);
//   right: the players, each on their calling card.
// Self-contained: builds its own markup and styles (only .js files are kept
// in the patch tree), so it can also be previewed outside the game.
(function () {
  var MODES = { ffa: "Solo Play", coop2: "Duo Play", lightning: "Lightning", ranked_ffa: "Ranked Solo" };
  var MAPS = { jungle: { name: "Jungle", image: "images/Jungle_Map.png" }, prison: { name: "Prison", image: "images/Prison_Map.png" } };
  var ROWS = 10;                    // player rows that fit at any resolution
  var CSS = [
    "#remaster-lobby { position: absolute; right: 2.6vw; top: 21vh; display: flex; align-items: flex-start; z-index: 40;",
    "  font-family: Sucrose-Regular, Arial, sans-serif; color: rgba(235, 235, 235, 1); pointer-events: none; }",
    "#remaster-lobby.hidden { display: none; }",
    "#remaster-lobby .rl-side { width: 21vw; margin-right: 1.2vw; }",
    "#remaster-lobby .rl-head { padding: 1.4vh 1vw 1.2vh; background: linear-gradient(90deg, rgba(10, 6, 8, 0.94), rgba(10, 6, 8, 0.76));",
    "  border-left: 0.3vw solid rgba(204, 0, 0, 1); }",
    "#remaster-lobby .rl-state { font: 2.7vw Creepster, Impact, sans-serif; letter-spacing: 0.15vw; line-height: 1; color: rgba(204, 0, 0, 1); }",
    "#remaster-lobby .rl-what { margin-top: 0.8vh; font: 0.9vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.1vw; text-transform: uppercase; opacity: 0.85; }",
    "#remaster-lobby .rl-clock { margin-top: 0.4vh; font: 2.2vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.05vw; color: white; }",
    "#remaster-lobby .rl-maps-title { margin: 1.4vh 0 0.6vh; font: 0.85vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.12vw;",
    "  text-transform: uppercase; opacity: 0.75; }",
    "#remaster-lobby .rl-maps { display: flex; }",
    "#remaster-lobby .rl-map { position: relative; flex: 1 1 0; height: 11vh; margin-right: 0.6vw; background-size: cover;",
    "  background-position: center; background-color: rgba(18, 14, 16, 0.86); border: 0.15vw solid rgba(255, 255, 255, 0.12);",
    "  pointer-events: all; cursor: pointer; transition: border-color 0.15s, filter 0.15s, opacity 0.15s; }",
    "#remaster-lobby .rl-map:last-child { margin-right: 0; }",
    "#remaster-lobby .rl-map::before { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 70%;",
    "  background: linear-gradient(0deg, rgba(8, 6, 8, 0.92), rgba(8, 6, 8, 0)); }",
    "#remaster-lobby .rl-map > * { position: absolute; }",
    "#remaster-lobby .rl-map:hover { border-color: rgba(255, 255, 255, 0.45); }",
    "#remaster-lobby .rl-map.mine { border-color: rgba(204, 0, 0, 1); box-shadow: 0 0 1.6vh rgba(204, 0, 0, 0.55); }",
    "#remaster-lobby .rl-map.locked { cursor: default; }",
    "#remaster-lobby .rl-map.lost { opacity: 0.35; filter: grayscale(1); }",
    "#remaster-lobby .rl-map.won { border-color: rgba(204, 0, 0, 1); box-shadow: 0 0 2.4vh rgba(204, 0, 0, 0.75); }",
    "#remaster-lobby .rl-map-name { left: 0.6vw; bottom: 0.8vh; font: 1.5vw Creepster, Impact, sans-serif; letter-spacing: 0.1vw; }",
    "#remaster-lobby .rl-map-votes { right: 0.6vw; bottom: 1vh; font: 0.85vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.05vw; }",
    "#remaster-lobby .rl-map-tag { left: 0.6vw; top: 0.7vh; padding: 0.2vh 0.4vw; font: 0.7vw Sucrose-Bold, Arial, sans-serif;",
    "  letter-spacing: 0.1vw; text-transform: uppercase; background: rgba(204, 0, 0, 1); }",
    "#remaster-lobby .rl-map-tag:empty { display: none; }",
    "#remaster-lobby .rl-cancel { display: inline-block; margin-top: 1.4vh; padding: 0.8vh 1vw; font: 0.85vw Sucrose-Bold, Arial, sans-serif;",
    "  letter-spacing: 0.12vw; text-transform: uppercase; border: 0.12vw solid rgba(255, 255, 255, 0.6); pointer-events: all; cursor: pointer; }",
    "#remaster-lobby .rl-cancel:hover { border-color: rgba(204, 0, 0, 1); color: white; background: rgba(204, 0, 0, 0.35); }",
    "#remaster-lobby .rl-note { margin-top: 1.2vh; font-size: 0.75vw; opacity: 0.6; }",
    "#remaster-lobby .rl-players { width: 25vw; }",
    "#remaster-lobby .rl-players-title { padding: 1vh 1vw; font: 0.85vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.12vw; text-transform: uppercase;",
    "  background: rgba(10, 6, 8, 0.86); display: flex; justify-content: space-between; }",
    "#remaster-lobby .rl-list { list-style: none; margin: 0; padding: 0; }",
    "#remaster-lobby .rl-row { position: relative; display: flex; align-items: center; height: 4.6vh; margin-top: 0.4vh;",
    "  background-color: rgba(18, 14, 16, 0.86); background-size: cover; background-position: center; overflow: hidden; }",
    "#remaster-lobby .rl-row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 70%;",
    "  background: linear-gradient(90deg, rgba(8, 6, 8, 0.92), rgba(8, 6, 8, 0)); }",
    "#remaster-lobby .rl-row > * { position: relative; }",
    "#remaster-lobby .rl-level { width: 2.8vw; text-align: center; font: 1.3vw Sucrose-Bold, Arial, sans-serif; }",
    "#remaster-lobby .rl-name { flex: 1 1 auto; font: 1.1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.05vw;",
    "  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 0 0.4vh black; }",
    "#remaster-lobby .rl-vote { margin-right: 0.5vw; padding: 0.15vh 0.35vw; font: 0.65vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.08vw;",
    "  text-transform: uppercase; background: rgba(8, 6, 8, 0.75); border: 1px solid rgba(255, 255, 255, 0.25); }",
    "#remaster-lobby .rl-rank { width: 2.4vw; height: 2.4vw; margin-right: 0.5vw; flex: 0 0 auto; }",
    "#remaster-lobby .rl-row.me { box-shadow: inset 0.25vw 0 0 rgba(204, 0, 0, 1); }",
    "#remaster-lobby .rl-row.empty { background: rgba(18, 14, 16, 0.55); border: 1px dashed rgba(255, 255, 255, 0.14); }",
    "#remaster-lobby .rl-row.empty::before, #remaster-lobby .rl-row.more::before { display: none; }",
    "#remaster-lobby .rl-row.more { background: rgba(18, 14, 16, 0.75); border: 0; }",
    "#remaster-lobby .rl-row.empty .rl-name { font: 0.85vw Sucrose-Regular, Arial, sans-serif; opacity: 0.55; letter-spacing: 0.1vw; text-transform: uppercase; }",
    "#remaster-lobby .rl-row.joined { animation: rl-in 0.35s ease-out; }",
    "@keyframes rl-in { from { opacity: 0; transform: translateX(1.5vw); } to { opacity: 1; transform: none; } }"
  ].join("\n");

  var panel = null, last = null, received = 0, ticker = null, shownNames = {};

  function el(tag, cls, textValue) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (textValue != null) e.textContent = textValue;
    return e;
  }

  function build() {
    if (panel) return panel;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    panel = el("section", "hidden");
    panel.id = "remaster-lobby";
    panel.innerHTML =
      '<div class="rl-side"><div class="rl-head"><div class="rl-state"></div><div class="rl-what"></div><div class="rl-clock"></div></div>' +
      '<div class="rl-maps-title"></div><div class="rl-maps"></div>' +
      '<div class="rl-cancel">Cancel search</div><div class="rl-note"></div></div>' +
      '<div class="rl-players"><div class="rl-players-title"><span>Players</span><span class="rl-count"></span></div><ul class="rl-list"></ul></div>';
    panel.querySelector(".rl-cancel").addEventListener("click", function () {
      if (typeof OnCancelMatchmaking == "function") OnCancelMatchmaking();
      else if (typeof LeaveMatchmaking == "function") LeaveMatchmaking();
    });
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

  function myVote() {
    var me = myName();
    if (!last || !me) return null;
    for (var i = 0; i < last.players.length; i++) if (last.players[i].name === me) return last.players[i].vote || null;
    return null;
  }

  function clock(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  function vote(map) {
    if (!last || last.state !== "searching") return;
    try { if (typeof socketConnection != "undefined" && socketConnection) socketConnection.emit("lobby-vote-map", { map: map }); } catch (e) { /* offline */ }
  }

  function row(p, me) {
    var li = el("li", "rl-row" + (me ? " me" : "") + (shownNames[p.name] ? "" : " joined"));
    li.style.backgroundImage = cardImage(p.cardID);
    li.appendChild(el("span", "rl-level", String(p.level || 1)));
    li.appendChild(el("span", "rl-name", p.name || "Player"));
    if (p.vote && MAPS[p.vote]) li.appendChild(el("span", "rl-vote", MAPS[p.vote].name));
    if (p.rank) {
      var img = el("img", "rl-rank");
      img.src = "/images/ranked/" + String(p.rank).toLowerCase() + ".png";
      img.alt = p.rank;
      li.appendChild(img);
    }
    return li;
  }

  function emptyRow(textValue) {
    var li = el("li", "rl-row empty");
    li.appendChild(el("span", "rl-level"));
    li.appendChild(el("span", "rl-name", textValue || "Looking for player..."));
    return li;
  }

  // The map vote cards: votes per map, your vote, and once locked the winner.
  function renderMaps() {
    var root = build();
    var box = root.querySelector(".rl-maps");
    var title = root.querySelector(".rl-maps-title");
    box.textContent = "";
    var votes = last.maps;
    title.style.display = votes ? "" : "none";
    if (!votes) return;
    var locked = last.state !== "searching";
    var mine = myVote();
    title.textContent = locked ? "Map" : "Vote for the map";
    Object.keys(MAPS).forEach(function (id) {
      if (!(id in votes)) return;
      var card = el("div", "rl-map" + (locked ? " locked" + (last.map === id ? " won" : " lost") : (mine === id ? " mine" : "")));
      card.style.backgroundImage = 'url("' + MAPS[id].image + '")';
      card.appendChild(el("span", "rl-map-tag", locked ? (last.map === id ? "Selected" : "") : (mine === id ? "Your vote" : "")));
      card.appendChild(el("span", "rl-map-name", MAPS[id].name));
      card.appendChild(el("span", "rl-map-votes", votes[id] + (votes[id] === 1 ? " vote" : " votes")));
      if (!locked) card.addEventListener("click", function () { vote(id); });
      box.appendChild(card);
    });
  }

  // The header: state, playlist, and the clock.
  function renderHead() {
    var root = build();
    var elapsed = Date.now() - received;
    var state, what, time;
    if (last.state === "starting" || last.state === "started") {
      state = "Starting Match";
      what = (MODES[last.queue] || last.queue) + (last.map && MAPS[last.map] ? " · " + MAPS[last.map].name : "");
      time = clock((last.startsInMs || 0) - elapsed);
    } else {
      state = last.players.length > 1 ? "Players Found" : "Searching";
      what = (MODES[last.queue] || last.queue) + " · " + (last.players.length > 1 ? "searching for more" : "searching for players");
      time = clock((last.searchingMs || 0) + elapsed);
    }
    root.querySelector(".rl-state").textContent = state;
    root.querySelector(".rl-what").textContent = what;
    root.querySelector(".rl-clock").textContent = time;
  }

  function render(lobby) {
    last = lobby;
    received = Date.now();
    var root = build();
    var list = root.querySelector(".rl-list");
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
      var more = emptyRow("+" + (lobby.players.length - shown) + " more players");
      more.className = "rl-row more";
      list.appendChild(more);
    }
    // Open slots while the lobby still takes players, up to ROWS in all.
    if (lobby.state === "searching") {
      var open = Math.min(lobby.maxPlayers, ROWS) - Math.min(lobby.players.length, ROWS);
      for (var j = 0; j < open; j++) list.appendChild(emptyRow());
    }
    shownNames = names;
    root.querySelector(".rl-count").textContent = lobby.players.length + "/" + lobby.maxPlayers;
    root.querySelector(".rl-note").textContent = lobby.note || "";
    root.querySelector(".rl-cancel").style.display = lobby.state === "searching" ? "" : "none";
    renderMaps();
    renderHead();
    root.className = "";
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
