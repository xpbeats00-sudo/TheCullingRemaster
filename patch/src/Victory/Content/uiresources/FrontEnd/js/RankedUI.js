// The Culling Remaster: Ranked UI.
// A rank badge under the player card on every menu screen (Ranked Solo's), and
// the Ranked screen, from the Remaster server's /api/ranked: the mode tabs
// (Solo, Duo, Trio, Quads), each showing that mode's tier, ELO, placements and
// recent matches, and the Play tile, which queues the selected mode.
// Ranked Duos, Trios and Quads (docs/RANKED_TEAMS.md) are the casual team
// matches (you and AI teammates, or your party) rated on your team's
// placement, each with a rating of its own.
// ES5 only (Coherent UI): patch/lint_es5.py.
(function () {
  var URL = (typeof REMASTER_API != "undefined" ? REMASTER_API : "http://127.0.0.1:8000/api") + "/ranked";
  var REWARDS = {
    Scrapper: "Scrapper card", Contender: "Contender card", Blooded: "Blooded card",
    Hunter: "Hunter card + Teal Current camo (all weapons)", Executioner: "Executioner card + animated card",
    Reaper: "Reaper card + Lava Storm Fireman's Axe", Warlord: "Warlord card + Abyss Lightning camo (all weapons)",
    Apex: "Apex card + animated card", Legend: "Legend card and title"
  };
  // The modes along the top of the Ranked screen (server/ranked.js MODES): the
  // queue the Play tile asks for (server/playlists.js) and the tile's words.
  var MODES = [
    { id: "solo", label: "Solo", queue: "ranked_ffa", team: 1, title: "RANKED SOLO",
      text: "Solo free-for-all. Rating moves on placement, never kills." },
    { id: "duo", label: "Duo", queue: "ranked_coop2", team: 2, title: "RANKED DUO",
      text: "Teams of two: an AI teammate, or queue with a friend. Rated on your team's placement." },
    { id: "trio", label: "Trio", queue: "ranked_coop3", team: 3, title: "RANKED TRIO",
      text: "Teams of three: AI teammates, or your party. Rated on your team's placement." },
    { id: "quad", label: "Quads", queue: "ranked_coop4", team: 4, title: "RANKED QUADS",
      text: "Teams of four: AI teammates, or your party. Rated on your team's placement." }
  ];
  var STORE = "remaster-ranked-mode";
  var last = null;
  var failed = false;                   // the last /api/ranked ask got no answer (or an error)
  var selected = "solo";
  try {
    var saved = window.localStorage ? window.localStorage.getItem(STORE) : null;
    if (saved && mode(saved)) selected = saved;
  } catch (e) { /* no storage: Solo */ }

  function mode(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
    return null;
  }

  function emblem(tier) { return "/images/ranked/" + String(tier).toLowerCase() + ".png"; }

  // The player card reads: level, rank emblem, name (Ranked Solo's rank).
  function badge(s) {
    if (!usable(s)) return;
    var card = $("#player-card .culling-card");
    if (!card.length) return;
    var img = card.find(".card-rank-emblem");
    if (!img.length) {
      // Sized inline: Coherent ignored the stylesheet size for it. Centred on
      // the row like the level and name columns (the card row is top-aligned).
      // The emblems are square, so a square box shows them whole (no object-fit:
      // Coherent doesn't support it).
      img = $('<img class="card-rank-emblem" style="width:2.6vw; height:2.6vw; max-width:2.6vw; max-height:2.6vw;' +
        ' margin:0 0.6vw 0 0; align-self:center; flex:0 0 2.6vw;">');
      card.find(".left-column").after(img);
    }
    img.attr("src", emblem(s.tier.name));
    img.attr("title", (s.placement ? "Placements " + s.placement.played + "/" + s.placement.total : s.tier.name) +
      " - " + s.rating + " ELO");
  }

  // A summary the panel can draw: a tier with a name. The lists and the
  // season a server older or newer than this menu may leave out get
  // defaults, so a missing field shows as empty instead of throwing.
  function usable(s) {
    if (!s || typeof s != "object" || !s.tier || typeof s.tier.name != "string") return false;
    var objects = function (v, ok) {
      var out = [];
      if (v && typeof v.length == "number") for (var i = 0; i < v.length; i++) if (v[i] && typeof v[i] == "object" && ok(v[i])) out.push(v[i]);
      return out;
    };
    s.recent = objects(s.recent, function () { return true; });
    s.tiers = objects(s.tiers, function (t) { return typeof t.name == "string"; });
    if (!s.season || typeof s.season != "object") s.season = { name: "", daysLeft: "-" };
    if (!s.peak || typeof s.peak != "object") s.peak = { rating: s.rating, tier: s.tier.name };
    if (typeof s.tier.progress != "number") s.tier.progress = 0;
    return true;
  }

  // Text from the server, for HTML text and attribute values (quotes too).
  function esc(t) {
    return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // A number from the server (0 when it isn't one): never markup.
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  // The selected mode's summary: the server's modes (every mode), or, from a
  // server older than the team modes, its one summary (Solo's).
  function summaryFor(s, id) {
    if (!s) return null;
    if (s.modes) return s.modes[id] || null;
    return id === "solo" ? s : null;
  }

  // The tabs: the selected one active, a click selects (the Play tile and the
  // panel follow). A tab the server doesn't offer says Soon.
  function modes() {
    var menu = document.getElementById("ranked-menu");
    if (!menu) return;
    var bar = document.getElementById("ranked-modes");
    if (!bar) {
      bar = document.createElement("section");
      bar.id = "ranked-modes";
      bar.addEventListener("click", function (ev) {
        var t = ev.target;
        while (t && t !== bar && !(t.getAttribute && t.getAttribute("data-mode"))) t = t.parentNode;
        if (t && t !== bar) select(t.getAttribute("data-mode"));
      });
      menu.appendChild(bar);
    }
    var html = "";
    for (var i = 0; i < MODES.length; i++) {
      var m = MODES[i];
      var soon = last && !summaryFor(last, m.id);
      html += '<div class="rm-tab' + (m.id === selected ? " active" : "") + '" data-mode="' + m.id + '">' + m.label +
        (soon ? "<small>Soon</small>" : "") + "</div>";
    }
    bar.innerHTML = html;
  }

  // The Ranked screen's Play tile (the stock free-for-all tile, make_branding.py
  // add_ranked) says which mode it queues.
  function tile() {
    var li = document.querySelector ? document.querySelector("#ranked-menu-options li.ranked-ffa-bg") : null;
    if (!li) return;
    var m = mode(selected);
    var h1 = li.querySelector("h1");
    if (h1) h1.textContent = m.title;
    var p = li.querySelector(".tiled-menu-rollover p");
    if (p) p.textContent = m.text;
  }

  function chip(value, label) { return '<div class="rp-chip"><b>' + esc(value) + "</b><span>" + label + "</span></div>"; }

  // No summary to show: why, and how to get one.
  function emptyText() {
    if (!(typeof ClientwebData != "undefined" && ClientwebData.AuthToken)) {
      return '<div class="rp-empty">You\'re offline. Ranked shows here once the menu is signed in.</div>';
    }
    if (failed) {
      return '<div class="rp-empty rp-retry" data-retry="1">Ranked unavailable \u2014 retry</div>';
    }
    return '<div class="rp-empty">Loading your ranked season...</div>';
  }

  function panel() {
    modes();
    tile();
    var menu = document.getElementById("ranked-menu");
    if (!menu) return;
    var box = document.getElementById("ranked-panel");
    if (!box) {
      box = document.createElement("section");
      box.id = "ranked-panel";
      box.addEventListener("click", function (ev) {
        var t = ev.target;
        while (t && t !== box && !(t.getAttribute && t.getAttribute("data-retry"))) t = t.parentNode;
        if (t && t !== box) refresh(true);
      });
      menu.appendChild(box);
    }
    var m = mode(selected);
    var s = summaryFor(last, selected);
    if (!last) {
      box.innerHTML = emptyText();
      return;
    }
    if (!usable(s)) {
      box.innerHTML = '<div class="rp-empty">' + esc("Ranked " + m.label) + " isn't on this server yet.</div>";
      return;
    }
    var team = m.team > 1;
    var rating = num(s.rating);
    var next = s.tier.next != null ? (num(s.tier.next) - rating) + " to next tier" : "Top tier";
    var title = s.placement ? "Placements " + num(s.placement.played) + "/" + num(s.placement.total) : s.tier.name;
    var recent = s.recent.slice(0, 8).map(function (e) {
      var delta = num(e.delta), up = delta >= 0;
      return '<div class="rp-row"><span>#' + num(e.placement) + (e.field ? '<small> of ' + num(e.field) + "</small>" : "") +
        (e.abandoned ? " (left)" : "") + '</span>' +
        '<span class="r ' + (up ? "up" : "down") + '">' + (up ? "+" : "") + delta + '</span>' +
        '<span class="r">' + num(e.ratingAfter) + "</span></div>";
    }).join("");
    recent = recent ? '<div class="rp-row th"><span>' + (team ? "Team place" : "Place") + '</span><span class="r">Change</span>' +
      '<span class="r">Rating</span></div>' + recent
      : '<div class="rp-empty">No Ranked ' + esc(m.label) + " matches yet this season.</div>";
    var ladder = s.tiers.map(function (t) {
      var current = t.name === s.tier.name;
      var cls = "rp-tierrow" + (t.reached ? " reached" : "") + (current ? " current" : "");
      var tag = current ? '<span class="t-tag">You</span>' : (t.reached ? '<span class="t-tag">Unlocked</span>' : "");
      return '<div class="' + cls + '"><img src="' + esc(emblem(t.name)) + '"><span class="t-name">' + esc(t.name) + "</span>" +
        '<span class="t-min">' + num(t.min) + "+</span>" + '<span class="t-reward">' + esc(REWARDS[t.name] || "") + "</span>" + tag + "</div>";
    }).join("");
    var note = team
      ? "Rated on your team's placement among the teams, never kills. A team win counts for the whole team, even if you fell early. " +
        "Each mode has its own rating. Leaving a ranked match counts as last place."
      : "Rating moves on placement, never kills. Leaving a ranked match counts as last place.";
    box.innerHTML =
      '<div class="rp-head"><img src="' + esc(emblem(s.tier.name)) + '"><div class="rp-main">' +
        '<div class="rp-season">' + esc("Ranked " + m.label).toUpperCase() + " · " + esc(s.season.name).toUpperCase() + " · " +
          (isFinite(Number(s.season.daysLeft)) ? num(s.season.daysLeft) : "-") + " DAYS LEFT</div>" +
        '<div class="rp-tier">' + esc(title).toUpperCase() + "</div>" +
        '<div class="rp-elo">' + rating + " ELO<small>" + next + "</small></div>" +
        '<div class="rp-bar"><div style="width:' + Math.max(0, Math.min(100, Math.round(num(s.tier.progress) * 100))) + '%"></div></div>' +
      "</div>" +
      '<div class="rp-chips">' + chip(num(s.peak.rating), "Peak · " + esc(s.peak.tier)) + chip(num(s.matches), "Matches") +
        chip(num(s.wins), "Wins") + "</div></div>" +
      '<div class="rp-cols">' +
        '<div class="rp-col recent"><div class="rp-h">Recent</div>' + recent + "</div>" +
        '<div class="rp-col ladder"><div class="rp-h">Rank ladder<span>Rewards</span></div>' + ladder + "</div>" +
      "</div>" +
      '<div class="rp-note">' + note + "</div>";
  }

  // A tab: the panel and the Play tile show that mode.
  function select(id) {
    if (!mode(id)) return;
    selected = id;
    try { if (window.localStorage) window.localStorage.setItem(STORE, id); } catch (e) { /* not kept */ }
    if (document.getElementById("ranked-menu")) panel();
  }

  var asked = 0;

  // bNow: the player pressed retry (not throttled).
  function refresh(bNow) {
    // Ranked is per player: send the login token the menus already hold.
    var token = typeof ClientwebData != "undefined" && ClientwebData.AuthToken;
    if (!token) {
      if (!last && document.getElementById("ranked-menu")) panel();   // offline: says so
      return;
    }
    var t = new Date().getTime();
    if (bNow !== true && t - asked < 2000) return;        // several triggers at once (sign-in, a screen showing)
    asked = t;
    failed = false;
    if (!last && document.getElementById("ranked-menu")) panel();     // Loading...
    $.ajax({ url: URL, dataType: "json", timeout: 15000, headers: { Authorization: "Bearer " + token } }).done(function (s) {
      last = s;
      failed = false;
      badge(s);
      if (document.getElementById("ranked-menu")) panel();
    }).fail(function () {
      failed = true;                              // what was shown stays; nothing yet: "unavailable - retry"
      if (document.getElementById("ranked-menu")) panel();
    });
  }

  // Asked when it can have changed, not on a timer: when the menu signs in
  // (ClientWeb.js, on auth-response: also the first time after a match, when
  // the menu loads again), when the Ranked screen shows, and when the server
  // sends the player's balance after a match result (player-response).
  var stockOnShow = RankedScreen.prototype.OnShow;
  RankedScreen.prototype.OnShow = function () {
    if (stockOnShow) stockOnShow.apply(this, arguments);
    queueing = false;
    if (document.getElementById("ranked-menu")) panel();
    refresh();
  };

  // The Play tile queues the selected mode. Solo is the stock path (Ranked.js
  // queues "ranked_ffa"); a team mode queues its playlist the same way (the
  // server sends a party's members along with its leader, or refuses with why).
  var stockSelected = RankedScreen.prototype.OnOptionElemSelected;
  var queueing = false;
  RankedScreen.prototype.OnOptionElemSelected = function (elem) {
    var m = mode(selected);
    var queue = elem && elem.dataset ? elem.dataset.queue : null;
    if (queue !== "ffa" || m.id === "solo" || Matchmaking.IsMatchmaking) {
      return stockSelected.apply(this, arguments);
    }
    // One queue per click: the queue is asked asynchronously (the login
    // ticket first), so a double click would queue twice and pop four
    // screens. Cleared by the answer, and when the screen shows again.
    if (queueing || Matchmaking.IsStartingMatchmaking) return;
    queueing = true;
    $.when(QueueMatchmaking(m.queue)).then(function (result) {
      queueing = false;
      if (result) {
        PopScreen();
        PopScreen();
      } else {
        ShowError("Failed to join the queue. Please try again.");
      }
    });
  };

  window.RemasterRanked = { refresh: refresh, select: select, selected: function () { return selected; }, modes: MODES };
  $(refresh);
})();
