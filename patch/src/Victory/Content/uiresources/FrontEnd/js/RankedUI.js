// The Culling Remaster: Ranked Solo UI.
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

  function panel(s) {
    if (!document.getElementById("ranked-panel")) {
      $("#ranked-menu").append('<section id="ranked-panel"></section>');
    }
    var next = s.tier.next != null ? (s.tier.next - s.rating) + " to next tier" : "Top tier";
    var recent = s.recent.slice(0, 6).map(function (e) {
      var col = e.delta >= 0 ? "#5fe05f" : "#ff4b4b";
      return '<li><span>#' + e.placement + (e.abandoned ? " (left)" : "") + '</span><span style="color:' + col + '">' +
        (e.delta >= 0 ? "+" : "") + e.delta + '</span><span>' + e.ratingAfter + '</span></li>';
    }).join("") || '<li><span>No ranked matches yet</span></li>';
    var tiers = s.tiers.map(function (t) {
      return '<li class="' + (t.reached ? "reached" : "") + '"><img src="' + emblem(t.name) + '"><span>' + t.name +
        ' <small>' + t.min + '+</small></span><em>' + (t.reached ? "UNLOCKED" : REWARDS[t.name]) + '</em></li>';
    }).join("");
    $("#ranked-panel").html(
      '<div class="rp-head"><img src="' + emblem(s.tier.name) + '"><div>' +
      '<div class="rp-season">' + s.season.name.toUpperCase() + ' • ' + s.season.daysLeft + ' DAYS LEFT</div>' +
      '<div class="rp-tier">' + (s.placement ? "PLACEMENTS " + s.placement.played + "/" + s.placement.total : s.tier.name) + '</div>' +
      '<div class="rp-elo">' + s.rating + ' ELO <small>' + next + '</small></div>' +
      '<div class="rb-bar"><div style="width:' + Math.round(s.tier.progress * 100) + '%"></div></div>' +
      '<div class="rp-stats">Peak ' + s.peak.rating + ' (' + s.peak.tier + ') • ' + s.matches + ' matches • ' + s.wins + ' wins</div>' +
      '</div></div>' +
      '<div class="rp-cols"><div><h3>RECENT</h3><ul class="rp-recent">' + recent + '</ul></div>' +
      '<div><h3>RANK REWARDS</h3><ul class="rp-tiers">' + tiers + '</ul></div></div>' +
      '<p class="rp-note">Rating moves on placement, never kills. ' +
      'Leaving a ranked match counts as last place.</p>');
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
