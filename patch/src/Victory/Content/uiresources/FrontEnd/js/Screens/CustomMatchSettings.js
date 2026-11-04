(function () {
  var FUNC_CLIENTWEB_ROOT_URL = "http://127.0.0.1:8000/api";
  var FUNC_BUILD_SUFFIX = "-func-5";
  var FUNC_NEWS_TEXT = "Welcome to The Culling Remaster";
  var STOCK_BAD_BUILD_ERROR = "Your game client is out of date.  You must exit the game and update before playing online.";
  var FUNC_BAD_BUILD_ERROR = "Your F.U.N.C. client is out of date.  You must exit the game and update before playing online.";

  function getFuncChosenRegion() {
    var dataCenter = ClientwebData && ClientwebData.SelectedDataCenter;
    if (typeof dataCenter != "string" || dataCenter == "" || dataCenter.toLowerCase() == "automatic") {
      return null;
    }

    switch (dataCenter.toLowerCase()) {
      case "us east":
      case "us west":
      case "us":
        return "US";
      case "europe":
        return "Europe";
      case "oceania":
        return "Oceania";
      default:
        return null;
    }
  }

  function applyFuncMenuTweaks() {
    $("#connecting-game .connecting").text("ENTERING THE CULLING REMASTER");
    $("#news-text").html(FUNC_NEWS_TEXT);
    $("#store-crate-menu-options").remove();
    $('#main-menu-options li[data-push-screen="PlayDev"]').remove();
    $('#main-menu-options li[data-push-screen="Profile"]').remove();
    $('#main-menu-options li[data-push-screen="Leaderboard"]').remove();
    $('#main-menu-options li[data-push-screen="Lootbox"]').remove();
  }

  applyFuncMenuTweaks();
  $(applyFuncMenuTweaks);

  var stockJQueryGet = $.get;
  $.get = function (url, data, success, dataType) {
    var callback = typeof data == "function" ? data : success;
    if (url == "http://resources.theculling.com/News.html" || url == "https://s3.amazonaws.com/resources.theculling.com/NewsXbox.html") {
      if (typeof callback == "function") {
        callback(FUNC_NEWS_TEXT);
      }

      return $.Deferred().resolve(FUNC_NEWS_TEXT).promise();
    }

    return stockJQueryGet.apply(this, arguments);
  };

  var stockJQueryAjax = $.ajax;
  $.ajax = function (url, options) {
    var settings = typeof url == "string" ? options : url;
    if (settings && settings.data && ClientwebRootData && settings.url == ClientwebRootData.login) {
      var chosenRegion = getFuncChosenRegion();
      if (chosenRegion) {
        settings.data.region = chosenRegion;
      }
    }

    return stockJQueryAjax.apply(this, arguments);
  };

  GetClientwebRootURL = function () {
    return $.when(
      engine.call("GetAppID"),
      engine.call("GetClientwebUrl", ClientwebData.ActualDataCenter),
      engine.call("GetClientwebOverride"),
      engine.call("GetClientBuild"),
      engine.call("GetProductVersion")
    ).then(function (appid, url, override, build, productVersion) {
      if (override !== "") {
        $("#debug-info").show();
        $("#clientweb-override").show();
        $("#clientweb-override-url").text(override);
        console.log("Forcing clientweb override: " + override);
      }

      Matchmaking.AppId = appid;
      Matchmaking.ProductVersion = productVersion;
      ClientwebData.IsPublicTestClient = appid == PUBLIC_TEST_APPID;
      Matchmaking.Build = build + FUNC_BUILD_SUFFIX;
      return FUNC_CLIENTWEB_ROOT_URL;
    });
  };

  LoginResponseFromEngine = function (bodyText, processFunction) {
    try {
      console.log("LoginResponseFromEngine");

      var body = JSON.parse(bodyText);

      return processFunction(body);
    } catch (ex) {
      console.error("Failed to parse server login response " + ex);
      console.error("Response text was: '" + bodyText + "'");

      $('.build-version').text("Failed to parse server login response " + ex + "\r\n" + "Response text was: '" + bodyText + "'");

      ProcessLoginFailure({errorCode: "invalid_server_json"});
      return null;
    }

    return null;
  };

  function formatUnexpectedWebsocketError(err) {
    var socketUrl = ClientwebRootData ? ClientwebRootData.socket : undefined;
    if (err.type != undefined) {
      return "Unexpected websocket (" + socketUrl + ") connect error: " + err.type + " " + err.description;
    }

    return "Unexpected websocket (" + socketUrl + ") connect error: " + err;
  }

  var stockShowError = ShowError;
  ShowError = function (error) {
    var args = Array.prototype.slice.call(arguments);
    if (args[0] == STOCK_BAD_BUILD_ERROR) {
      args[0] = FUNC_BAD_BUILD_ERROR;
    }

    return stockShowError.apply(this, args);
  };

  function callWithWebsocketErrorPatch(err, callback) {
    var funcShowError = ShowError;

    ShowError = function (error) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof args[0] == "string" && args[0].indexOf("Unexpected websocket connect error: ") == 0) {
        args[0] = formatUnexpectedWebsocketError(err);
      }

      return funcShowError.apply(this, args);
    };

    try {
      return callback();
    } finally {
      ShowError = funcShowError;
    }
  }

  if (typeof io != "undefined" && io && typeof io.connect == "function" && !io.connect.FuncCustomMatchSettingsPatched) {
    var stockIoConnect = io.connect;
    var funcIoConnect = function () {
      var socket = stockIoConnect.apply(this, arguments);

      if (socket && typeof socket.on == "function" && !socket.FuncCustomMatchSettingsPatched) {
        var stockSocketOn = socket.on;
        socket.on = function (eventName, handler) {
          if ((eventName == "connect_error" || eventName == "error") && typeof handler == "function") {
            var stockHandler = handler;
            handler = function (err) {
              var self = this;
              var args = arguments;
              return callWithWebsocketErrorPatch(err, function () {
                return stockHandler.apply(self, args);
              });
            };
          }

          return stockSocketOn.call(this, eventName, handler);
        };

        socket.FuncCustomMatchSettingsPatched = true;
      }

      return socket;
    };

    funcIoConnect.FuncCustomMatchSettingsPatched = true;
    io.connect = funcIoConnect;
  }

  var stockBindClientwebEvents = BindClientwebEvents;
  BindClientwebEvents = function (deferred) {
    var result = stockBindClientwebEvents.apply(this, arguments);

    socketConnection.on("func-show-error", function (msg) {
      console.error("custom error: " + msg.error);
      ShowError(msg.error);
    });

    return result;
  };
})();

/*
 * Custom match settings (game mode mods).
 *
 * The stock game ships the <custom-match-settings-menu> HTML screen and the
 * native CustomMatchController binder, but the JS file that drove them was
 * never shipped — this file is the script tag that was left dangling, so we
 * get to supply the missing implementation.
 *
 * The 17 settings are the stock EGameModeMod enum values 0..16 (see
 * docs/resolved/CustomMatchSettingsLoading.md). They leave the client over
 * the websocket as a JSON object keyed by the friendly frontend names
 * (lobby-set-mods), always as the full 17-entry set; the matchmaking server
 * stores them on the lobby, bakes them into the game-server launch URL in the
 * stock "?mods=index=value|..." grammar, and AShooterGameMode::InitGame
 * applies them. Because the defaults below are the verified stock
 * VictoryGameMode CDO values, an untouched screen reproduces stock behavior
 * exactly.
 */
(function () {
  // Defaults are the stock values from the VictoryGameMode CDO GameModeMods
  // array (verified from the cooked blueprint). They only pre-fill the UI:
  // SendCustomMatchMods sends changed keys only, so a lobby that never touches
  // this screen keeps the stock blueprint behavior.
  var GAME_MODE_MOD_DEFINITIONS = [
    { key: "NumGreenCrateSpawn", index: 0, defaultValue: 12, min: 0, max: 200 },
    { key: "NumBlueCrateSpawn", index: 1, defaultValue: 24, min: 0, max: 200 },
    { key: "NumRedCrateSpawn", index: 2, defaultValue: 3, min: 0, max: 200 },
    { key: "NumRedBarrelSpawn", index: 3, defaultValue: 15, min: 0, max: 200 },
    { key: "NumGasPylonSpawn", index: 4, defaultValue: 22, min: 0, max: 200 },
    { key: "NumFuncBarrelSpawn", index: 5, defaultValue: 15, min: 0, max: 200 },
    { key: "NumToiletGoodiesSpawn", index: 6, defaultValue: 5, min: 0, max: 200 },
    { key: "NumSmallBuildingItemSpawn", index: 7, defaultValue: 2, min: 0, max: 200 },
    { key: "NumMediumBuildingItemSpawn", index: 8, defaultValue: 4, min: 0, max: 200 },
    { key: "NumLargeBuildingItemSpawn", index: 9, defaultValue: 8, min: 0, max: 200 },
    { key: "NumExtraLargeBuildingItemSpawn", index: 10, defaultValue: 12, min: 0, max: 200 },
    { key: "ChancesExtraGreenCrateSpawn", index: 11, defaultValue: 50, min: 0, max: 100 },
    { key: "ChancesLockerPreOpened", index: 12, defaultValue: 50, min: 0, max: 100 },
    { key: "HealthGivenFromHealthStation", index: 13, defaultValue: 4, min: 0, max: 100 },
    { key: "FuncCostForHealth", index: 14, defaultValue: 1, min: 0, max: 1000 },
    { key: "FreqHealthGivenInSeconds", index: 15, defaultValue: 1, min: 0, max: 600 },
    { key: "RecyclerUseTime", index: 16, defaultValue: 5, min: 0, max: 600 }
  ];

  var GAME_MODE_MOD_BY_KEY = {};
  for (var i = 0; i < GAME_MODE_MOD_DEFINITIONS.length; i++) {
    GAME_MODE_MOD_BY_KEY[GAME_MODE_MOD_DEFINITIONS[i].key] = GAME_MODE_MOD_DEFINITIONS[i];
  }

  // The vanilla HTML binds the pickers to a CustomMatchController object with
  // exactly these property names — we provide it (mirroring the native
  // JSCustomMatchController binder on AVictoryFrontEndHUD+0x958).
  var CustomMatchController = {};
  (function initController() {
    for (var i = 0; i < GAME_MODE_MOD_DEFINITIONS.length; i++) {
      var definition = GAME_MODE_MOD_DEFINITIONS[i];
      CustomMatchController[definition.key] = definition.defaultValue;
    }
  })();

  function CustomSettings() {
    BaseMenuScreen.call(this);
    this.Selector = document.getElementById("custom-match-settings-menu");
    this.ActiveMenu = document.getElementById("custom-game-adv-options");
    this.ScreenActions = [{ value: "Select" }, { value: "Back" }];
    this.ScreenName = "CustomSettings";
  }

  CustomSettings.prototype = Object.create(BaseMenuScreen.prototype);
  CustomSettings.prototype.constructor = CustomSettings;

  CustomSettings.prototype.OnCreation = function () {
    BaseMenuScreen.prototype.OnCreation.call(this);
    this.OnShow();
  };

  CustomSettings.prototype.OnShow = function () {
    this.SetNewActiveMenu(this.ActiveMenu);
    this.RefreshSettingsValues();
    BaseMenuScreen.prototype.OnShow.call(this);
    // Adopt the UI state on the server (full-set send covers re-joins; see
    // the NOTE on SendCustomMatchMods for the display-side limitation).
    SendCustomMatchMods();
  };

  CustomSettings.prototype.OnHide = function () {
    BaseMenuScreen.prototype.OnHide.call(this);
  };

  CustomSettings.prototype.OnClosed = function () {
    BaseMenuScreen.prototype.OnClosed.call(this);
  };

  CustomSettings.prototype.RefreshSettingsValues = function () {
    var items = this.Selector.querySelectorAll("li[data-picker-config-var]");
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var key = item.getAttribute("data-picker-config-var");
      if (!GAME_MODE_MOD_BY_KEY[key]) {
        continue;
      }
      var valueSpan = item.querySelector("span[data-bind-value]");
      if (valueSpan) {
        valueSpan.textContent = CustomMatchController[key];
      }
    }
  };

  CustomSettings.prototype.IncrementSettings = function (direction, setting) {
    console.log("CustomSettings.IncrementSettings: " + setting + " " + direction);
    var definition = GAME_MODE_MOD_BY_KEY[setting];
    if (!definition) {
      console.warn("Unknown custom match setting: " + setting);
      return;
    }
    var value = Number(CustomMatchController[setting]) + direction;
    if (value < definition.min) {
      value = definition.min;
    } else if (value > definition.max) {
      value = definition.max;
    }
    if (value === CustomMatchController[setting]) {
      return;
    }
    CustomMatchController[setting] = value;
    this.RefreshSettingsValues();
    SendCustomMatchMods();
  };

  CustomSettings.prototype.IncrementOnElement = function (elem, direction) {
    if (this.HasMenuItemElem(elem) && elem.dataset != undefined && elem.dataset.pickerConfigVar != undefined) {
      this.IncrementSettings(direction, elem.dataset.pickerConfigVar);
    }
  };

  CustomSettings.prototype.OnMouseClicked = function (elem) {
    if (elem.dataset && elem.dataset.picker) {
      var parent = this.GetAbsoluteMenuItemElem(elem);
      if (parent == undefined) {
        parent = elem.parentElement;
      }
      if (parent != undefined && parent.dataset && parent.dataset.pickerConfigVar) {
        var direction = elem.dataset.picker == "right" ? 1 : -1;
        this.IncrementSettings(direction, parent.dataset.pickerConfigVar);
      }
    }
    BaseMenuScreen.prototype.OnMouseClicked.call(this, elem);
  };

  // Sends the FULL 17-setting set. Defaults are the verified stock CDO values,
  // so an untouched screen reproduces stock behavior exactly, and the server
  // always stores exactly what the owner's UI shows — a rejoin cannot leave an
  // invisible stale set behind. The admin-only StartingActivityValue (index
  // 17) is deliberately outside this table and can never be sent from here.
  // NOTE: the client still does not read lobby-update mods (deferred); after a
  // rejoin the UI shows the table defaults while the server keeps the stored
  // set, which the owner may overwrite by opening the screen.
  function SendCustomMatchMods() {
    if (typeof LobbyData == "undefined" || !LobbyData.IsInLobby ||
        typeof PlayerProfileData == "undefined" ||
        typeof IsLobbyOwner != "function" || !IsLobbyOwner(PlayerProfileData.UserID)) {
      return;
    }
    var mods = {};
    for (var i = 0; i < GAME_MODE_MOD_DEFINITIONS.length; i++) {
      var key = GAME_MODE_MOD_DEFINITIONS[i].key;
      mods[key] = CustomMatchController[key];
    }
    var payload = { mods: mods };
    if (typeof ConnectWebsocketIfNeeded != "function") {
      return;
    }
    ConnectWebsocketIfNeeded().then(function () {
      if (typeof IsOnline == "function" && !IsOnline()) {
        return;
      }
      if (!LobbyData.IsInLobby || !IsLobbyOwner(PlayerProfileData.UserID)) {
        return;
      }
      console.log("CustomMatchSettings: sending lobby-set-mods " + JSON.stringify(payload));
      socketConnection.emit("lobby-set-mods", payload);
    }).catch(function (err) {
      console.error("CustomMatchSettings: failed to send lobby-set-mods " + err);
    });
  }

  $.extend(CustomSettings.prototype, VerticalMenuMixin);
  Screens['CustomSettings'] = CustomSettings;
})();
