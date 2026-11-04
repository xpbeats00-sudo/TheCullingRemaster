// The Culling Remaster launcher: main screen.
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  let api = null;
  let state = null;
  let pings = {};
  let syncing = false;

  // ---------------------------------------------------------------- background
  const back = $("#bg-back").getContext("2d");
  const front = $("#bg-front").getContext("2d");
  const ambient = new FX.Ambient(0.6);
  let W = 0, H = 0;
  const fit = () => ({ W, H } = FX.fitCanvases([back, front]));
  window.addEventListener("resize", fit);
  fit();
  let last = performance.now();
  (function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    back.clearRect(0, 0, W, H);
    ambient.drawBack(back, dt, t, W, H);
    front.clearRect(0, 0, W, H);
    ambient.drawFront(front, dt, t, W, H);
    requestAnimationFrame(frame);
  })(last);

  // ---------------------------------------------------------------- helpers
  function toast(msg, kind) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (kind ? " " + kind : "");
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 5200);
  }
  const errorText = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

  function bytes(n) {
    if (n == null) return "-";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  async function call(fn, ...args) {
    try { return await fn(...args); } catch (e) { toast(errorText(e)); throw e; }
  }

  // ---------------------------------------------------------------- tabs
  function selectTab(name) {
    $$(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on);
      if (on) {
        const u = $(".tab-underline");
        u.style.left = t.offsetLeft + "px";
        u.style.width = t.offsetWidth + "px";
      }
    });
    $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  }
  $$(".tab").forEach((t) => t.addEventListener("click", () => selectTab(t.dataset.tab)));

  // ---------------------------------------------------------------- rendering
  function selectedServer() {
    return state.servers.find((s) => s.id === state.settings.serverId) || state.servers[0];
  }

  function renderServers() {
    const list = $("#server-list");
    list.textContent = "";
    for (const s of state.servers) {
      const p = pings[s.id];
      const li = document.createElement("li");
      li.className = "server" + (s.id === selectedServer().id ? " selected" : "") + (p && !p.ok ? " offline" : "");
      li.dataset.id = s.id;
      const level = !p || !p.ok ? 0 : p.ms < 60 ? 4 : p.ms < 120 ? 3 : p.ms < 220 ? 2 : 1;
      const players = p && p.ok && p.users != null ? `${p.users} online` : p && !p.ok ? "Unreachable" : "Checking";
      li.innerHTML = `
        <div class="server-thumb"><img src="assets/mask.png" alt=""></div>
        <div><div class="server-name"></div><div class="server-meta"></div></div>
        <div class="server-ping"><span class="bars" data-level="${level}"><i></i><i></i><i></i><i></i></span><span class="ms"></span></div>`;
      li.querySelector(".server-name").textContent = s.name;
      li.querySelector(".server-meta").textContent = `${s.region || "Online"}  |  ${players}`;
      li.querySelector(".ms").textContent = p && p.ok ? p.ms + "ms" : p ? "-" : "...";
      li.addEventListener("click", () => chooseServer(s.id));
      list.appendChild(li);
    }
    const select = $("#region-select");
    select.textContent = "";
    for (const s of state.servers) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.region || s.name;
      select.appendChild(o);
    }
    select.value = selectedServer().id;
  }

  function renderStatus() {
    const box = $("#status-game");
    box.className = "status-game";
    let title, sub = "Version " + (state.installed || "-");
    if (syncing) { title = "Syncing"; box.classList.add("busy"); }
    else if (!state.game.ok && state.game.installable) {
      title = state.online ? "Ready to install" : "Not installed";
      sub = !state.online ? "Can't reach xplab.shop" : state.pending ? bytes(state.pending.bytes) + " download" : "Checking";
      box.classList.add("warn");
    }
    else if (!state.game.ok) { title = "Choose a game folder"; sub = "In Settings"; box.classList.add("bad"); }
    else if (state.pending && state.pending.files) { title = "Update available"; sub = `${state.pending.files} file(s), ${bytes(state.pending.bytes)}`; box.classList.add("warn"); }
    else if (!state.online) { title = "Offline"; sub = "Can't reach xplab.shop"; box.classList.add("warn"); }
    else title = "Game Up to Date";
    $("#status-title").textContent = title;
    $("#status-sub").textContent = sub;
  }

  function renderSync() {
    const path = state.settings.gamePath || "Not set";
    $("#game-path").textContent = path;
    $("#settings-path").textContent = path;
    const hint = $("#game-check");
    const fresh = !state.game.ok && state.game.installable;
    if (fresh) {
      hint.textContent = state.pending
        ? `Not installed yet: Install downloads ${bytes(state.pending.bytes)} here` + (state.freeBytes != null ? ` (${bytes(state.freeBytes)} free).` : ".")
        : "Not installed yet.";
      hint.className = "hint";
    }
    else if (!state.game.ok) { hint.textContent = state.game.reason; hint.className = "hint bad"; }
    else if (!state.game.funcLauncher) { hint.textContent = "Func launcher missing from this install."; hint.className = "hint bad"; }
    else { hint.textContent = "The Culling found."; hint.className = "hint"; }
    $("#sync-installed").textContent = state.installed || "Not installed";
    $("#sync-release").textContent = state.release || (state.online ? "-" : "Offline");
    $("#sync-pending").textContent = !state.pending ? "-" : state.pending.files ? `${state.pending.files} file(s), ${bytes(state.pending.bytes)}` : "Nothing";
    $("#run-sync").disabled = syncing || !(state.game.ok || (fresh && state.online));
    $("#run-sync").textContent = fresh ? "Install" : "Verify & Sync";
    $("#update-launcher").textContent = state.build ? state.build.label : "v" + state.appVersion;
    $("#update-patch").textContent = state.release ? `${state.installed || "none"} installed, ${state.release} available` : "-";
    $("#update-server").textContent = new URL(state.settings.manifestUrl).host;
    $("#update-note").textContent = state.error ? "Last check: " + state.error : state.online ? "Connected to the update server." : "";
    $("#opt-intro").checked = state.settings.playIntro;
    $("#opt-close").checked = state.settings.closeOnLaunch;
    $$("[data-link]").forEach((b) => { b.hidden = !state.settings.links[b.dataset.link]; });
  }

  function renderPlay() {
    const btn = $("#play");
    btn.classList.remove("working", "secondary");
    btn.disabled = false;
    let label = "Play";
    if (syncing) { label = "Syncing"; btn.classList.add("working"); btn.disabled = true; }
    else if (!state.game.ok && state.game.installable && state.online) { label = "Install"; btn.classList.add("working"); }
    else if (!state.game.ok && state.game.installable) { label = "Offline"; btn.classList.add("secondary"); btn.disabled = true; }
    else if (!state.game.ok) { label = "Set game folder"; btn.classList.add("secondary"); }
    else if (state.pending && state.pending.files) { label = "Update"; btn.classList.add("working"); }
    $("#play-label").textContent = label;
  }

  function render() {
    renderServers();
    renderStatus();
    renderSync();
    renderPlay();
  }

  // ---------------------------------------------------------------- actions
  async function refreshPings() {
    const btn = $("#refresh-servers");
    btn.classList.add("spin");
    try {
      for (const p of await api.pingServers()) pings[p.id] = p;
    } finally {
      btn.classList.remove("spin");
      renderServers();
    }
  }

  async function chooseServer(id) {
    state = await call(api.setSetting, "serverId", id);
    render();
  }

  async function chooseFolder() {
    state = await call(api.chooseGameFolder);
    render();
  }

  async function runSync() {
    if (syncing) return;
    syncing = true;
    selectTab("sync");
    $("#sync-progress").hidden = false;
    render();
    try {
      const r = await call(api.sync);
      state = r;
      toast(r.synced && r.synced.files ? `Installed ${r.synced.files} file(s), ${bytes(r.synced.bytes)}.` : "Everything is up to date.", "info");
    } catch (e) {
      /* toast already shown */
    } finally {
      syncing = false;
      $("#sync-progress").hidden = true;
      state = await api.state();
      render();
    }
  }

  // Download speed: a moving average over progress events, for the time left.
  const rate = { t: 0, bytes: 0, bps: 0 };
  function speedText(done, total) {
    const now = performance.now();
    if (rate.t && now - rate.t > 400) {
      const bps = (done - rate.bytes) / ((now - rate.t) / 1000);
      if (bps >= 0) rate.bps = rate.bps ? rate.bps * 0.8 + bps * 0.2 : bps;
      rate.t = now; rate.bytes = done;
    } else if (!rate.t) { rate.t = now; rate.bytes = done; }
    if (!rate.bps) return "";
    const left = (total - done) / rate.bps;
    const eta = left > 3600 ? `${Math.floor(left / 3600)} h ${Math.round((left % 3600) / 60)} min` : left > 90 ? `${Math.round(left / 60)} min` : `${Math.max(1, Math.round(left))} s`;
    return ` · ${bytes(rate.bps)}/s · ${eta} left`;
  }

  function onSyncProgress(p) {
    let frac, label;
    if (p.phase === "verify") { frac = p.done / p.total; label = `Verifying ${p.done}/${p.total}`; rate.t = 0; rate.bps = 0; }
    else { frac = p.totalBytes ? p.doneBytes / p.totalBytes : 1; label = `Downloading ${p.file.split("/").pop()} (${bytes(p.doneBytes)} / ${bytes(p.totalBytes)})` + speedText(p.doneBytes, p.totalBytes); }
    $("#sync-progress-fill").style.width = Math.round(frac * 100) + "%";
    $("#sync-progress-pct").textContent = Math.round(frac * 100) + "%";
    $("#sync-progress-label").textContent = label;
  }

  async function play() {
    if (!state.game.ok && state.game.installable) return runSync();
    if (!state.game.ok) { selectTab("settings"); return chooseFolder(); }
    if (state.pending && state.pending.files) return runSync();
    const btn = $("#play");
    btn.disabled = true;
    btn.classList.add("working");
    $("#play-label").textContent = "Launching";
    try {
      await call(api.play);
    } catch (e) {
      /* toast already shown */
    } finally {
      setTimeout(renderPlay, 2500);
    }
  }

  async function checkUpdates() {
    const btn = $("#check-updates");
    btn.disabled = true;
    try {
      state = await call(api.checkUpdates);
      toast(state.pending && state.pending.files ? "An update is ready to install." : "You're on the latest release.", "info");
    } catch (e) {
      state = await api.state();
    } finally {
      btn.disabled = false;
      render();
    }
  }

  function wire() {
    $("#refresh-servers").addEventListener("click", refreshPings);
    $("#region-select").addEventListener("change", (e) => chooseServer(e.target.value));
    $("#choose-folder").addEventListener("click", chooseFolder);
    $("#settings-folder").addEventListener("click", chooseFolder);
    $("#run-sync").addEventListener("click", runSync);
    $("#check-updates").addEventListener("click", checkUpdates);
    $("#play").addEventListener("click", play);
    $("#opt-intro").addEventListener("change", async (e) => { state = await call(api.setSetting, "playIntro", e.target.checked); });
    $("#opt-close").addEventListener("change", async (e) => { state = await call(api.setSetting, "closeOnLaunch", e.target.checked); });
    $$("[data-window]").forEach((b) => b.addEventListener("click", () => api.window(b.dataset.window)));
    $$("[data-link]").forEach((b) => b.addEventListener("click", () => call(api.openLink, b.dataset.link)));
    api.onSyncProgress(onSyncProgress);
  }

  async function start() {
    api = window.launcher;
    state = await api.state();
    wire();
    render();
    selectTab("servers");
    refreshPings();
  }

  // Browser preview (no Electron): a stand-in API with sample data.
  if (window.launcher) {
    start();
  } else {
    const s = document.createElement("script");
    s.src = "dev-mock.js";
    s.onload = start;
    document.body.appendChild(s);
  }
})();
