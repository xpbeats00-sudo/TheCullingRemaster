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

  // ---------------------------------------------------------------- news
  // Full-window pictures, one per slide, crossfaded; the text sits on the left.
  const news = (window.LAUNCHER_NEWS || []).slice();
  let slide = 0;
  let slideTimer = null;
  const SLIDE_MS = 9000;
  const two = (n) => String(n).padStart(2, "0");

  function buildNews() {
    const stage = $("#stage");
    const ticks = $("#news-ticks");
    news.forEach((n, i) => {
      const img = document.createElement("img");
      img.className = "stage-img";
      img.src = n.image;
      img.alt = "";
      stage.appendChild(img);
      const t = document.createElement("i");
      ticks.appendChild(t);
    });
    $("#news-total").textContent = two(news.length);
    const single = news.length < 2;
    $(".news-nav").hidden = single;
    $(".news-count").hidden = single;
  }

  function showSlide(i) {
    if (!news.length) return;
    slide = (i + news.length) % news.length;
    const n = news[slide];
    const fill = (s) => String(s).replace("{launcher}", state && state.appVersion || "");
    $$(".stage-img").forEach((img, k) => img.classList.toggle("on", k === slide));
    $$("#news-ticks i").forEach((t, k) => t.classList.toggle("on", k === slide));
    $("#news-index").textContent = two(slide + 1);
    const box = $("#news");
    box.classList.remove("in");
    void box.offsetWidth;            // restart the text's entrance
    box.classList.add("in");
    $("#news-tag").textContent = fill(n.tag);
    $("#news-ver").textContent = fill(n.version || "");
    $("#news-title").textContent = fill(n.title);
    $("#news-text").textContent = fill(n.text);
    const read = $("#news-read");
    read.dataset.link = n.link || "website";
    read.hidden = !(state && state.settings.links[read.dataset.link]);
    schedule();
  }

  // Slides move on by themselves, unless the pointer or focus is on the news.
  let holding = false;
  function schedule() {
    clearTimeout(slideTimer);
    if (news.length > 1 && !holding) slideTimer = setTimeout(() => showSlide(slide + 1), SLIDE_MS);
  }
  function hold(on) { holding = on; schedule(); }

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

  // ---------------------------------------------------------------- drawer
  // Servers, Game Sync, Update and Settings open in a drawer over the news.
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

  function openDrawer(name) {
    const d = $("#drawer");
    const wasOpen = !d.hidden;
    d.hidden = false;
    $(".app").classList.add("drawer-open");
    selectTab(name);
    hold(true);
    if (!wasOpen) $(`.tab[data-tab="${name}"]`).focus();
  }

  function closeDrawer() {
    const d = $("#drawer");
    if (d.hidden) return;
    d.hidden = true;
    $(".app").classList.remove("drawer-open");
    hold(false);
    renderOp();
  }

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
    renderEnv();
  }

  // The selected server in the bottom bar: who's online, and whether it's up.
  function renderEnv() {
    const p = pings[selectedServer().id];
    const online = $("#env-online");
    const live = $("#env-live");
    online.className = "env-online" + (!p ? "" : p.ok ? " ok" : " bad");
    $("#env-online-text").textContent = !p ? "Checking"
      : !p.ok ? "Unreachable"
      : p.users != null ? `${Number(p.users).toLocaleString()} online` : `${p.ms} ms`;
    live.className = "env-live" + (!p ? "" : p.ok ? " ok" : " bad");
    live.textContent = !p ? "..." : p.ok ? "Live" : "Offline";
  }

  function renderStatus() {
    const box = $("#status-game");
    box.className = "status-game";
    let title, sub = "Version " + (state.installed || "-");
    const resume = resumeInfo();
    if (syncing) { title = pausing ? "Pausing" : "Syncing"; box.classList.add("busy"); }
    else if (!state.online && state.offlineStaged > 0) {
      title = "Download paused";
      sub = `${bytes(state.offlineStaged)} kept · reconnect to resume`;
      box.classList.add("warn");
    }
    else if (resume) {
      title = "Download paused";
      sub = `${Math.floor(resume.have / resume.total * 100)}% done, ${bytes(resume.total - resume.have)} left`;
      box.classList.add("warn");
    }
    else if (notInstalled()) {
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
  // No release fully installed yet: a fresh install, or one paused part-way
  // (Victory.exe can already be there; only a finished commit counts).
  function notInstalled() {
    return !state.installed && (state.game.ok || state.game.installable);
  }

  function resumeInfo() {
    const p = state.pending;
    if (syncing || !p || !p.files) return null;
    const fresh = notInstalled();
    const have = (fresh ? p.releaseBytes - p.bytes : 0) + p.partial;
    if (have <= 0) return null;
    return { have, total: fresh ? p.releaseBytes : p.bytes };
  }

  function renderSync() {
    const path = state.settings.gamePath || "Not set";
    $("#game-path").textContent = path;
    $("#settings-path").textContent = path;
    const hint = $("#game-check");
    const fresh = notInstalled();
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
    $("#update-note").textContent = state.launcherUpdate && state.launcherUpdate.error ? state.launcherUpdate.error
      : state.error ? "Last check: " + state.error : state.online ? "Connected to the update server." : "";
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
    $("#build-label").textContent = "Build " + (state.build && state.build.version || state.appVersion);
  }

  // ---------------------------------------------------------------- operation card
  // An install, update or repair while it runs, top left over the news; a
  // paused one keeps its card at the point it stopped (offline too).
  function setOp(o) {
    const card = $("#op-card");
    card.hidden = !o || !$("#drawer").hidden;
    if (!o) return;
    card.classList.toggle("paused", !!o.paused);
    $("#op-kind").textContent = o.kind;
    $("#op-title").textContent = o.title;
    $("#op-file").textContent = o.file || "";
    $("#op-size").textContent = o.size || "";
    $("#op-fill").style.width = o.frac == null ? "0%" : Math.round(o.frac * 100) + "%";
    $("#op-pct").textContent = o.frac == null ? "" : Math.floor(o.frac * 100) + "%";
  }

  let opLive = null;            // the running operation's latest progress
  const gameTitle = () => "The Culling Remaster" + (state.release ? " " + state.release : "");

  function renderOp() {
    if (opLive) return setOp(opLive);
    if (syncing) return setOp({ kind: "Operation in progress · Starting", title: gameTitle(), frac: 0 });
    if (!state.online && state.offlineStaged > 0) {
      return setOp({ kind: "Paused · Offline", title: "The Culling Remaster", paused: true,
        size: `${bytes(state.offlineStaged)} kept · reconnect to resume` });
    }
    const resume = resumeInfo();
    if (resume) {
      return setOp({ kind: "Paused · Progress saved", title: gameTitle(), paused: true,
        frac: resume.have / resume.total, size: `${bytes(resume.have)} / ${bytes(resume.total)} downloaded` });
    }
    setOp(null);
  }

  function renderPlay() {
    const btn = $("#play");
    btn.classList.remove("working", "secondary");
    btn.disabled = false;
    let label = "Play";
    if (syncing) { label = pausing ? "Pausing" : "Pause"; btn.classList.add("working"); btn.disabled = pausing; }
    else if (resumeInfo() && state.online) { label = "Resume"; btn.classList.add("working"); }
    else if (notInstalled() && state.online) { label = "Install"; btn.classList.add("working"); }
    else if (notInstalled()) { label = "Offline"; btn.classList.add("secondary"); btn.disabled = true; }
    else if (!state.game.ok) { label = "Set game folder"; btn.classList.add("secondary"); }
    else if (state.pending && state.pending.files) { label = "Update"; btn.classList.add("working"); }
    else if (accountNeeded()) { label = "Sign in"; btn.classList.add("secondary"); }
    $("#play-label").textContent = label;
  }

  // ---------------------------------------------------------------- account
  // The account comes first: its username is the in-game name, and online
  // play needs it (the launcher asks the server to let the game in as it).
  const accountNeeded = () => state.accountSupported && !state.account;
  let accountMode = "signin";

  function renderAccount() {
    const box = $("#account-box");
    box.hidden = !state.accountSupported;
    const a = state.account;
    box.classList.toggle("signed-out", !a);
    // Nudged once the game is ready to play: signing in is the last step.
    box.classList.toggle("needed", accountNeeded() && !!state.installed);
    $("#account-name").textContent = a ? a.username : "Not signed in";
    $("#account-hint").textContent = a ? "Your name in game" : "Needed to play online";
    $("#account-open").hidden = !!a;
    $("#account-signout").hidden = !a;
  }

  function setAccountMode(mode) {
    accountMode = mode;
    const create = mode === "create";
    $$(".modal-tab").forEach((t) => {
      const on = t.dataset.mode === mode;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on);
    });
    $$("#account-form [data-create]").forEach((el) => { el.hidden = !create; });
    $$("#account-form [data-signin]").forEach((el) => { el.hidden = create; });
    $("#account-title").textContent = create ? "Create your account" : "Sign in";
    $("#acc-submit").textContent = create ? "Create account" : "Sign in";
    $("#acc-password").autocomplete = create ? "new-password" : "current-password";
    $("#acc-error").textContent = "";
  }

  function openAccount(mode) {
    setAccountMode(mode || accountMode);
    $("#account-modal").hidden = false;
    $("#acc-password").value = "";
    $("#acc-confirm").value = "";
    $("#acc-username").focus();
  }

  function closeAccount() {
    $("#account-modal").hidden = true;
    $("#acc-password").value = "";
    $("#acc-confirm").value = "";
    $("#acc-error").textContent = "";
    $("#account-open").focus();
  }

  async function submitAccount(e) {
    e.preventDefault();
    const btn = $("#acc-submit");
    const form = {
      username: $("#acc-username").value,
      password: $("#acc-password").value
    };
    if (accountMode === "create") {
      form.email = $("#acc-email").value;
      form.confirm = $("#acc-confirm").value;
      if (form.password !== form.confirm) { $("#acc-error").textContent = "The passwords don't match"; $("#acc-confirm").focus(); return; }
    }
    btn.disabled = true;
    $("#acc-error").textContent = "";
    try {
      const r = accountMode === "create" ? await api.createAccount(form) : await api.signIn(form);
      state = r;
      closeAccount();
      render();
      if (accountMode === "create") {
        toast(r.claimed ? `Welcome, ${state.account.username}! Your progress on this server moved to your new account.` : `Welcome, ${state.account.username}! Your account is ready.`, "info");
      } else {
        toast(`Signed in as ${state.account.username}.`, "info");
      }
    } catch (err) {
      $("#acc-error").textContent = errorText(err);
    } finally {
      btn.disabled = false;
    }
  }

  async function signOut() {
    state = await call(api.signOut);
    render();
    toast("Signed out.", "info");
  }

  function render() {
    renderServers();
    renderStatus();
    renderSync();
    renderAccount();
    renderPlay();
    renderOp();
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
    syncBase = p && notInstalled() ? p.releaseBytes - p.bytes : 0;
    rate.t = 0; rate.bps = 0;
    syncing = true;
    opLive = null;
    $("#sync-progress").hidden = false;
    render();
    try {
      const r = await call(api.sync, { repair: repairing });
      state = r;
      if (r.paused && r.lost) toast(r.message || "Connection lost — Resume when you're back online");
      else if (r.paused) toast("Paused. Your progress is saved: Resume continues where it stopped, even after closing the launcher.", "info");
      else if (repairing) toast(r.synced && r.synced.files ? `Repaired ${r.synced.files} file(s), ${bytes(r.synced.bytes)}. Everything else checked out.` : "Every game file checked out: nothing to repair.", "info");
      else toast(r.synced && r.synced.files ? `Installed ${r.synced.files} file(s), ${bytes(r.synced.bytes)}.` : "Everything is up to date.", "info");
    } catch (e) {
      /* toast already shown */
    } finally {
      syncing = false;
      pausing = false;
      repairing = false;
      opLive = null;
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

  // The launcher updating itself: it restarts on its own when done.
  async function onLauncherUpdate(p) {
    const v = UiLogic.launcherUpdateView(p, bytes);
    if (!v) {
      // It failed: the card goes, the screen shows the launcher as it is.
      if (opLive && opLive.launcher) opLive = null;
      if (p && p.error) toast(p.error);
      if (!syncing) state = await api.state();
      render();
      return;
    }
    const box = $("#status-game");
    box.className = "status-game busy";
    $("#status-title").textContent = v.title;
    $("#status-sub").textContent = v.sub;
    opLive = v.op;
    setOp(opLive);
    const btn = $("#play");
    btn.disabled = true;
    btn.classList.add("working");
    $("#play-label").textContent = "Updating";
  }

  function onSyncProgress(p) {
    if (p.phase === "launcher") return onLauncherUpdate(p);
    let frac, label, op;
    if (p.phase === "verify") {
      frac = p.done / p.total;
      label = `${repairing ? "Repairing: checking" : "Checking"} ${p.done.toLocaleString()} / ${p.total.toLocaleString()} files`;
      rate.t = 0; rate.bps = 0;
      op = { kind: `Operation in progress · ${repairing ? "Repairing" : "Verifying"}`, file: "Checking every game file",
        size: `${p.done.toLocaleString()} / ${p.total.toLocaleString()} files` };
    }
    else if (p.phase === "install") {
      frac = p.total ? p.done / p.total : 1;
      label = p.done < p.total ? `Installing ${p.total.toLocaleString()} files` : "Finalizing";
      op = { kind: "Operation in progress · Installing", file: label, size: `${p.done.toLocaleString()} / ${p.total.toLocaleString()} files` };
    }
    else {
      const done = syncBase + p.doneBytes, total = syncBase + p.totalBytes;
      frac = total ? done / total : 1;
      const what = p.active > 1 ? `${p.active} files` : p.file.split("/").pop();
      const files = p.filesTotal ? `${p.filesDone.toLocaleString()} / ${p.filesTotal.toLocaleString()} files` : "";
      const verb = UiLogic.downloadVerb(p, pausing);
      const speed = verb === "Downloading" ? speedText(p.doneBytes, p.totalBytes) : "";
      label = (verb === "Downloading" ? `Downloading ${what}` : verb === "Reconnecting" ? "Connection trouble: reconnecting" : verb) +
        ` (${bytes(done)} / ${bytes(total)})` + (files ? " · " + files : "") + speed;
      op = { kind: `Operation in progress · ${verb}`,
        file: verb === "Reconnecting" ? "Waiting for the connection to come back"
          : p.active > 1 ? `${p.file.split("/").pop()} and ${p.active - 1} more` : p.file.split("/").pop(),
        size: (files ? files + " · " : "") + `${bytes(done)} / ${bytes(total)}` + speed };
    }
    $("#sync-progress-fill").style.width = Math.round(frac * 100) + "%";
    $("#sync-progress-pct").textContent = Math.round(frac * 100) + "%";
    $("#sync-progress-label").textContent = label;
    opLive = Object.assign(op, { title: gameTitle(), frac });
    setOp(opLive);
  }

  async function play() {
    if (syncing) return pauseSync();
    if (notInstalled()) return runSync();
    if (!state.game.ok) { openDrawer("settings"); return chooseFolder(); }
    if (state.pending && state.pending.files) return runSync();
    // The account comes first.
    if (accountNeeded()) return openAccount("signin");
    const btn = $("#play");
    btn.disabled = true;
    btn.classList.add("working");
    $("#play-label").textContent = "Launching";
    try {
      await call(api.play);
    } catch (e) {
      // Signed out on the server (a password reset, an old sign-in): sign in again.
      state = await api.state();
      render();
      if (accountNeeded()) openAccount("signin");
    } finally {
      setTimeout(renderPlay, 2500);
    }
  }

  async function checkUpdates() {
    const btn = $("#check-updates");
    btn.disabled = true;
    try {
      state = await call(api.checkUpdates);
      if (state.restarting) { toast(`Installing launcher ${state.launcherUpdate.version}: it restarts by itself.`, "info"); return; }
      toast(state.pending && state.pending.files ? "An update is ready to install." : "You're on the latest release.", "info");
    } catch (e) {
      state = await api.state();
    } finally {
      btn.disabled = false;
      opLive = UiLogic.keepOp(opLive, state);
      render();
    }
  }

  function wire() {
    $("#account-open").addEventListener("click", () => openAccount("signin"));
    $("#account-signout").addEventListener("click", signOut);
    $$(".modal-tab").forEach((t) => t.addEventListener("click", () => setAccountMode(t.dataset.mode)));
    $("#account-form").addEventListener("submit", submitAccount);
    $("#acc-cancel").addEventListener("click", closeAccount);
    $("#account-modal").addEventListener("keydown", (e) => { if (e.key === "Escape") closeAccount(); });
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
    // The drawer: the bottom bar's buttons, the build number, the server status.
    $("#open-settings").addEventListener("click", () => openDrawer("settings"));
    $("#open-repair").addEventListener("click", () => openDrawer("sync"));
    $("#build-label").addEventListener("click", () => openDrawer("update"));
    $("#env-online").addEventListener("click", () => openDrawer("servers"));
    $("#drawer-close").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("#account-modal").hidden) closeDrawer();
    });
    // The news: arrows, and arrow keys while the news has focus.
    $("#news-read").addEventListener("click", () => call(api.openLink, $("#news-read").dataset.link));
    $("#news-prev").addEventListener("click", () => showSlide(slide - 1));
    $("#news-next").addEventListener("click", () => showSlide(slide + 1));
    for (const el of [$("#news"), $(".news-nav")]) {
      el.addEventListener("mouseenter", () => hold(true));
      el.addEventListener("mouseleave", () => hold(!$("#drawer").hidden));
      el.addEventListener("focusin", () => hold(true));
      el.addEventListener("focusout", () => hold(!$("#drawer").hidden));
    }
    api.onSyncProgress(onSyncProgress);
  }

  async function start() {
    api = window.launcher;
    // Without the intro, the start-up checks finish after this page shows.
    if (api.onStateChanged) api.onStateChanged(async () => {
      if (syncing) return;
      state = await api.state();
      opLive = UiLogic.keepOp(opLive, state);
      render();
    });
    state = await api.state();
    buildNews();
    wire();
    render();
    selectTab("servers");
    showSlide(0);
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
