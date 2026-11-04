// The Culling Remaster: UI breadcrumbs for diagnosing menu freezes.
// Each trace is posted to the Remaster server (logged as "ui-trace") before the
// step it names runs, synchronously where Coherent allows it, so the last
// line in the server log before a freeze is the step that hung.
(function () {
  var URL = (typeof REMASTER_API != "undefined" ? REMASTER_API : "http://127.0.0.1:8000/api") + "/uitrace";
  var TRACED = {
    GetFlairCustomizations: 1, GetItemsForCustAndCat: 1, SetPreviewItem: 1,
    SetCustomization: 1, GetCategoriesForCustType: 1, ResetCustomizationPreview: 1
  };

  function post(msg, sync) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", URL, !sync);
      xhr.setRequestHeader("Content-Type", "text/plain");
      xhr.send(msg);
    } catch (e) {
      if (sync) post(msg, false);
    }
  }

  window.UiTrace = function (msg) { post(msg, true); };

  if (typeof engine == "undefined" || !engine.call || engine.call.uiTraced) return;
  var stockCall = engine.call;
  engine.call = function (name) {
    if (!TRACED[name]) return stockCall.apply(engine, arguments);
    var args = Array.prototype.slice.call(arguments, 1).join(",");
    var t0 = Date.now();
    UiTrace("call " + name + "(" + args + ")");
    var promise = stockCall.apply(engine, arguments);
    if (promise && promise.then) {
      promise.then(function (result) {
        var n = result && result.length !== undefined ? " -> " + result.length + " items" : "";
        UiTrace("done " + name + " in " + (Date.now() - t0) + " ms" + n);
      });
    }
    return promise;
  };
  engine.call.uiTraced = true;
})();
