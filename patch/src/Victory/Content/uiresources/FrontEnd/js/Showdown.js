// Showdown (patch/make_showdown.py): the SHOWDOWN tile on the Play screen.
// The stock Play screen only queues the Solo and Duo tiles, so this queues
// "showdown" the same way. The server answers "showdown:1v1" and ClientWeb.js
// starts the match (StartTraining("Practice"), whose URL is the arena match).
(function () {
  if (typeof PlayScreen == "undefined") return;
  var selected = PlayScreen.prototype.OnOptionElemSelected;
  PlayScreen.prototype.OnOptionElemSelected = function (elem) {
    if (!elem || elem.id != "showdown_play") return selected.call(this, elem);
    if (hasClickButton || !Matchmaking.CanStartMatching() || Matchmaking.IsStartingMatchmaking) return;
    hasClickButton = true;
    QueueMatchmaking("showdown").then(function (result) {
      if (result) {
        PopScreenToMainMenu();
      } else {
        hasClickButton = false;
        ShowError("Failed to join Showdown. Please try again.");
      }
    });
  };
})();
