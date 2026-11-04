// The Culling Remaster: matchmaking lobby.
// While searching, the server sends "remaster-lobby" (server/matchlobby.js):
// everyone in the playlist's lobby with their calling card, level, rank and
// name, each player's map vote, the vote count per map, the lobby's state and
// its countdown. This screen shows it over the menu:
//   top middle:    SEARCHING / PLAYERS FOUND / PREGAME LOBBY, the playlist,
//                  the clock and Cancel search (in place of the stock widget);
//   bottom middle: the map vote (Jungle or Prison; click to vote, until the
//                  countdown locks the winner in);
//   right:         the players, each on their calling card (animated cards play,
//          through AnimatedCards.js).
// When the countdown starts it becomes the pregame lobby: the map is locked
// and the right column is the roster of the match about to load, you and the
// bots the game fills it with (matches run on each player's PC, so the other
// players in the lobby start their own); the bots are shown like players,
// with a name, a level and sometimes a rank. It replaces the stock queue widget
// while it is up.
// Self-contained: builds its own markup and styles (only .js files are kept
// in the patch tree), so it can also be previewed outside the game.
(function () {
  var MODES = { ffa: "Solo Play", coop2: "Duo Play", lightning: "Lightning", ranked_ffa: "Ranked Solo" };
  var MAPS = { jungle: { name: "Jungle", image: "images/Jungle_Map.png" }, prison: { name: "Prison", image: "images/Prison_Map.png" } };
  var ROWS = 10;                    // player rows that fit at any resolution
  // The bots' names: the same list the game draws from in the match
  // (patch_assets.py BOT_NAMES, VictoryGameMode's BotNames).
  var BOT_NAMES = ["Dominoss", "Bigred", "Riskybixnew", "Bongzilla", "Billybobjrjr", "999Jay", "Slugling",
    "Sunsetwayboy", "HopelesslyNameless", "Arky", "ShadowRick",
    "Tony The Ninja", "Mandroid 5000", "Lord Xeinous", "Dr. Bonesaw", "Big Purp", "Frank",
    "Viper Kid", "MossyBoots", "GrimJoe", "Kilowatt", "NoScopeNana", "Rusty Spoon", "The Barber", "Pyrelord"];
  var CSS = [
    // Three parts over the menu: the state at the top middle (where the stock
    // queue widget sits; it is hidden while this is up), the map vote at the
    // bottom middle, the players (and in the pregame lobby, the bots) on the right.
    "#remaster-lobby { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 40; font-family: Sucrose-Regular, Arial, sans-serif; color: rgba(235, 235, 235, 1); pointer-events: none; }",
    "#remaster-lobby.hidden { display: none; }",
    "body.rl-on #queue-widget { display: none !important; }",
    "#remaster-lobby .rl-top { position: absolute; top: 1.8vh; left: 50%; transform: translateX(-50%); display: flex; align-items: center; padding: 0.8vh 0.8vw 0.8vh 1.3vw; border-radius: 4vh; white-space: nowrap; background: rgba(10, 6, 8, 0.82); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 0.6vh 2vh rgba(0, 0, 0, 0.5); }",
    "#remaster-lobby .rl-state { display: flex; align-items: center; font: 1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.18vw; text-transform: uppercase; white-space: nowrap; color: rgba(255, 70, 60, 1); }",
    "#remaster-lobby .rl-state:before { content: \"\"; display: inline-block; width: 0.55vw; height: 0.55vw; margin-right: 0.6vw; border-radius: 50%; background: rgba(255, 70, 60, 1); animation: rl-pulse 1.2s ease-in-out infinite; }",
    "@keyframes rl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }",
    "#remaster-lobby .rl-what { margin-left: 1vw; font: 0.75vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.1vw; text-transform: uppercase; opacity: 0.7; }",
    "#remaster-lobby .rl-clock { margin-left: 1vw; min-width: 2.6vw; font: 1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.05vw; text-align: center; color: white; }",
    "#remaster-lobby .rl-cancel { display: inline-block; margin-left: 1vw; padding: 0.55vh 1vw; border-radius: 3vh; font: 0.68vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.12vw; text-transform: uppercase; background: rgba(255, 255, 255, 0.1); pointer-events: all; cursor: pointer; transition: background 0.15s; }",
    "#remaster-lobby .rl-cancel:hover { background: rgba(204, 0, 0, 0.9); color: white; }",
    "#remaster-lobby .rl-bottom { position: absolute; bottom: 6vh; left: 50%; transform: translateX(-50%); width: 32vw; text-align: center; }",
    "#remaster-lobby .rl-maps-title { margin-bottom: 0.8vh; font: 0.85vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.14vw; text-transform: uppercase; text-shadow: 0 0 0.6vh black; }",
    "#remaster-lobby .rl-maps { display: flex; }",
    "#remaster-lobby .rl-map { position: relative; flex: 1 1 0; height: 13vh; margin-right: 1vw; border-radius: 1.6vh; overflow: hidden; background-size: cover; background-position: center; background-color: rgba(18, 14, 16, 0.86); box-shadow: 0 0 0 0.15vw rgba(255, 255, 255, 0.15); pointer-events: all; cursor: pointer; transition: box-shadow 0.15s, filter 0.15s, opacity 0.15s; }",
    "#remaster-lobby .rl-map:last-child { margin-right: 0; }",
    "#remaster-lobby .rl-map::before { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 70%; background: linear-gradient(0deg, rgba(8, 6, 8, 0.92), rgba(8, 6, 8, 0)); }",
    "#remaster-lobby .rl-map > * { position: absolute; }",
    "#remaster-lobby .rl-map:hover { box-shadow: 0 0 0 0.15vw rgba(255, 255, 255, 0.5); }",
    "#remaster-lobby .rl-map.mine { box-shadow: 0 0 0 0.2vw rgba(204, 0, 0, 1), 0 0 1.8vh rgba(204, 0, 0, 0.6); }",
    "#remaster-lobby .rl-map.locked { cursor: default; }",
    "#remaster-lobby .rl-map.lost { opacity: 0.35; filter: grayscale(1); }",
    "#remaster-lobby .rl-map.won { box-shadow: 0 0 0 0.2vw rgba(204, 0, 0, 1), 0 0 2.6vh rgba(204, 0, 0, 0.8); }",
    "#remaster-lobby .rl-map-name { left: 0.9vw; bottom: 1vh; font: 1.7vw Creepster, Impact, sans-serif; letter-spacing: 0.1vw; }",
    "#remaster-lobby .rl-map-votes { right: 0.9vw; bottom: 1.3vh; font: 0.85vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.05vw; }",
    "#remaster-lobby .rl-map-tag { left: 0.9vw; top: 1vh; padding: 0.25vh 0.6vw; border-radius: 2vh; font: 0.7vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.1vw; text-transform: uppercase; background: rgba(204, 0, 0, 1); }",
    "#remaster-lobby .rl-map-tag:empty { display: none; }",
    "#remaster-lobby .rl-note { margin-top: 1vh; font-size: 0.75vw; opacity: 0.7; text-shadow: 0 0 0.6vh black; }",
    "#remaster-lobby .rl-players { position: absolute; right: 2.6vw; top: 21vh; width: 25vw; }",
    "#remaster-lobby .rl-players-title { padding: 1vh 1.1vw; border-radius: 1.2vh; font: 0.85vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.12vw; text-transform: uppercase; background: rgba(10, 6, 8, 0.88); display: flex; justify-content: space-between; }",
    "#remaster-lobby .rl-list { list-style: none; margin: 0; padding: 0; }",
    "#remaster-lobby .rl-row { position: relative; display: flex; align-items: center; height: 4.6vh; margin-top: 0.5vh; border-radius: 1.2vh; background-color: rgba(18, 14, 16, 0.86); background-size: cover; background-position: center; overflow: hidden; }",
    "#remaster-lobby .rl-row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 70%; background: linear-gradient(90deg, rgba(8, 6, 8, 0.92), rgba(8, 6, 8, 0)); }",
    "#remaster-lobby .rl-row > * { position: relative; }",
    "#remaster-lobby .rl-level { width: 2.8vw; text-align: center; font: 1.3vw Sucrose-Bold, Arial, sans-serif; }",
    "#remaster-lobby .rl-name { flex: 1 1 auto; font: 1.1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.05vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 0 0.4vh black; }",
    "#remaster-lobby .rl-vote { margin-right: 0.5vw; padding: 0.2vh 0.5vw; border-radius: 2vh; font: 0.65vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.08vw; text-transform: uppercase; background: rgba(8, 6, 8, 0.75); border: 1px solid rgba(255, 255, 255, 0.25); }",
    "#remaster-lobby .rl-rank { width: 2.4vw; height: 2.4vw; margin-right: 0.5vw; flex: 0 0 auto; }",
    "#remaster-lobby .rl-row.me { box-shadow: inset 0 0 0 0.15vw rgba(204, 0, 0, 1); }",
    "#remaster-lobby .rl-row.empty { background: rgba(18, 14, 16, 0.55); border: 1px dashed rgba(255, 255, 255, 0.16); }",
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
      '<div class="rl-top"><div class="rl-state"></div><div class="rl-what"></div><div class="rl-clock"></div>' +
      '<div class="rl-cancel">Cancel search</div></div>' +
      '<div class="rl-bottom"><div class="rl-maps-title"></div><div class="rl-maps"></div><div class="rl-note"></div></div>' +
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

  function animate(li) {
    if (typeof TrackCullingCardElement == "function") TrackCullingCardElement(li);
  }

  function row(p, me) {
    var li = el("li", "rl-row" + (me ? " me" : "") + (shownNames[p.name] ? "" : " joined"));
    li.style.backgroundImage = cardImage(p.cardID);
    animate(li);
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

  function botCards(seed, count) {
    var all = [], animated = [];
    if (typeof CullingCardImages != "undefined") {
      for (var id in CullingCardImages) {
        all.push(id);
        if (typeof AnimatedCullingCards != "undefined" && AnimatedCullingCards[CullingCardImages[id]]) animated.push(id);
      }
    }
    var cards = [], x = seed * 9301 + 49297;
    function pick(list) { x = (x * 9301 + 49297) % 233280; return list.length ? list[Math.floor(x / 233280 * list.length)] : 0; }
    for (var i = 0; i < count; i++) cards.push(i < 3 && animated.length ? pick(animated) : pick(all));
    return cards;
  }

  function botNames(seed, count) {
    var names = BOT_NAMES.slice(), x = seed * 7919 + 104729;
    for (var i = names.length - 1; i > 0; i--) {
      x = (x * 9301 + 49297) % 233280;
      var j = Math.floor(x / 233280 * (i + 1)), t = names[i];
      names[i] = names[j]; names[j] = t;
    }
    var out = [];
    for (var k = 0; k < count; k++) out.push(names[k % names.length]);
    return out;
  }

  // The season just opened: no contestant is above level 14 or rank T4 (Hunter).
  var RANKS = ["Scrapper", "Contender", "Blooded", "Hunter"];
  var MAX_LEVEL = 14;

  // A contestant row like a player's: level, name and, for some, a rank.
  function botRow(name, cardID, seed) {
    var li = el("li", "rl-row" + (shownNames["bot " + name] ? "" : " joined"));
    li.style.backgroundImage = cardImage(cardID);
    animate(li);
    // From the name and the lobby (djb2), so levels and ranks look unrelated.
    var key = name + "#" + seed, x = 5381;
    for (var c = 0; c < key.length; c++) x = (x * 33 + key.charCodeAt(c)) % 2147483647;
    x = x % 233280;
    li.appendChild(el("span", "rl-level", String(1 + Math.floor(x / 233280 * MAX_LEVEL))));
    li.appendChild(el("span", "rl-name", name));
    if (x % 3 === 0) {
      var tier = RANKS[x % RANKS.length];
      var img = el("img", "rl-rank");
      img.src = "/images/ranked/" + tier.toLowerCase() + ".png";
      img.alt = tier;
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
      state = "Pregame Lobby";
      what = (MODES[last.queue] || last.queue) + (last.map && MAPS[last.map] ? " · " + MAPS[last.map].name : "");
      time = clock((last.startsInMs || 0) - elapsed);
    } else {
      state = last.players.length > 1 ? "Players Found" : "Searching";
      what = MODES[last.queue] || last.queue;
      time = clock((last.searchingMs || 0) + elapsed);
    }
    root.querySelector(".rl-state").textContent = state;
    root.querySelector(".rl-what").textContent = what;
    root.querySelector(".rl-clock").textContent = time;
  }

  // Bots in your match: how many the game places on the chosen map (24
  // contestants on Jungle, patch_exe.py), else the server's default.
  function matchBots(lobby) {
    var byMap = lobby.matchBotsByMap;
    return byMap && lobby.map && typeof byMap[lobby.map] == "number" ? byMap[lobby.map] : lobby.matchBots;
  }

  // The pregame roster: you, then the bots of your match.
  function renderRoster(lobby, list, names) {
    var count = matchBots(lobby);
    var me = myName(), you = null;
    for (var i = 0; i < lobby.players.length; i++) if (lobby.players[i].name === me) you = lobby.players[i];
    if (!you) you = lobby.players[0];
    list.appendChild(row(you, true));
    names[you.name] = true;
    var cards = botCards(lobby.id, count), bots = botNames(lobby.id, count);
    var shown = count > ROWS - 1 ? ROWS - 2 : count;
    for (var b = 0; b < shown; b++) { list.appendChild(botRow(bots[b], cards[b], lobby.id * 31 + b + 1)); names["bot " + bots[b]] = true; }
    if (shown < count) {
      var more = emptyRow("+" + (count - shown) + " more contestants");
      more.className = "rl-row more";
      list.appendChild(more);
    }
    build().querySelector(".rl-players-title").firstChild.textContent = "Your match";
    build().querySelector(".rl-count").textContent = (count + 1) + " contestants";
    build().querySelector(".rl-note").textContent = lobby.note || "";
  }

  function render(lobby) {
    last = lobby;
    received = Date.now();
    var root = build();
    var list = root.querySelector(".rl-list");
    var me = myName();
    list.textContent = "";
    var names = {};
    document.body.className = (document.body.className.replace(/\brl-on\b/g, "") + " rl-on").trim();
    if (lobby.state !== "searching" && lobby.matchBots) {
      renderRoster(lobby, list, names);
      shownNames = names;
      root.querySelector(".rl-cancel").style.display = "none";
      renderMaps();
      renderHead();
      root.className = "";
      if (!ticker) ticker = setInterval(function () { if (last) renderHead(); }, 250);
      return;
    }
    root.querySelector(".rl-players-title").firstChild.textContent = "Players";
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
    document.body.className = document.body.className.replace(/\brl-on\b/g, "").trim();
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
