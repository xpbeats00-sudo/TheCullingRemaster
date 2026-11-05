(function () {
  var FUNC_CLIENTWEB_ROOT_URL = (typeof REMASTER_API != "undefined" ? REMASTER_API : "http://127.0.0.1:8000/api");
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
 * The stock game ships the <custom-match-settings-menu> HTML screen, but the
 * JS file that drove it was never shipped (this file is the script tag that
 * was left dangling) and the native CustomMatchController's Increment* engine
 * calls are empty stubs in the shipped exe, so this screen keeps the values
 * itself.
 *
 * The 17 settings are the stock EGameModeMod values 0..16, all read by the
 * game's Blueprints (patch/custom_match.py has where). They leave the client
 * over the websocket as a JSON object keyed by the names below
 * (lobby-set-mods), always as the full set; the server keeps them on the
 * lobby, answers START with "custom:<map>:<mods>" in the stock
 * "?mods=index=value|..." grammar, and ClientWeb.js opens the map with that
 * option, which AShooterGameMode::InitGame applies. The stock values are the
 * VictoryGameMode CDO's, so an untouched screen plays like Solo.
 */
(function () {
  // [key, stock value, min, max] per EGameModeMod index: ClientWeb.js's
  // REMASTER_CUSTOM_MODS (patch/test_custom_match.py checks it).
  var GAME_MODE_MOD_DEFINITIONS = [];
  var table = typeof REMASTER_CUSTOM_MODS != "undefined" ? REMASTER_CUSTOM_MODS : [];
  for (var t = 0; t < table.length; t++) {
    GAME_MODE_MOD_DEFINITIONS.push({ key: table[t][0], index: t, defaultValue: table[t][1], min: table[t][2], max: table[t][3] });
  }

  var GAME_MODE_MOD_BY_KEY = {};
  for (var i = 0; i < GAME_MODE_MOD_DEFINITIONS.length; i++) {
    GAME_MODE_MOD_BY_KEY[GAME_MODE_MOD_DEFINITIONS[i].key] = GAME_MODE_MOD_DEFINITIONS[i];
  }

  // The vanilla HTML binds the pickers to a CustomMatchController object with
  // exactly these property names; this one stands in for it.
  var CustomMatchController = {};
  (function initController() {
    for (var i = 0; i < GAME_MODE_MOD_DEFINITIONS.length; i++) {
      var definition = GAME_MODE_MOD_DEFINITIONS[i];
      CustomMatchController[definition.key] = definition.defaultValue;
    }
  })();

  // The settings the server holds for this lobby (LobbyData.Mods, from
  // lobby-update / lobby-set-mods-ack), where they are valid: the screen shows
  // what START will play, also after coming back to the lobby.
  function AdoptLobbyMods() {
    var mods = typeof LobbyData != "undefined" && LobbyData.IsInLobby ? LobbyData.Mods : null;
    if (!mods || typeof mods != "object") {
      return;
    }
    for (var i = 0; i < GAME_MODE_MOD_DEFINITIONS.length; i++) {
      var definition = GAME_MODE_MOD_DEFINITIONS[i];
      var value = mods[definition.key];
      if (typeof value == "number" && Math.floor(value) === value && value >= definition.min && value <= definition.max) {
        CustomMatchController[definition.key] = value;
      }
    }
  }

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
    AdoptLobbyMods();
    this.SetNewActiveMenu(this.ActiveMenu);
    this.RefreshSettingsValues();
    BaseMenuScreen.prototype.OnShow.call(this);
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

  // Sends the FULL set, so the server always holds exactly what the screen
  // shows. EGameModeMod 17 (StartingActivityValue) is not in the table and is
  // never sent.
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

/*
 * The CUSTOM lobby in the Remaster: a custom match is played on your PC (there
 * is no multiplayer hosting), so nobody can join it.
 *
 * - The Play screen's "Create or Join a game?" choice: Join says so instead of
 *   opening the code keypad (the server refuses lobby-join with the same text,
 *   for invites).
 * - Leaving the CUSTOM screen leaves the lobby, unless its match is starting
 *   (the stock Leave button is commented out of the page and the queue widget
 *   that left it is hidden), so the menu doesn't stay "in lobby".
 */
(function () {
  var JOIN_REFUSED = "Custom matches are played on your PC; invite friends to a party instead.";

  function ShowJoinRefused() {
    PushModal('Modal', {
      options: ["Ok"],
      title: "JOIN A CUSTOM MATCH",
      description: JOIN_REFUSED,
      bSupportsBackButton: true,
      needInput: false,
      callback: function () {}
    });
  }

  if (typeof PushModal == "function" && !PushModal.RemasterCustomJoin) {
    var stockPushModal = PushModal;
    PushModal = function (screen, args) {
      if (screen == 'Modal' && args && args.title == "Create or Join a game?" && typeof args.callback == "function") {
        var stockCallback = args.callback;
        args.callback = function (option) {
          if (option == "Join") {
            ShowJoinRefused();
            return;
          }
          return stockCallback.apply(this, arguments);
        };
      }
      return stockPushModal.apply(this, arguments);
    };
    PushModal.RemasterCustomJoin = true;
  }

  if (typeof CustomScreen == "function" && CustomScreen.prototype && !CustomScreen.prototype.RemasterLeaveOnClose) {
    var stockOnClosed = CustomScreen.prototype.OnClosed;
    CustomScreen.prototype.OnClosed = function () {
      var result = stockOnClosed.apply(this, arguments);
      if (typeof LobbyData != "undefined" && LobbyData.IsInLobby && !LobbyData.MatchIsStarting && typeof LeaveLobby == "function") {
        LeaveLobby();
      }
      return result;
    };
    CustomScreen.prototype.RemasterLeaveOnClose = true;
  }
})();
