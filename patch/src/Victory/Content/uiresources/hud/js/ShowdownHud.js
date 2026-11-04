// Showdown in-match HUD (patch/make_showdown.py, server/showdown.js).
//
// Pre-round panel: at the start of a Showdown round it shows the round and
// score, the kit both sides spawn with (from the server, which reads
// server/data/showdown.json) by section - weapons, armor, injects, Muscle Man
// Milk, other - with the game's own item art, and what you carry now (the
// HUD's own inventory slots, refreshed as they change). The kit is in your
// inventory from the start; armor is already on, the rest you use yourself.
//
// Round banner: after the round's result, the round won or lost and the
// series score (hud.js calls ShowShowdownResult with the server's reply).
(function () {
  var API = (typeof REMASTER_API != "undefined" ? REMASTER_API : "http://127.0.0.1:8000/api");
  var PANEL_SECONDS = 14;
  var SECTIONS = [
    { title: "WEAPONS", cats: ["melee", "ranged", "throwable", "trap"] },
    { title: "ARMOR", cats: ["armor"] },
    { title: "INJECTS", cats: ["inject", "healing"] },
    { title: "MUSCLE MILK", cats: ["muscle_milk"] },
    { title: "ADDITIONAL EQUIPMENT", cats: ["utility", "airdrop_token", "currency", "other"] }
  ];
  // Rarity by the game's weapon tier (1-4); untiered items by kind.
  var TIER_COLORS = { 1: "#9aa0a6", 2: "#4caf50", 3: "#3d8bfd", 4: "#a64dff" };
  var CAT_COLORS = { armor: "#e0a030", inject: "#36c2b4", healing: "#36c2b4", muscle_milk: "#f2f2f2", ranged: "#3d8bfd" };

  var CSS = [
    "#sd-hud { position: absolute; right: 2vw; top: 6.5vh; width: 23vw; z-index: 30; font-family: Sucrose-Regular, Arial, sans-serif; color: #ececec; opacity: 0; transform: translateX(2vw); transition: opacity 0.35s ease, transform 0.35s ease; pointer-events: none; }",
    "#sd-hud.on { opacity: 1; transform: none; }",
    "#sd-hud .sd-panel { background: linear-gradient(180deg, rgba(14, 10, 12, 0.9), rgba(8, 6, 8, 0.82)); border-right: 0.3vw solid #cc0000; border-radius: 1.2vh 0 0 1.2vh; padding: 1.2vh 1vw 1vh; box-shadow: 0 0.8vh 2.4vh rgba(0, 0, 0, 0.55); }",
    "#sd-hud .sd-head { display: flex; justify-content: space-between; align-items: baseline; }",
    "#sd-hud .sd-mode { font: 0.8vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.25vw; color: #ff463c; }",
    "#sd-hud .sd-round { font: 1.9vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.1vw; }",
    "#sd-hud .sd-score { font: 1.1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.15vw; white-space: nowrap; }",
    "#sd-hud .sd-kit { font-size: 0.8vw; opacity: 0.7; margin: 0.2vh 0 0.6vh; letter-spacing: 0.08vw; }",
    "#sd-hud .sd-sec { font: 0.7vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.22vw; opacity: 0.6; margin: 0.8vh 0 0.3vh; }",
    "#sd-hud .sd-item { display: flex; align-items: center; background: rgba(255, 255, 255, 0.05); border-radius: 0.8vh; padding: 0.35vh 0.5vw; margin-bottom: 0.35vh; border-left: 0.22vw solid #9aa0a6; }",
    "#sd-hud .sd-item img { width: 4.6vw; height: 2.6vw; object-fit: contain; margin-right: 0.7vw; }",
    "#sd-hud .sd-item .sd-name { font: 0.95vw Sucrose-Bold, Arial, sans-serif; }",
    "#sd-hud .sd-item .sd-desc { font-size: 0.72vw; opacity: 0.7; line-height: 1.2; }",
    "#sd-hud .sd-tag { display: inline-block; margin-left: 0.4vw; padding: 0 0.4vw; border-radius: 0.6vh; font: 0.6vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.08vw; vertical-align: middle; background: rgba(255, 255, 255, 0.12); }",
    "#sd-hud .sd-tag.auto { background: #e0a030; color: #111; }",
    "#sd-hud .sd-none { font: 0.68vw Sucrose-Regular, Arial, sans-serif; letter-spacing: 0.05vw; opacity: 0.7; margin-left: 0.6vw; }",
    "#sd-hud .sd-carry { display: flex; gap: 0.35vw; margin-top: 0.4vh; }",
    "#sd-hud .sd-slot { width: 2.2vw; height: 2.2vw; border-radius: 0.6vh; background: rgba(255, 255, 255, 0.07) center / 80% no-repeat; }",
    "#sd-hud .sd-help { font-size: 0.74vw; margin-top: 0.8vh; padding-top: 0.7vh; border-top: 1px solid rgba(255, 255, 255, 0.1); }",
    "#sd-hud .sd-help b { color: #ff463c; }",
    "#sd-banner { position: absolute; left: 50%; top: 22vh; transform: translate(-50%, -1vh); z-index: 31; text-align: center; font-family: Sucrose-Bold, Arial, sans-serif; color: #fff; opacity: 0; transition: opacity 0.4s ease, transform 0.4s ease; pointer-events: none; text-shadow: 0 0.3vh 1vh rgba(0, 0, 0, 0.8); }",
    "#sd-banner.on { opacity: 1; transform: translate(-50%, 0); }",
    "#sd-banner .sd-big { font: 4.4vw Creepster, Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.25vw; white-space: nowrap; }",
    "#sd-banner .sd-big.won { color: #5fd47a; }",
    "#sd-banner .sd-big.lost { color: #ff463c; }",
    "#sd-banner .sd-line { font-size: 1.4vw; letter-spacing: 0.2vw; }"
  ].join("\n");

  var panel = null, current = null, hideTimer = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function style() {
    if (document.getElementById("sd-hud-style")) return;
    var s = el("style");
    s.id = "sd-hud-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function color(item) {
    return item.tier ? TIER_COLORS[item.tier] || "#9aa0a6" : CAT_COLORS[item.category] || "#9aa0a6";
  }

  function itemRow(item) {
    var row = el("div", "sd-item");
    row.style.borderLeftColor = color(item);
    var img = el("img");
    img.src = "../images/weapons/" + item.icon + ".png";
    row.appendChild(img);
    var text = el("div");
    var name = el("div", "sd-name", item.name + (item.tier ? "  · T" + item.tier : ""));
    var tag = el("span", "sd-tag" + (item.autoEquip ? " auto" : ""), item.autoEquip ? "ON" : "IN INVENTORY");
    name.appendChild(tag);
    text.appendChild(name);
    text.appendChild(el("div", "sd-desc", item.description));
    row.appendChild(text);
    return row;
  }

  // What the player carries now: the HUD's own slots (hud.js WeaponSlots).
  function carrying(box) {
    box.textContent = "";
    var slots = typeof WeaponSlots != "undefined" ? WeaponSlots : [];
    for (var i = 0; i < slots.length; i++) {
      var s = el("div", "sd-slot");
      var item = slots[i].getAttribute("data-slot-item");
      var locked = slots[i].getAttribute("data-slot-locked") == "true";
      if (locked) s.style.opacity = "0.35";
      if (item && item != "empty") s.style.backgroundImage = "url('images/InventoryIcons/" + item + ".png')";
      box.appendChild(s);
    }
  }

  function show(state) {
    style();
    current = state;
    var series = state.series, kit = state.kit;
    if (!panel) {
      panel = el("div");
      panel.id = "sd-hud";
      document.body.appendChild(panel);
    }
    panel.textContent = "";
    var p = el("div", "sd-panel");
    var head = el("div", "sd-head");
    var left = el("div");
    left.appendChild(el("div", "sd-mode", "SHOWDOWN 1V1"));
    left.appendChild(el("div", "sd-round", "ROUND " + series.round));
    head.appendChild(left);
    head.appendChild(el("div", "sd-score", "YOU " + series.wins + " — " + series.losses + " BOT"));
    p.appendChild(head);
    p.appendChild(el("div", "sd-kit", "FIRST TO " + series.roundsToWin + (kit ? " · SAME KIT FOR BOTH SIDES" : "")));
    var items = kit ? kit.items : [];
    for (var s = 0; s < SECTIONS.length; s++) {
      var sec = SECTIONS[s], mine = [];
      for (var i = 0; i < items.length; i++) if (sec.cats.indexOf(items[i].category) >= 0) mine.push(items[i]);
      var title = el("div", "sd-sec", sec.title);
      // An empty section takes one line.
      if (!mine.length) title.appendChild(el("span", "sd-none", "None this round"));
      p.appendChild(title);
      for (var m = 0; m < mine.length; m++) p.appendChild(itemRow(mine[m]));
    }
    p.appendChild(el("div", "sd-sec", "CARRYING NOW"));
    var carry = el("div", "sd-carry");
    carrying(carry);
    p.appendChild(carry);
    var help = el("div", "sd-help");
    var boost = null;
    for (var b = 0; b < items.length; b++) if (items[b].category == "muscle_milk" || items[b].category == "inject") boost = boost || items[b];
    help.innerHTML = "Everything is already in your inventory" + (items.some(function (x) { return x.autoEquip; }) ? " and your armor is on" : "") + ". " +
      (boost ? "Use the <b>" + boost.name + "</b> before you fight, then switch to your weapon." : "Switch to your weapon and fight.");
    p.appendChild(help);
    panel.appendChild(p);
    panel._carry = carry;
    setTimeout(function () { panel.className = "on"; }, 30);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, PANEL_SECONDS * 1000);
  }

  function hide() {
    if (panel) panel.className = "";
  }

  // Refresh "carrying now" whenever the HUD redraws its slots.
  if (typeof RedrawWeaponSlots == "function") {
    var redraw = RedrawWeaponSlots;
    RedrawWeaponSlots = function () {
      redraw.apply(this, arguments);
      if (panel && panel._carry) carrying(panel._carry);
    };
  }

  function load() {
    $.ajax({ type: "GET", url: API + "/showdown", dataType: "json", timeout: 8000,
      success: function (state) { if (state && state.active && state.series) show(state); } });
  }

  window.ShowShowdownResult = function (state) {
    if (!state || !state.series) return;
    style();
    hide();
    var series = state.series, won = series.rounds[series.rounds.length - 1] == "won";
    var b = document.getElementById("sd-banner") || el("div");
    b.id = "sd-banner";
    b.textContent = "";
    var big = series.over ? (series.won ? "SHOWDOWN VICTORY" : "SHOWDOWN DEFEAT") : "ROUND " + series.round + (won ? " WON" : " LOST");
    b.appendChild(el("div", "sd-big " + ((series.over ? series.won : won) ? "won" : "lost"), big));
    b.appendChild(el("div", "sd-line", "YOU " + series.wins + " — " + series.losses + " BOT" +
      (series.over ? "" : "  ·  FIRST TO " + series.roundsToWin)));
    document.body.appendChild(b);
    setTimeout(function () { b.className = "on"; }, 30);
    setTimeout(function () { b.className = ""; }, 9000);
  };

  // At the start of the round (the HUD page loads with the match).
  load();
  window.ShowdownHud = { show: show, hide: hide, reload: load };
})();
