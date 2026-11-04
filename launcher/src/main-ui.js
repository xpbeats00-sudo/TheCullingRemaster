// The Culling Remaster launcher: main screen.
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  let api = null;
  let state = null;
  let pings = {};
  let syncing = false;
  let pausing = false;          // Pause pressed, downloads stopping
  let repairing = false;        // the running sync rehashes every file
  let syncBase = 0;             // bytes already on disk when this sync started

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
    const resume = resumeInfo();
    if (syncing) { title = pausing ? "Pausing" : "Syncing"; box.classList.add("busy"); }
    else if (resume) {
      title = "Download paused";
      sub = `${Math.floor(resume.have / resume.total * 100)}% done, ${bytes(resume.total - resume.have)} left`;
      box.classList.add("warn");
    }
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

  // A paused or interrupted download: what is already on disk, of how much.
  // A fresh install counts the finished files too; an update only the partial ones.
  function resumeInfo() {
    const p = state.pending;
    if (syncing || !p || !p.files) return null;
    const fresh = !state.game.ok && state.game.installable;
    const have = (fresh ? p.releaseBytes - p.bytes : 0) + p.partial;
    if (have <= 0) return null;
    return { have, total: fresh ? p.releaseBytes : p.bytes };
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
    const resume = resumeInfo();
    if (resume && fresh) hint.textContent = `Paused: Resume continues where it stopped (${bytes(resume.total - resume.have)} left, ${bytes(state.freeBytes || 0)} free).`;
    const btn = $("#run-sync");
    if (syncing) {
      btn.disabled = pausing;
      btn.textContent = pausing ? "Pausing..." : "Pause";
    } else {
      btn.disabled = !(state.game.ok || (fresh && state.online));
      btn.textContent = resume ? "Resume" : fresh ? "Install" : "Verify & Sync";
    }
    // A paused download keeps its bar, at the point it stopped.
    if (!syncing) {
      $("#sync-progress").hidden = !resume;
      if (resume) {
        const pct = Math.floor(resume.have / resume.total * 100);
        $("#sync-progress-fill").style.width = pct + "%";
        $("#sync-progress-pct").textContent = pct + "%";
        $("#sync-progress-label").textContent = `Paused: ${bytes(resume.have)} of ${bytes(resume.total)} downloaded`;
      }
    }
    $("#update-launcher").textContent = state.build ? state.build.label : "v" + state.appVersion;
    $("#update-patch").textContent = state.release ? `${state.installed || "none"} installed, ${state.release} available` : "-";
    $("#update-server").textContent = new URL(state.settings.manifestUrl).host;
    $("#update-note").textContent = state.error ? "Last check: " + state.error : state.online ? "Connected to the update server." : "";
    $("#opt-intro").checked = state.settings.playIntro;
    $("#opt-close").checked = state.settings.closeOnLaunch;
    $("#opt-parallel").value = String(state.settings.parallel);
    $("#opt-speed").value = String(state.settings.maxMBps);
    const rb = $("#rollback");
    rb.hidden = !state.previous;
    rb.textContent = state.previous ? `Restore previous version (${state.previous})` : "Restore previous version";
    rb.disabled = syncing;
    $("#repair-sync").disabled = syncing || !state.game.ok || !state.online;
    $$("[data-link]").forEach((b) => { b.hidden = !state.settings.links[b.dataset.link]; });
  }

  function renderPlay() {
    const btn = $("#play");
    btn.classList.remove("working", "secondary");
    btn.disabled = false;
    let label = "Play";
    if (syncing) { label = pausing ? "Pausing" : "Pause"; btn.classList.add("working"); btn.disabled = pausing; }
    else if (resumeInfo() && state.online) { label = "Resume"; btn.classList.add("working"); }
    else if (!state.game.ok && state.game.installable && state.online) { label = "Install"; btn.classList.add("working"); }
    else if (!state.game.ok && state.game.installable) { label = "Offline"; btn.classList.add("secondary"); btn.disabled = true; }
    else if (!state.game.ok) { label = "Set game folder"; btn.classList.add("secondary"); }
    else if (state.pending && state.pending.files) { label = "Update"; btn.classList.add("working"); }
    else if (nameNeeded()) { label = "Set your name"; btn.classList.add("secondary"); }
    $("#play-label").textContent = label;
  }

  // ---------------------------------------------------------------- player name
  // The same rules as lib/playername.js (it checks again before saving).
  function checkName(raw) {
    const name = String(raw || "").replace(/\s+/g, " ").trim();
    if (!name) return { error: "Enter a name" };
    if ([...name].length > 32) return { error: "Names are at most 32 characters" };
    if (!/^[\p{L}\p{N} _.\-[\]()!?'#]+$/u.test(name)) return { error: "Use letters, numbers, spaces and _ . - [ ] ( ) ! ? ' #" };
    return { name };
  }
  const nameNeeded = () => state.nameSupported && !state.settings.playerName;

  function renderName(message, kind) {
    const box = $("#player-name");
    const input = $("#name-input");
    box.hidden = !state.nameSupported;
    if (document.activeElement !== input) input.value = state.settings.playerName || "";
    const typed = checkName(input.value);
    const changed = typed.name !== (state.settings.playerName || "");
    box.classList.toggle("needed", nameNeeded() && document.activeElement !== input);
    box.classList.toggle("invalid", kind === "error" || (input.value !== "" && !!typed.error));
    box.classList.toggle("saved", kind === "saved");
    $("#name-save").disabled = !!typed.error || !changed;
    $("#name-hint").textContent = message ||
      (input.value !== "" && typed.error ? typed.error : nameNeeded() ? "Choose the name everyone sees in game" : "Shown to everyone in game");
  }

  async function saveName() {
    const input = $("#name-input");
    const typed = checkName(input.value);
    if (typed.error) { renderName(typed.error, "error"); return false; }
    if (typed.name === state.settings.playerName) { renderName(); return true; }
    try {
      state = await api.setPlayerName(typed.name);
      input.value = state.settings.playerName;
      render();
      renderName("Saved: this is your name in game", "saved");
      return true;
    } catch (e) {
      renderName(errorText(e), "error");
      return false;
    }
  }

  function render() {
    renderServers();
    renderStatus();
    renderSync();
    renderName();
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

  async function pauseSync() {
    if (!syncing || pausing) return;
    pausing = true;
    render();
    try { await api.pauseSync(); } catch { pausing = false; render(); }
  }

  async function runSync(opts) {
    if (syncing) return pauseSync();
    repairing = !!(opts && opts.repair);
    // Progress continues from what is already on disk (a resumed install).
    const p = state.pending;
    syncBase = p && !state.game.ok && state.game.installable ? p.releaseBytes - p.bytes : 0;
    rate.t = 0; rate.bps = 0;
    syncing = true;
    selectTab("sync");
    $("#sync-progress").hidden = false;
    render();
    try {
      const r = await call(api.sync, { repair: repairing });
      state = r;
      if (r.paused) toast("Paused. Your progress is saved: Resume continues where it stopped, even after closing the launcher.", "info");
      else if (repairing) toast(r.synced && r.synced.files ? `Repaired ${r.synced.files} file(s), ${bytes(r.synced.bytes)}. Everything else checked out.` : "Every game file checked out: nothing to repair.", "info");
      else toast(r.synced && r.synced.files ? `Installed ${r.synced.files} file(s), ${bytes(r.synced.bytes)}.` : "Everything is up to date.", "info");
    } catch (e) {
      /* toast already shown */
    } finally {
      syncing = false;
      pausing = false;
      repairing = false;
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
    if (p.phase === "verify") { frac = p.done / p.total; label = `${repairing ? "Repairing: checking" : "Checking"} ${p.done.toLocaleString()} / ${p.total.toLocaleString()} files`; rate.t = 0; rate.bps = 0; }
    else if (p.phase === "install") { frac = p.total ? p.done / p.total : 1; label = p.done < p.total ? `Installing ${p.total.toLocaleString()} files` : "Finalizing"; }
    else {
      const done = syncBase + p.doneBytes, total = syncBase + p.totalBytes;
      frac = total ? done / total : 1;
      const what = p.active > 1 ? `${p.active} files` : p.file.split("/").pop();
      const files = p.filesTotal ? ` · ${p.filesDone.toLocaleString()} / ${p.filesTotal.toLocaleString()} files` : "";
      label = (pausing ? "Pausing" : `Downloading ${what}`) + ` (${bytes(done)} / ${bytes(total)})` + files + speedText(p.doneBytes, p.totalBytes);
    }
    $("#sync-progress-fill").style.width = Math.round(frac * 100) + "%";
    $("#sync-progress-pct").textContent = Math.round(frac * 100) + "%";
    $("#sync-progress-label").textContent = label;
  }

  async function play() {
    if (syncing) return pauseSync();
    if (!state.game.ok && state.game.installable) return runSync();
    if (!state.game.ok) { selectTab("settings"); return chooseFolder(); }
    if (state.pending && state.pending.files) return runSync();
    // The name comes first: an unsaved edit is saved, a missing name asked for.
    const input = $("#name-input");
    if (state.nameSupported && (nameNeeded() || input.value.trim() !== state.settings.playerName)) {
      if (!(await saveName()) || nameNeeded()) { input.focus(); return; }
    }
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
    const nameInput = $("#name-input");
    nameInput.addEventListener("input", () => renderName());
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveName(); } });
    nameInput.addEventListener("blur", () => { if (nameInput.value.trim() && !checkName(nameInput.value).error) saveName(); else renderName(); });
    $("#name-save").addEventListener("mousedown", (e) => e.preventDefault());   // keep focus: save once, not on blur too
    $("#name-save").addEventListener("click", saveName);
    $("#refresh-servers").addEventListener("click", refreshPings);
    $("#region-select").addEventListener("change", (e) => chooseServer(e.target.value));
    $("#choose-folder").addEventListener("click", chooseFolder);
    $("#settings-folder").addEventListener("click", chooseFolder);
    $("#run-sync").addEventListener("click", () => runSync());
    $("#check-updates").addEventListener("click", checkUpdates);
    $("#play").addEventListener("click", play);
    $("#opt-intro").addEventListener("change", async (e) => { state = await call(api.setSetting, "playIntro", e.target.checked); });
    $("#opt-close").addEventListener("change", async (e) => { state = await call(api.setSetting, "closeOnLaunch", e.target.checked); });
    $("#opt-parallel").addEventListener("change", async (e) => { state = await call(api.setSetting, "parallel", Number(e.target.value)); render(); });
    $("#opt-speed").addEventListener("change", async (e) => { state = await call(api.setSetting, "maxMBps", Number(e.target.value)); render(); });
    $("#repair-sync").addEventListener("click", () => runSync({ repair: true }));
    $("#copy-diagnostics").addEventListener("click", async () => {
      try { await call(api.copyDiagnostics); toast("Diagnostics copied: paste them into your message to support.", "info"); } catch { /* toast shown */ }
    });
    $("#rollback").addEventListener("click", async () => {
      if (!confirm(`Restore version ${state.previous}? The current version's files are replaced by the ones kept from before the last update.`)) return;
      try {
        state = await call(api.rollback);
        toast(`Version ${state.restored} restored.`, "info");
      } catch { state = await api.state(); }
      render();
    });
    $$("[data-window]").forEach((b) => b.addEventListener("click", () => api.window(b.dataset.window)));
    $$("[data-link]").forEach((b) => b.addEventListener("click", () => call(api.openLink, b.dataset.link)));
    api.onSyncProgress(onSyncProgress);
  }

  async function start() {
    api = window.launcher;
    // Without the intro, the start-up checks finish after this page shows.
    if (api.onStateChanged) api.onStateChanged(async () => { if (!syncing) { state = await api.state(); render(); } });
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
