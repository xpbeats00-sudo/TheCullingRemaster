// The Culling Remaster: the local player's card art without waiting on the
// engine. Stock FrontEnd.js shows the card from GetLocalPlayerCullingCardImagePath,
// which can come back blank when the card's texture isn't loaded yet (the card
// then shows no art). Fall back to CullingCardImages (CardImageMap.js), keyed by
// the equipped card's ID.
(function () {
  if (typeof OnLocalCullingCardChanged != "function") return;

  window.OnLocalCullingCardChanged = function () {
    engine.call("GetLocalPlayerCullingCardID").then(function (cardID) {
      engine.call("GetLocalPlayerCullingCardImagePath").then(function (image) {
        var fallback = (typeof CullingCardImages != "undefined") ? CullingCardImages[String(cardID)] : null;
        if (window.UiTrace) UiTrace("card image: id " + cardID + ", engine '" + image + "', map '" + fallback + "'");
        var name = image || fallback;
        if (name) {
          $('.local-culling-card-container').css('background-image', 'url("/images/culling-cards/' + name + '.png")');
        }
      });
      SendCullingCardIfConnected(cardID);
    });
  };
})();
