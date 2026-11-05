// The Culling Remaster: Ranked UI.
// A rank badge under the player card on every menu screen, and the ranked
// overview on the Ranked screen, from the Remaster server's /api/ranked.
(function () {
  var URL = (typeof REMASTER_API != "undefined" ? REMASTER_API : "http://127.0.0.1:8000/api") + "/ranked";
  var REWARDS = {
    Scrapper: "Scrapper card", Contender: "Contender card", Blooded: "Blooded card",
    Hunter: "Hunter card + Teal Current camo (all weapons)", Executioner: "Executioner card + animated card",
    Reaper: "Reaper card + Lava Storm Fireman's Axe", Warlord: "Warlord card + Abyss Lightning camo (all weapons)",
    Apex: "Apex card + animated card", Legend: "Legend card and title"
  };
  var last = null;

  function emblem(tier) { return "/images/ranked/" + tier.toLowerCase() + ".png"; }

  // The player card reads: level, rank emblem, name.
  function badge(s) {
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

  // The modes along the top of the Ranked screen. Only Solo is played today;
  // the others show what's coming (casual and ranked will share this list).
  var MODES = [
    { id: "solo", label: "Solo" },
    { id: "duo", label: "Duo", soon: true },
    { id: "trio", label: "Trio", soon: true },
    { id: "quads", label: "Quads", soon: true }
  ];

  function esc(t) { return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function modes() {
    if (document.getElementById("ranked-modes")) return;
    var html = MODES.map(function (m) {
      return '<div class="rm-tab' + (m.soon ? "" : " active") + '">' + m.label + (m.soon ? "<small>Soon</small>" : "") + "</div>";
    }).join("");
    $("#ranked-menu").append('<section id="ranked-modes">' + html + "</section>");
  }

  function chip(value, label) { return '<div class="rp-chip"><b>' + esc(value) + "</b><span>" + label + "</span></div>"; }

  function panel(s) {
    modes();
    if (!document.getElementById("ranked-panel")) {
      $("#ranked-menu").append('<section id="ranked-panel"></section>');
    }
    var next = s.tier.next != null ? (s.tier.next - s.rating) + " to next tier" : "Top tier";
    var title = s.placement ? "Placements " + s.placement.played + "/" + s.placement.total : s.tier.name;
    var recent = s.recent.slice(0, 8).map(function (e) {
      var up = e.delta >= 0;
      return '<div class="rp-row"><span>#' + e.placement + (e.abandoned ? " (left)" : "") + '</span>' +
        '<span class="r ' + (up ? "up" : "down") + '">' + (up ? "+" : "") + e.delta + '</span>' +
        '<span class="r">' + e.ratingAfter + "</span></div>";
    }).join("");
    recent = recent ? '<div class="rp-row th"><span>Place</span><span class="r">Change</span><span class="r">Rating</span></div>' + recent
      : '<div class="rp-empty">No ranked matches yet this season.</div>';
    var ladder = s.tiers.map(function (t) {
      var current = t.name === s.tier.name;
      var cls = "rp-tierrow" + (t.reached ? " reached" : "") + (current ? " current" : "");
      var tag = current ? '<span class="t-tag">You</span>' : (t.reached ? '<span class="t-tag">Unlocked</span>' : "");
      return '<div class="' + cls + '"><img src="' + emblem(t.name) + '"><span class="t-name">' + esc(t.name) + "</span>" +
        '<span class="t-min">' + t.min + "+</span>" + '<span class="t-reward">' + esc(REWARDS[t.name] || "") + "</span>" + tag + "</div>";
    }).join("");
    $("#ranked-panel").html(
      '<div class="rp-head"><img src="' + emblem(s.tier.name) + '"><div class="rp-main">' +
        '<div class="rp-season">' + esc(s.season.name).toUpperCase() + " · " + s.season.daysLeft + " DAYS LEFT</div>" +
        '<div class="rp-tier">' + esc(title).toUpperCase() + "</div>" +
        '<div class="rp-elo">' + s.rating + " ELO<small>" + next + "</small></div>" +
        '<div class="rp-bar"><div style="width:' + Math.round(s.tier.progress * 100) + '%"></div></div>' +
      "</div>" +
      '<div class="rp-chips">' + chip(s.peak.rating, "Peak · " + esc(s.peak.tier)) + chip(s.matches, "Matches") + chip(s.wins, "Wins") + "</div></div>" +
      '<div class="rp-cols">' +
        '<div class="rp-col recent"><div class="rp-h">Recent</div>' + recent + "</div>" +
        '<div class="rp-col ladder"><div class="rp-h">Rank ladder<span>Rewards</span></div>' + ladder + "</div>" +
      "</div>" +
      '<div class="rp-note">Rating moves on placement, never kills. Leaving a ranked match counts as last place.</div>');
  }

  var asked = 0;

  function refresh() {
    // Ranked is per player: send the login token the menus already hold.
    var token = typeof ClientwebData != "undefined" && ClientwebData.AuthToken;
    if (!token) return;
    var t = new Date().getTime();
    if (t - asked < 2000) return;        // several triggers at once (sign-in, a screen showing)
    asked = t;
    $.ajax({ url: URL, dataType: "json", headers: { Authorization: "Bearer " + token } }).done(function (s) {
      last = s;
      badge(s);
      if (document.getElementById("ranked-menu")) panel(s);
    });
  }

  // Asked when it can have changed, not on a timer: when the menu signs in
  // (ClientWeb.js, on auth-response: also the first time after a match, when
  // the menu loads again), when the Ranked screen shows, and when the server
  // sends the player's balance after a match result (player-response).
  var stockOnShow = RankedScreen.prototype.OnShow;
  RankedScreen.prototype.OnShow = function () {
    if (stockOnShow) stockOnShow.apply(this, arguments);
    refresh();
  };

  window.RemasterRanked = { refresh: refresh };
  $(refresh);
})();
