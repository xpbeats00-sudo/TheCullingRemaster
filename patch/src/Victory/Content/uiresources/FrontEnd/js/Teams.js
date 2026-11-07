// Trios and Quads (patch/make_duo.py): you and two or three AI teammates
// against teams of the same size, on the voted map.
//
// - The TRIO and QUAD tiles (make_branding.add_team_tiles) queue
//   "ffa_jungle_coop3" / "ffa_jungle_coop4": the stock Play screen queues only
//   the Solo and Duo tiles (by id), and pushes a screen for any other tile.
// - The server answers "trio:<map>" / "quad:<map>" and ClientWeb.js opens the
//   pairs mode with ?TeamSize=3 / 4 (REMASTER_TEAM_URLS); the patched exe
//   teams the contestants by it (patch/showdown_rounds.c sd_teams).
// ES5 only (Coherent UI).
(function () {
  var QUEUES = { trio_play: "ffa_jungle_coop3", quad_play: "ffa_jungle_coop4" };

  if (typeof PlayScreen == "undefined") return;
  var selected = PlayScreen.prototype.OnOptionElemSelected;
  PlayScreen.prototype.OnOptionElemSelected = function (elem) {
    if (!elem || !QUEUES.hasOwnProperty(elem.id)) return selected.call(this, elem);
    if (hasClickButton) return;
    if (!Matchmaking.CanStartMatching() || Matchmaking.IsStartingMatchmaking) {
      ShowError("This mode can't start right now. Please try again in a moment.");
      return;
    }
    hasClickButton = true;
    $.when(QueueMatchmaking(QUEUES[elem.id])).then(function (result) {
      if (result) {
        PopScreenToMainMenu();
      } else {
        hasClickButton = false;
        ShowError("Failed to join the queue. Please try again.");
      }
    }, function () {
      // No connection (QueueMatchmaking rejected): the tiles work again.
      hasClickButton = false;
      ShowError("Couldn't reach the server. Please try again.");
    });
  };

  window.RemasterTeams = { queues: QUEUES };
})();
