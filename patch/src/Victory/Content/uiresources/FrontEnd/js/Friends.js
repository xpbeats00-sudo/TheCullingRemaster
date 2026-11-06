// The Culling Remaster: friends, parties and player cards (server/friends.js).
//
// - FRIENDS (a main menu item, and the footer's Invite button) opens the
//   friends panel: add a friend by account username, answer requests, see what
//   each friend is doing (in the menu, searching, in a lobby, in a match and
//   which mode), invite them to your party, view their card. The party (up to
//   4) shows at the top with Leave party; when its leader queues, everyone in
//   it joins the same lobby.
// - A party invite pops up over any menu screen with Accept / Decline.
// - The player card: calling card, level, rank, record (wins, losses, kills,
//   K/D, time played), the ranked season and Showdown. It opens from the
//   friends and party lists, from a lobby row (MatchLobby.js) and from your own
//   card at the top right. A contestant without a public profile shows their
//   card, level and rank with the stats kept private.
// The server pushes "remaster-friends" whenever anything here changes, so the
// panel never polls. Self-contained: builds its own markup and styles.

// ------------------------------------------------------------ overlay stack
// The Remaster panels (friends, player card, leaderboard) sit over the stock
// screens, and the stock screens get every engine key (gamepad, and the
// keyboard keys the game binds) through ScreenHolder's OnButtonPressed. While
// a panel is open the top one takes those keys instead: Back closes it,
// Up/Down/Left/Right move a focus ring over its buttons and rows, Select clicks
// the focused one, LT/RT page (the leaderboard's tabs), and nothing reaches the
// screen underneath. A stock dialog (#ModalScreen) over the panels keeps the
// keys. Escape and Enter can arrive twice for one press (as a keydown and as
// the engine's Back/Select): whichever comes first acts, the other is dropped,
// so Escape closes exactly one panel.
//   RemasterOverlay.open(root, { close, items, page, submit, initial })
//   RemasterOverlay.close(root), .top(), .isOpen(), .refresh(root)
(function () {
  if (window.RemasterOverlay) return;
  var BTN = { select: 0, back: 1, lt: 6, rt: 7, up: 12, down: 13, left: 14, right: 15 };   // FrontEndConsts.js
  var SAME_PRESS_MS = 300;
  var stack = [];                          // { root, close, items, page, submit, focus }
  var acted = { kind: "", by: "", t: 0 };   // the last Back/Select acted on, and by which path
  var lastKey = { code: 0, t: 0 };          // the last keydown
  var styled = false;

  function now() { return new Date().getTime(); }

  function style() {
    if (styled) return;
    styled = true;
    var s = document.createElement("style");
    s.textContent = [
      // The stock footer (z 999) and player card (z 100) stay clickable over
      // any panel otherwise: their Back would pop the screen under the panel.
      "body.remaster-overlay-open #controls-footer, body.remaster-overlay-open #player-card { pointer-events: none !important; }",
      ".ro-focus { box-shadow: 0 0 0 0.16vw rgba(255, 255, 255, 0.95) !important; }"
    ].join("\n");
    document.head.appendChild(s);
  }

  function find(root) {
    for (var i = stack.length - 1; i >= 0; i--) if (stack[i].root === root) return i;
    return -1;
  }

  function bodyClass() {
    var c = document.body.className.replace(/\bremaster-overlay-open\b/g, "").replace(/^\s+|\s+$/g, "");
    document.body.className = stack.length ? (c ? c + " " : "") + "remaster-overlay-open" : c;
  }

  function top() { return stack.length ? stack[stack.length - 1] : null; }

  function modalOpen() { return typeof GetActiveModal == "function" && !!GetActiveModal(); }

  // The panel's focusable parts that are showing, in order.
  function list(entry) {
    // items: a function giving the parts now showing (they change as the
    // panel redraws), or a fixed list.
    var all = typeof entry.items == "function" ? entry.items() : (entry.items || []), out = [];
    for (var i = 0; i < all.length; i++) if (all[i].offsetWidth || all[i].offsetHeight) out.push(all[i]);
    return out;
  }

  function unmark(entry) {
    var m = entry.root.querySelectorAll(".ro-focus");
    for (var i = 0; i < m.length; i++) m[i].className = m[i].className.replace(/\s*\bro-focus\b/g, "");
  }

  function mark(entry, scroll) {
    unmark(entry);
    var items = list(entry);
    if (entry.focus < 0 || !items.length) return null;
    if (entry.focus >= items.length) entry.focus = items.length - 1;
    var e = items[entry.focus];
    e.className += " ro-focus";
    if (scroll) {
      if (e.scrollIntoViewIfNeeded) e.scrollIntoViewIfNeeded(false);
      else if (e.scrollIntoView) e.scrollIntoView(false);
    }
    return e;
  }

  function gamepad() { return typeof FooterData != "undefined" && !!FooterData.bHasGamepad; }

  function open(root, opts) {
    style();
    opts = opts || {};
    var i = find(root), focus = -1;
    if (i >= 0) { focus = stack[i].focus; stack.splice(i, 1); }
    else if (gamepad()) focus = opts.initial || 0;
    var entry = { root: root, close: opts.close, items: opts.items, page: opts.page, submit: opts.submit, focus: focus };
    stack.push(entry);
    // Over #player-card (z 100, earlier in the page) and any other open panel
    // (later in the page wins at the same z), under #ModalScreen (z 101).
    root.style.zIndex = 100;
    if (root.parentNode !== document.body || document.body.lastChild !== root) document.body.appendChild(root);
    bodyClass();
    mark(entry, false);
  }

  function close(root) {
    var i = find(root);
    if (i < 0) return;
    unmark(stack[i]);
    stack.splice(i, 1);
    bodyClass();
  }

  function refresh(root) {
    var i = find(root);
    if (i >= 0) mark(stack[i], false);
  }

  function click(e) {
    var ev = document.createEvent("MouseEvents");
    ev.initMouseEvent("click", true, true, window, 1, 0, 0, 0, 0, false, false, false, false, 0, null);
    e.dispatchEvent(ev);
  }

  function isInput(e) { return e && (e.tagName == "INPUT" || e.tagName == "TEXTAREA"); }

  function move(entry, d) {
    var items = list(entry);
    if (!items.length) return;
    entry.focus = entry.focus < 0 ? (d > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, entry.focus + d));
    var e = mark(entry, true);
    var a = document.activeElement;
    if (isInput(a) && a !== e) a.blur();
    if (isInput(e)) e.focus();
  }

  function activate(entry) {
    var items = list(entry);
    var e = entry.focus >= 0 ? items[entry.focus] : null;
    if (!e) return move(entry, 1);
    if (isInput(e)) { if (entry.submit) entry.submit(e); return; }
    click(e);
  }

  // One press of Back or Select may come by both paths: act once.
  function once(kind, by) {
    var t = now();
    if (acted.kind === kind && acted.by !== by && t - acted.t < SAME_PRESS_MS) return false;
    acted = { kind: kind, by: by, t: t };
    return true;
  }

  function back(entry) {
    var c = entry.close;
    if (c) c(); else close(entry.root);
  }

  // Engine keys (ScreenHolder's OnButtonPressed). true: the panel took it.
  function handle(button) {
    var entry = top();
    if (button === BTN.back && !entry && acted.kind === "back" && acted.by === "key" && now() - acted.t < SAME_PRESS_MS) {
      return true;                     // the Escape keydown already closed the last panel
    }
    if (!entry || modalOpen()) return false;
    var a = document.activeElement;
    var typing = isInput(a) && now() - lastKey.t < SAME_PRESS_MS;
    if (button === BTN.back) {
      if (once("back", "engine")) back(entry);
    } else if (button === BTN.select) {
      if (once("select", "engine")) activate(entry);
    } else if (button === BTN.up || button === BTN.down || button === BTN.left || button === BTN.right) {
      // Letters typed into a text field may be bound to movement too.
      if (typing && (lastKey.code < 37 || lastKey.code > 40)) return true;
      if (isInput(a) && (button === BTN.left || button === BTN.right)) return true;   // moves the caret
      move(entry, button === BTN.up || button === BTN.left ? -1 : 1);
    } else if (button === BTN.lt || button === BTN.rt) {
      if (entry.page) { entry.page(button === BTN.lt ? -1 : 1); mark(entry, false); }
    }
    return true;
  }

  document.addEventListener("keydown", function (e) {
    lastKey = { code: e.keyCode, t: now() };
    if (e.keyCode !== 27 && e.keyCode !== 13) return;
    var entry = top();
    if (e.keyCode === 27) {
      if (!once("back", "key")) { e.stopPropagation(); return; }
      if (!entry || modalOpen()) { acted.kind = ""; return; }
      e.stopPropagation();
      e.preventDefault();
      back(entry);
      return;
    }
    // Enter: a text field handles its own; otherwise click the focused part.
    if (!entry || modalOpen()) return;
    if (!once("select", "key")) { e.stopPropagation(); return; }
    if (isInput(e.target)) return;
    if (entry.focus >= 0) { e.stopPropagation(); activate(entry); }
  }, true);

  if (typeof OnButtonPressed == "function") {
    var stockPressed = OnButtonPressed;
    window.OnButtonPressed = function (button) {
      if (handle(button)) return;
      return stockPressed.apply(this, arguments);
    };
  }

  window.RemasterOverlay = { open: open, close: close, top: top, refresh: refresh, handle: handle,
    isOpen: function () { return stack.length > 0; } };
})();

(function () {
  var TIERS = ["Scrapper", "Contender", "Blooded", "Hunter", "Executioner", "Reaper", "Warlord", "Apex", "Legend"];
  var ERRORS = {
    "no-such-player": "No player has that username.",
    "self": "That's you.",
    "already-friends": "You're already friends.",
    "already-requested": "Your request is waiting for them.",
    "too-many-friends": "That friends list is full.",
    "too-many-requests": "Too many requests are waiting. Try again later.",
    "no-request": "That request is no longer open.",
    "not-friends": "You can only invite friends to your party.",
    "already-in-party": "They're already in your party.",
    "party-full": "The party is full.",
    "no-invite": "That invite has expired.",
    "not-in-party": "You're not in a party.",
    "not-party-leader": "Only the party leader can invite.",
    "party-in-queue": "That party is searching for a match: accept when its search is over.",
    "slow-down": "Slow down a moment.",
    "no-account": "Sign in with your account to add friends."
  };
  var CSS = [
    "#remaster-friends, #remaster-card { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.6); font-family: Sucrose-Regular, Arial, sans-serif; color: rgba(235, 235, 235, 1); }",
    // z-index 100 (RemasterOverlay sets it when shown): over the stock player card.
    "#remaster-friends, #remaster-card { z-index: 100; }",
    "#remaster-friends.hidden, #remaster-card.hidden, #remaster-party-toast.hidden { display: none; }",
    ".rf-panel { position: relative; display: flex; flex-direction: column; width: 36vw; height: 84vh; padding: 2.4vh 1.6vw; box-sizing: border-box; border-radius: 1.8vh; background: rgba(12, 8, 10, 1); box-shadow: 0 0 0 0.15vw rgba(204, 0, 0, 0.8), 0 1vh 3vh rgba(0, 0, 0, 0.7); }",
    ".rf-close { position: absolute; right: 1.2vw; top: 1.6vh; width: 2.2vw; height: 2.2vw; line-height: 2.2vw; text-align: center; border-radius: 50%; font: 1.1vw Sucrose-Bold, Arial, sans-serif; background: rgba(255, 255, 255, 0.1); cursor: pointer; }",
    ".rf-close:hover { background: rgba(204, 0, 0, 1); }",
    ".rf-title { font: 2.6vw Creepster, Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.15vw; line-height: 1; }",
    ".rf-you { margin-top: 0.4vh; font-size: 0.8vw; opacity: 0.65; }",
    ".rf-add { display: flex; margin-top: 1.8vh; }",
    ".rf-add input { flex: 1 1 auto; min-width: 0; padding: 1vh 1vw; border: none; border-radius: 3vh; font: 0.95vw Sucrose-Regular, Arial, sans-serif; color: white; background: rgba(255, 255, 255, 0.1); outline: none; }",
    ".rf-add input:focus { box-shadow: 0 0 0 0.12vw rgba(204, 0, 0, 1); }",
    ".rf-btn { display: inline-block; flex: 0 0 auto; margin-left: 0.5vw; padding: 0.75vh 1vw; border: none; border-radius: 3vh; font: 0.72vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.1vw; text-transform: uppercase; white-space: nowrap; color: white; background: rgba(204, 0, 0, 1); cursor: pointer; }",
    ".rf-btn:hover { background: rgba(240, 30, 20, 1); }",
    ".rf-btn.quiet { background: rgba(255, 255, 255, 0.12); }",
    ".rf-btn.quiet:hover { background: rgba(255, 255, 255, 0.24); }",
    ".rf-btn.big { padding: 1vh 1.4vw; font-size: 0.85vw; }",
    ".rf-msg { min-height: 2.4vh; margin-top: 0.8vh; font-size: 0.8vw; color: rgba(255, 120, 110, 1); }",
    ".rf-msg.ok { color: rgba(120, 220, 140, 1); }",
    ".rf-scroll { flex: 1 1 auto; overflow-y: auto; margin-right: -0.6vw; padding-right: 0.6vw; }",
    ".rf-section { margin-top: 1.4vh; }",
    ".rf-head { display: flex; justify-content: space-between; align-items: center; padding: 0.6vh 0; font: 0.8vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.14vw; text-transform: uppercase; color: rgba(255, 70, 60, 1); border-bottom: 1px solid rgba(255, 255, 255, 0.1); }",
    ".rf-head span { color: rgba(235, 235, 235, 0.6); }",
    ".rf-hint { padding: 1vh 0.2vw; font-size: 0.8vw; opacity: 0.6; }",
    ".rf-row { position: relative; display: flex; align-items: center; height: 5.4vh; margin-top: 0.6vh; padding-right: 0.6vw; border-radius: 1.2vh; background-color: rgba(18, 14, 16, 0.9); background-size: cover; background-position: center; overflow: hidden; }",
    ".rf-row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: linear-gradient(90deg, rgba(8, 6, 8, 0.94) 35%, rgba(8, 6, 8, 0.55)); }",
    ".rf-row > * { position: relative; }",
    ".rf-row.clickable { cursor: pointer; }",
    ".rf-row.clickable:hover { box-shadow: inset 0 0 0 0.12vw rgba(255, 255, 255, 0.35); }",
    ".rf-level { width: 2.8vw; flex: 0 0 auto; text-align: center; font: 1.2vw Sucrose-Bold, Arial, sans-serif; }",
    ".rf-who { flex: 1 1 auto; min-width: 0; }",
    ".rf-name { font: 1vw Sucrose-Bold, Arial, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ".rf-status { margin-top: 0.2vh; font-size: 0.72vw; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ".rf-status:before { content: ''; display: inline-block; width: 0.5vw; height: 0.5vw; margin-right: 0.4vw; border-radius: 50%; background: rgba(140, 140, 140, 1); }",
    ".rf-status.menu:before { background: rgba(80, 200, 110, 1); }",
    ".rf-status.searching:before, .rf-status.lobby:before { background: rgba(240, 180, 40, 1); }",
    ".rf-status.match:before { background: rgba(255, 70, 60, 1); }",
    ".rf-status.none:before { display: none; }",
    ".rf-row.offline .rf-name, .rf-row.offline .rf-level { opacity: 0.55; }",
    ".rf-rank { width: 2.2vw; height: 2.2vw; flex: 0 0 auto; margin-right: 0.3vw; }",
    ".rf-tag { flex: 0 0 auto; margin-right: 0.4vw; padding: 0.2vh 0.5vw; border-radius: 2vh; font: 0.62vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.08vw; text-transform: uppercase; background: rgba(204, 0, 0, 1); }",
    ".rf-tag.quiet { background: rgba(255, 255, 255, 0.14); }",
    ".rf-row .rf-btn { margin-left: 0.35vw; padding: 0.6vh 0.75vw; font-size: 0.64vw; }",
    ".rf-footer { display: flex; align-items: center; justify-content: space-between; }",
    ".rf-footer .rf-hint { flex: 1 1 auto; }",
    // The player card.
    ".rc-panel { position: relative; width: 44vw; max-height: 86vh; overflow-y: auto; padding: 0 0 2.2vh; box-sizing: border-box; border-radius: 1.8vh; background: rgba(12, 8, 10, 1); box-shadow: 0 0 0 0.15vw rgba(204, 0, 0, 0.8), 0 1vh 3vh rgba(0, 0, 0, 0.7); }",
    ".rc-banner { position: relative; display: flex; align-items: center; height: 13vh; padding: 0 5vw 0 1.6vw; background-color: rgba(30, 20, 24, 1); background-size: cover; background-position: center; border-radius: 1.8vh 1.8vh 0 0; overflow: hidden; }",
    ".rc-banner::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: linear-gradient(90deg, rgba(8, 6, 8, 0.85) 20%, rgba(8, 6, 8, 0.1)); }",
    ".rc-banner > * { position: relative; }",
    // The level as on your card in the main menu: a plain white number in its face.
    ".rc-level { min-width: 3vw; margin-right: 1.2vw; flex: 0 0 auto; text-align: center; font: 3.4vw ForgottenFuturist-Bold, Sucrose-Bold, Arial, sans-serif; line-height: 1; color: white; text-shadow: 0 0 0.8vh black, 0 0 0.3vh black; }",
    ".rc-who { flex: 1 1 auto; min-width: 0; }",
    ".rc-name { font: 2.6vw Creepster, Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.12vw; line-height: 1.05; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 0 0.8vh black; }",
    ".rc-sub { font-size: 0.85vw; text-shadow: 0 0 0.6vh black; }",
    ".rc-emblem { width: 8vh; height: 8vh; flex: 0 0 auto; filter: drop-shadow(0 0 0.8vh black); }",
    ".rc-body { padding: 0 1.6vw; }",
    ".rc-section { margin-top: 1.8vh; }",
    ".rc-grid { display: flex; flex-wrap: wrap; margin: 0 -0.3vw; }",
    ".rc-stat { flex: 1 1 22%; margin: 0.8vh 0.3vw 0; padding: 1.1vh 0.8vw; border-radius: 1.2vh; background: rgba(255, 255, 255, 0.06); }",
    ".rc-stat b { display: block; font: 1.5vw Sucrose-Bold, Arial, sans-serif; white-space: nowrap; }",
    ".rc-stat span { font-size: 0.7vw; letter-spacing: 0.1vw; text-transform: uppercase; opacity: 0.65; }",
    ".rc-ranked { display: flex; align-items: center; margin-top: 0.8vh; padding: 1.2vh 1vw; border-radius: 1.2vh; background: rgba(255, 255, 255, 0.06); }",
    ".rc-ranked img.big { width: 7vh; height: 7vh; margin-right: 1vw; }",
    ".rc-ranked .rc-tier { font: 1.5vw Sucrose-Bold, Arial, sans-serif; }",
    ".rc-ranked .rc-detail { font-size: 0.78vw; opacity: 0.75; margin-top: 0.3vh; }",
    ".rc-ranked .rc-peak { margin-left: auto; text-align: right; font-size: 0.78vw; }",
    ".rc-ranked .rc-peak b { display: block; font: 1.1vw Sucrose-Bold, Arial, sans-serif; }",
    ".rc-tiers { display: flex; margin-top: 0.8vh; }",
    ".rc-tiers img { width: 3.6vh; height: 3.6vh; margin-right: 0.35vw; opacity: 0.18; filter: grayscale(1); }",
    ".rc-tiers img.reached { opacity: 1; filter: none; }",
    ".rc-private { margin-top: 0.8vh; padding: 2vh 1vw; border-radius: 1.2vh; text-align: center; font-size: 0.9vw; opacity: 0.7; background: rgba(255, 255, 255, 0.06); }",
    ".rc-buttons { display: flex; justify-content: flex-end; margin-top: 2vh; }",
    // Party members' cards, under your own card (top right of the menus).
    "#remaster-party-cards { width: 24.06vw; margin-top: 0.2vw; pointer-events: all; font-family: Sucrose-Regular, Arial, sans-serif; color: rgba(235, 235, 235, 1); }",
    "#remaster-party-cards .rf-row { height: 3vw; margin-top: 0.4vw; border-radius: 0.9vw; box-shadow: 0 0 0 0.12vw rgba(255, 255, 255, 0.12); }",
    "#remaster-party-cards .rf-level { font: 1.7vw ForgottenFuturist-Bold, Sucrose-Bold, Arial, sans-serif; }",
    "#remaster-party-cards .rf-name { font: 1vw ForgottenFuturist-Bold, Sucrose-Bold, Arial, sans-serif; }",
    "#remaster-party-cards .rf-status { font-size: 0.68vw; }",
    "#remaster-party-cards .rf-rank { width: 1.9vw; height: 1.9vw; }",
    // A party invite, over any screen: top right under the player card, clear
    // of the lobby's map vote (bottom middle).
    "#remaster-party-toast { position: absolute; right: 2.6vw; top: 34vh; z-index: 100; display: flex; align-items: center; padding: 1.2vh 1.2vw; border-radius: 1.6vh; white-space: nowrap; font-family: Sucrose-Regular, Arial, sans-serif; color: rgba(235, 235, 235, 1); background: rgba(12, 8, 10, 1); box-shadow: 0 0 0 0.15vw rgba(204, 0, 0, 0.8), 0 1vh 3vh rgba(0, 0, 0, 0.7); }",
    "#remaster-party-toast .rt-text { margin-right: 1vw; font-size: 0.95vw; }",
    "#remaster-party-toast .rt-text b { color: rgba(255, 70, 60, 1); }"
  ].join("\n");

  var data = null;            // the last remaster-friends push
  var panel = null, cardRoot = null, toast = null, styled = false;
  var pendingCard = null;     // what the lobby row or list knew of the card asked for
  var message = { text: "", ok: false };
  var removing = null;        // a friend whose Remove was clicked once
  var unavailable = null;     // why there is no friends list (no account)
  var noAccount = false;      // the server said this player has no account

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function style() {
    if (styled) return;
    styled = true;
    var s = el("style");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function emit(name, msg) {
    try { if (typeof socketConnection != "undefined" && socketConnection) socketConnection.emit(name, msg); } catch (e) { /* offline */ }
  }

  function button(parent, text, cls, onClick) {
    var b = el("span", "rf-btn" + (cls ? " " + cls : ""), text);
    b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
    parent.appendChild(b);
    return b;
  }

  function cardImage(cardID) {
    var name = (typeof CullingCardImages != "undefined") ? CullingCardImages[String(cardID)] : null;
    return name ? 'url("/images/culling-cards/' + name + '.png")' : "none";
  }

  function withCard(node, cardID) {
    node.style.backgroundImage = cardImage(cardID);
    if (typeof TrackCullingCardElement == "function") TrackCullingCardElement(node);
  }

  function emblem(tier, cls) {
    var img = el("img", cls);
    img.src = "/images/ranked/" + String(tier).toLowerCase() + ".png";
    img.alt = tier;
    return img;
  }

  // Mouse drags over the menu turn the character; not over these panels.
  function overlay(id, z) {
    var root = el("section", "hidden");
    root.id = id;
    root.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    document.body.appendChild(root);
    return root;
  }

  // No connection to the server: the list would never arrive, or would be
  // stale. ClientWeb.js doesn't retry by itself (RECONNECT_AUTOMATICALLY is
  // false); opening the panel tries once (open()).
  function offline() {
    if (typeof IsOnline != "function" || IsOnline()) return false;
    return !(typeof socketConnection != "undefined" && socketConnection);
  }

  function myName() {
    if (data && data.you) return data.you;
    return (typeof PlayerProfileData != "undefined" && PlayerProfileData.Nickname) ? String(PlayerProfileData.Nickname) : "You";
  }

  function lastSeen(t) {
    if (!t) return "Offline";
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 2) return "Offline · just now";
    if (m < 60) return "Offline · " + m + " min ago";
    var h = Math.round(m / 60);
    if (h < 48) return "Offline · " + h + " h ago";
    return "Offline · " + Math.round(h / 24) + " days ago";
  }

  function statusText(s) {
    if (!s) return "";
    return s.state === "offline" ? lastSeen(s.lastSeen) : s.label;
  }

  // ------------------------------------------------------------ friends panel

  function say(text, ok) {
    message = { text: text || "", ok: !!ok };
    if (panel) {
      var m = panel.querySelector(".rf-msg");
      if (m) { m.textContent = message.text; m.className = "rf-msg" + (message.ok ? " ok" : ""); }
    }
  }

  function personRow(p, opts) {
    var li = el("div", "rf-row clickable" + (p.status && p.status.state === "offline" ? " offline" : ""));
    withCard(li, p.cardID);
    li.appendChild(el("span", "rf-level", String(p.level || 1)));
    var who = el("div", "rf-who");
    who.appendChild(el("div", "rf-name", p.username));
    var line = opts.line != null ? opts.line : statusText(p.status);
    who.appendChild(el("div", "rf-status " + (opts.line != null ? "none" : (p.status ? p.status.state : "none")), line));
    li.appendChild(who);
    if (opts.tag) li.appendChild(el("span", "rf-tag" + (opts.tagQuiet ? " quiet" : ""), opts.tag));
    if (p.rank) li.appendChild(emblem(p.rank, "rf-rank"));
    li.addEventListener("click", function () { showCard({ username: p.username, level: p.level, rank: p.rank, cardID: p.cardID }); });
    return li;
  }

  function section(parent, title, count) {
    var s = el("div", "rf-section");
    var h = el("div", "rf-head", title);
    if (count != null) h.appendChild(el("span", null, count));
    s.appendChild(h);
    parent.appendChild(s);
    return s;
  }

  function inParty(username) {
    if (!data || !data.party) return false;
    for (var i = 0; i < data.party.members.length; i++) if (data.party.members[i].username === username) return true;
    return false;
  }

  // The other party members, as cards under yours (top right). Nothing when
  // you're not in a party or the list isn't known (offline).
  function renderParty() {
    var host = document.getElementById("player-card");
    if (!host) return;
    var strip = document.getElementById("remaster-party-cards");
    if (!strip) {
      style();
      strip = el("section");
      strip.id = "remaster-party-cards";
      strip.addEventListener("mousedown", function (e) { e.stopPropagation(); });
      host.appendChild(strip);
    }
    strip.textContent = "";
    if (!data || !data.party || offline()) return;
    data.party.members.forEach(function (m) {
      if (m.username === data.you) return;
      strip.appendChild(personRow(m, { tag: m.leader ? "Leader" : null }));
    });
  }

  function renderPanel() {
    if (!panel || panel.className === "hidden") return;
    var box = panel.querySelector(".rf-scroll");
    var top = box.scrollTop;
    box.textContent = "";
    panel.querySelector(".rf-you").textContent = "Signed in as " + myName();
    if (!data || offline()) {
      box.appendChild(el("div", "rf-hint", offline() ? "Offline — reconnect to see friends." : unavailable || "Connecting..."));
      if (window.RemasterOverlay) RemasterOverlay.refresh(panel);
      return;
    }
    var max = data.maxParty || 4;

    // Party invites waiting for you.
    if (data.invites && data.invites.length) {
      var inv = section(box, "Party invites");
      data.invites.forEach(function (i) {
        var r = personRow(i.from, { line: "Invited you to their party" });
        button(r, "Join", null, function () { emit("party-accept", { partyId: i.partyId }); });
        button(r, "Decline", "quiet", function () { emit("party-decline", { partyId: i.partyId }); });
        inv.appendChild(r);
      });
    }

    // Your party.
    var party = section(box, "Party", data.party ? data.party.members.length + "/" + max : null);
    if (data.party) {
      data.party.members.forEach(function (m) {
        var me = m.username === data.you;
        party.appendChild(personRow(m, { tag: m.leader ? "Leader" : (me ? "You" : null), tagQuiet: !m.leader }));
      });
      var lead = data.party.leader === data.you;
      var f = el("div", "rf-footer");
      f.appendChild(el("div", "rf-hint", lead ? "You lead: when you queue, your party joins your lobby."
        : data.party.leader + " leads: when they queue, you join their lobby."));
      button(f, "Leave party", "quiet", function () { emit("party-leave"); });
      party.appendChild(f);
    } else {
      party.appendChild(el("div", "rf-hint", "Invite friends to play together (up to " + max + "). The leader queues, and everyone joins the same lobby."));
    }

    // Requests.
    if (data.incoming.length || data.outgoing.length) {
      var req = section(box, "Requests", String(data.incoming.length + data.outgoing.length));
      data.incoming.forEach(function (p) {
        var r = personRow(p, { line: "Wants to be friends" });
        button(r, "Accept", null, function () { emit("friend-accept", { username: p.username }); });
        button(r, "Decline", "quiet", function () { emit("friend-decline", { username: p.username }); });
        req.appendChild(r);
      });
      data.outgoing.forEach(function (p) {
        var r = personRow(p, { line: "Request sent" });
        button(r, "Cancel", "quiet", function () { emit("friend-decline", { username: p.username }); });
        req.appendChild(r);
      });
    }

    // Friends.
    var online = 0;
    data.friends.forEach(function (p) { if (p.status && p.status.state !== "offline") online++; });
    var list = section(box, "Friends", data.friends.length ? online + " online · " + data.friends.length : null);
    if (!data.friends.length) list.appendChild(el("div", "rf-hint", "Add a friend with their account username."));
    data.friends.forEach(function (p) {
      var r = personRow(p, {});
      var full = data.party && data.party.members.length >= max;
      if (!inParty(p.username) && !full) button(r, "Invite", null, function () { emit("party-invite", { username: p.username }); });
      button(r, removing === p.username ? "Sure?" : "Remove", "quiet", function () {
        if (removing === p.username) { removing = null; emit("friend-remove", { username: p.username }); }
        else { removing = p.username; renderPanel(); }
      });
      list.appendChild(r);
    });
    box.scrollTop = top;
    if (window.RemasterOverlay) RemasterOverlay.refresh(panel);
  }

  function buildPanel() {
    if (panel) return panel;
    style();
    panel = overlay("remaster-friends");
    var p = el("div", "rf-panel");
    p.innerHTML = '<div class="rf-close">X</div><div class="rf-title">Friends</div><div class="rf-you"></div>' +
      '<div class="rf-add"><input type="text" maxlength="20" placeholder="Add a friend by username"></div>' +
      '<div class="rf-msg"></div><div class="rf-scroll"></div>';
    panel.appendChild(p);
    var input = p.querySelector("input");
    function add() {
      var name = input.value.replace(/^\s+|\s+$/g, "");
      if (!name) return say("Type their username.");
      emit("friend-request", { username: name });
    }
    button(p.querySelector(".rf-add"), "Add friend", "big", add);
    panel.addFriend = add;
    input.addEventListener("keydown", function (e) {
      e.stopPropagation();          // typing here isn't a menu shortcut (Escape: RemasterOverlay)
      if (e.keyCode === 13) add();
    });
    p.querySelector(".rf-close").addEventListener("click", close);
    panel.addEventListener("click", function (e) { if (e.target === panel) close(); });
    return panel;
  }

  // What the gamepad focus ring moves over: the add field, the lists (rows
  // and their buttons, in order), then the close button.
  function panelItems() {
    var out = [], parts = [".rf-add input", ".rf-add .rf-btn"], i, n;
    for (i = 0; i < parts.length; i++) { n = panel.querySelector(parts[i]); if (n) out.push(n); }
    n = panel.querySelectorAll(".rf-scroll .rf-row.clickable, .rf-scroll .rf-btn");
    for (i = 0; i < n.length; i++) out.push(n[i]);
    out.push(panel.querySelector(".rf-close"));
    return out;
  }

  function open() {
    buildPanel().className = "";
    removing = null;
    hideInvite();                   // the panel lists the invite too
    say(message.text, message.ok);
    renderPanel();
    // With a gamepad, start on a waiting party invite's Join, else the add field.
    var start = 0;
    if (data && data.invites && data.invites.length) {
      var items = panelItems(), join = panel.querySelector(".rf-scroll .rf-btn");
      for (var i = 0; i < items.length; i++) if (items[i] === join) start = i;
    }
    if (window.RemasterOverlay) RemasterOverlay.open(panel, { close: close, items: panelItems, initial: start,
      submit: function () { panel.addFriend(); } });
    // Offline (ClientWeb.js doesn't reconnect by itself: RECONNECT_AUTOMATICALLY
    // is off): opening the panel tries once; the list follows the sign-in
    // (auth-response -> connected()).
    if (offline() && typeof ConnectWebsocketIfNeeded == "function") {
      try { ConnectWebsocketIfNeeded(); } catch (e) { /* stays offline */ }
    }
    emit("friends-get");
    var gamepad = typeof FooterData != "undefined" && FooterData.bHasGamepad;
    if (!gamepad || !start) { try { panel.querySelector("input").focus(); } catch (e) { /* no focus */ } }
  }

  function close() {
    // The add field keeps the keyboard focus while hidden otherwise, and the
    // overlay leaves Left/Right to a focused text field: the next panel's
    // D-pad would do nothing.
    var a = document.activeElement;
    if (panel && a && a.tagName == "INPUT" && panel.contains && panel.contains(a) && a.blur) a.blur();
    if (panel) panel.className = "hidden";
    // Its rows go with it: AnimatedCards.js animates every card row still on
    // the page every 40 ms, hidden or not (they are drawn again on open).
    if (panel) panel.querySelector(".rf-scroll").textContent = "";
    removing = null;
    if (window.RemasterOverlay) RemasterOverlay.close(panel);
  }

  // The main menu's FRIENDS item: how many requests and invites wait.
  function badge() {
    var item = document.getElementById("remaster-friends-item");
    var label = item && item.querySelector(".vertical-list-menu-item");
    if (!label) return;
    var n = data ? data.incoming.length + (data.invites ? data.invites.length : 0) : 0;
    label.textContent = n ? "FRIENDS (" + n + ")" : "FRIENDS";
  }

  // ------------------------------------------------------------ party invite toast

  function showInvite(msg) {
    style();
    if (!toast) { toast = overlay("remaster-party-toast"); }
    toast.textContent = "";
    var t = el("span", "rt-text");
    t.appendChild(el("b", null, msg.from.username));
    t.appendChild(document.createTextNode(" invited you to their party"));
    toast.appendChild(t);
    button(toast, "Join", null, function () { emit("party-accept", { partyId: msg.partyId }); hideInvite(); });
    button(toast, "Decline", "quiet", function () { emit("party-decline", { partyId: msg.partyId }); hideInvite(); });
    toast.className = "";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(hideInvite, 30000);
  }

  function hideInvite() { if (toast) toast.className = "hidden"; }

  // ------------------------------------------------------------ player card

  function minutes(m) {
    m = Math.round(m || 0);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  function stat(grid, value, label) {
    var s = el("div", "rc-stat");
    s.appendChild(el("b", null, String(value)));
    s.appendChild(el("span", null, label));
    grid.appendChild(s);
  }

  function buildCard() {
    if (cardRoot) return cardRoot;
    style();
    cardRoot = overlay("remaster-card");
    cardRoot.addEventListener("click", function (e) { if (e.target === cardRoot) closeCard(); });
    // Escape and the gamepad's Back close it: RemasterOverlay.
    return cardRoot;
  }

  function closeCard() {
    if (cardRoot) { cardRoot.className = "hidden"; cardRoot.textContent = ""; }
    if (window.RemasterOverlay) RemasterOverlay.close(cardRoot);
  }

  function cardItems() {
    var out = [], n = cardRoot.querySelectorAll(".rc-buttons .rf-btn");
    for (var i = 0; i < n.length; i++) out.push(n[i]);
    return out;
  }

  // c: the server's card (found) or what the lobby row knew (name, level, rank).
  function renderCard(c, full) {
    var root = buildCard();
    root.textContent = "";
    var p = el("div", "rc-panel");
    var x = el("div", "rf-close", "X");
    x.style.zIndex = 2;
    x.addEventListener("click", closeCard);
    var banner = el("div", "rc-banner");
    withCard(banner, c.cardID);
    banner.appendChild(el("div", "rc-level", String(c.level || 1)));
    var who = el("div", "rc-who");
    who.appendChild(el("div", "rc-name", c.username || c.name || "Player"));
    var sub = c.status ? statusText(c.status) : (c.rank ? c.rank : "");
    who.appendChild(el("div", "rc-sub", sub));
    banner.appendChild(who);
    if (c.rank) banner.appendChild(emblem(c.rank, "rc-emblem"));
    p.appendChild(banner);
    p.appendChild(x);
    var body = el("div", "rc-body");
    p.appendChild(body);

    if (!full) {
      var s0 = section(body, "Record");
      s0.className = "rc-section";
      s0.appendChild(el("div", "rc-private", "This player keeps their stats private."));
    } else {
      var rec = section(body, "Record", c.memberSince ? "Playing since " + new Date(c.memberSince).toLocaleDateString() : null);
      rec.className = "rc-section";
      var grid = el("div", "rc-grid");
      stat(grid, c.wins, "Wins");
      stat(grid, c.losses, "Losses");
      stat(grid, c.kills, "Kills");
      stat(grid, c.kd.toFixed ? c.kd.toFixed(2) : c.kd, "K/D");
      stat(grid, c.games, "Matches");
      stat(grid, c.winRate + "%", "Win rate");
      stat(grid, minutes(c.minutesPlayed), "Time played");
      stat(grid, c.damage, "Damage");
      rec.appendChild(grid);

      var rk = section(body, "Ranked", c.ranked ? c.ranked.season.name : null);
      rk.className = "rc-section";
      if (c.ranked) {
        var r = el("div", "rc-ranked");
        r.appendChild(emblem(c.ranked.tier, "big"));
        var info = el("div");
        info.appendChild(el("div", "rc-tier", c.ranked.tier));
        info.appendChild(el("div", "rc-detail", c.ranked.rating + " rating · " + c.ranked.matches + " ranked matches · " + c.ranked.wins + " wins"));
        r.appendChild(info);
        var peak = el("div", "rc-peak", "Highest rank");
        peak.appendChild(el("b", null, c.ranked.peakTier));
        r.appendChild(peak);
        rk.appendChild(r);
        var tiers = el("div", "rc-tiers");
        TIERS.forEach(function (t) {
          var img = emblem(t, c.ranked.tiersReached.indexOf(t) >= 0 ? "reached" : "");
          img.title = t;
          tiers.appendChild(img);
        });
        rk.appendChild(tiers);
      } else {
        rk.appendChild(el("div", "rc-private", "No ranked matches this season yet."));
      }

      var sd = section(body, "Showdown");
      sd.className = "rc-section";
      var g2 = el("div", "rc-grid");
      stat(g2, c.showdown.won, "Series won");
      stat(g2, c.showdown.lost, "Series lost");
      sd.appendChild(g2);
    }

    var buttons = el("div", "rc-buttons");
    var name = c.username || c.name;
    if (full && c.relation === "none") button(buttons, "Add friend", null, function () { emit("friend-request", { username: name }); closeCard(); });
    if (full && c.relation === "asked-you") button(buttons, "Accept friend", null, function () { emit("friend-accept", { username: name }); closeCard(); });
    if (full && c.relation === "friend" && !inParty(name)) button(buttons, "Invite to party", null, function () { emit("party-invite", { username: name }); });
    button(buttons, "Close", "quiet", closeCard);
    body.appendChild(buttons);
    root.appendChild(p);
    root.className = "";
    if (window.RemasterOverlay) RemasterOverlay.open(root, { close: closeCard, items: cardItems });
  }

  // Opens a player's card. who: { username, level, rank, cardID } as a list
  // or lobby row knows them; { self: true } for yours; contestant: no public
  // profile to ask for.
  function showCard(who) {
    who = who || {};
    if (who.self) {
      pendingCard = { username: myName(), level: typeof ClientwebData != "undefined" && ClientwebData.Stats ? ClientwebData.Stats.level : 1, cardID: 0 };
      emit("player-card", {});
      return;
    }
    pendingCard = { username: who.username || who.name, level: who.level, rank: who.rank, cardID: who.cardID };
    if (who.contestant) return renderCard(pendingCard, false);
    emit("player-card", { username: pendingCard.username });
  }

  // ------------------------------------------------------------ server pushes

  function onResult(r) {
    if (r.action === "player-card") { if (pendingCard) renderCard(pendingCard, false); return; }
    if (r.action === "friends-get") {
      unavailable = r.error ? ERRORS[r.error] || "Friends are unavailable right now." : null;
      noAccount = r.error === "no-account";
      return renderPanel();
    }
    if (r.error) return say(ERRORS[r.error] || "That didn't work.");
    var who = r.username || "";
    if (r.action === "friend-request") {
      say(r.state === "friends" ? "You and " + who + " are now friends." : "Request sent to " + who + ".", true);
      var input = panel && panel.querySelector("input");
      if (input) input.value = "";
    } else if (r.action === "friend-accept") say("You and " + who + " are now friends.", true);
    else if (r.action === "friend-remove") say(who + " removed.", true);
    else if (r.action === "party-invite") say("Party invite sent to " + who + ".", true);
    else if (r.action === "party-accept") say("You joined the party.", true);
    else if (r.action === "party-leave") say("You left the party.", true);
    else say("");
  }

  // The server's lists as the panel draws them: a server older or newer than
  // this menu may leave a list or a field out, and one missing list must not
  // stop the whole panel (an exception here would leave it half drawn).
  function rows(v) {
    var out = [];
    if (v && typeof v == "object" && typeof v.length == "number") {
      for (var i = 0; i < v.length; i++) if (v[i] && typeof v[i] == "object") out.push(v[i]);
    }
    return out;
  }

  function friendsData(m) {
    if (!m || typeof m != "object") return data;
    m.friends = rows(m.friends);
    m.incoming = rows(m.incoming);
    m.outgoing = rows(m.outgoing);
    m.invites = rows(m.invites);
    if (m.party && typeof m.party == "object") m.party.members = rows(m.party.members);
    else m.party = null;
    return m;
  }

  function cardData(c) {
    if (c.kd == null) c.kd = "-";
    if (!c.showdown || typeof c.showdown != "object") c.showdown = { won: 0, lost: 0 };
    if (c.ranked && typeof c.ranked == "object") {
      if (!c.ranked.season || typeof c.ranked.season != "object") c.ranked.season = { name: null };
      if (!c.ranked.tiersReached || typeof c.ranked.tiersReached.indexOf != "function") c.ranked.tiersReached = [];
    } else {
      c.ranked = null;
    }
    return c;
  }

  function on(name, msg) {
    if (name === "remaster-friends") { data = friendsData(msg); renderPanel(); renderParty(); badge(); }
    else if (name === "remaster-friend-result") onResult(msg && typeof msg == "object" ? msg : {});
    else if (name === "remaster-party-invite") {
      if (msg && msg.from && msg.from.username && msg.partyId) showInvite(msg);
    }
    else if (name === "remaster-player-card") {
      if (msg && typeof msg == "object" && msg.found) renderCard(cardData(msg), true);
      else if (pendingCard) renderCard(pendingCard, false);
    }
  }

  window.RemasterFriends = { open: open, close: close, showCard: showCard, on: on,
    connected: function () { emit("friends-get"); },
    disconnected: function () { renderPanel(); renderParty(); },
    // Your account username from the server; false: no account; null: not known yet.
    account: function () { return data ? data.you || false : (noAccount ? false : null); } };

  // The footer's Invite button and the main menu's FRIENDS item open the panel.
  window.OnInvitePressed = open;
  if (typeof BaseMenuScreen != "undefined") {
    var selected = BaseMenuScreen.prototype.OnOptionElemSelected;
    BaseMenuScreen.prototype.OnOptionElemSelected = function (elem) {
      if (elem && elem.id == "remaster-friends-item") return open();
      return selected.apply(this, arguments);
    };
  }
  // Your own card, top right.
  document.addEventListener("click", function (e) {
    for (var n = e.target; n && n !== document; n = n.parentNode) {
      if (n.className && typeof n.className == "string" && n.className.indexOf("local-culling-card-container") >= 0) return showCard({ self: true });
    }
  });
})();
