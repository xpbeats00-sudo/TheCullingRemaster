// Browser preview only: a stand-in for the Electron launcher API with sample
// data, so the screens can be designed without the app. Never loaded inside
// the launcher (main-ui.js only loads it when window.launcher is missing).
(function () {
  "use strict";
  const listeners = [];
  const state = {
    appVersion: "1.1.0",
    build: { version: "1.1.0", commit: "dev", label: "v1.1.0 · build dev" },
    settings: {
      gamePath: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\TheCulling",
      manifestUrl: "https://xplab.shop:8443/remaster/manifest.json",
      serverId: "eu", closeOnLaunch: false, playIntro: true, playerName: "", parallel: 16, maxMBps: 0,
      links: { website: "https://xplab.shop/", discord: "https://discord.gg/example", support: "https://xplab.shop/faq.html" }
    },
    game: { ok: true, funcLauncher: true, clientDll: true },
    online: true, error: null, release: "1.0.1", installed: "1.0.1", previous: "1.0.0",
    pending: { files: 0, bytes: 0, partial: 0, releaseBytes: 205391611 },
    servers: [
      { id: "eu", name: "The Culling Remaster EU", region: "Europe" },
      { id: "us", name: "The Culling Remaster US", region: "America" }
    ],
    nameSupported: true,
    busy: false
  };
  // ?fresh: a PC without the game, installing the whole release (pausable).
  const RELEASE = 6066014658;
  if (/[?&]fresh\b/.test(location.search)) {
    Object.assign(state, {
      game: { ok: false, installable: true, reason: "The game isn't installed yet" },
      release: "1.1.0", installed: null, freeBytes: 156368183296,
      pending: { files: 3559, bytes: RELEASE, partial: 0, releaseBytes: RELEASE }
    });
    state.settings.gamePath = "C:\\Users\\Player\\AppData\\Local\\TheCullingRemaster\\Game";
  }
  let paused = false;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.launcher = {
    state: async () => JSON.parse(JSON.stringify(state)),
    pingServers: async () => { await wait(400); return [{ id: "eu", ok: true, ms: 16, users: 24 }, { id: "us", ok: true, ms: 32, users: 18 }]; },
    setPlayerName: async (name) => { await wait(150); state.settings.playerName = name.replace(/\s+/g, " ").trim(); return window.launcher.state(); },
    setSetting: async (k, v) => { state.settings[k] = v; return window.launcher.state(); },
    chooseGameFolder: async () => window.launcher.state(),
    checkUpdates: async () => { await wait(600); return window.launcher.state(); },
    sync: async () => {
      paused = false;
      const p = state.pending;
      const total = p.bytes || 205391611;
      let done = p.partial;
      while (done < total) {
        await wait(100);
        if (paused) {
          // Kept on disk: finished files leave the plan, the current one is partial.
          const finished = Math.floor(done * 0.9);
          state.pending = { files: Math.max(1, Math.round(p.files * (1 - finished / total))), bytes: total - finished, partial: done - finished, releaseBytes: p.releaseBytes };
          return Object.assign(await window.launcher.state(), { paused: true });
        }
        done = Math.min(total, done + total / 120);
        listeners.forEach((cb) => cb({ phase: "download", file: "Victory/Content/Paks/pakchunk1-WindowsClient.pak", doneBytes: done, totalBytes: total, active: 8 }));
      }
      Object.assign(state, { game: { ok: true, funcLauncher: true, clientDll: true }, installed: state.release });
      state.pending = { files: 0, bytes: 0, partial: 0, releaseBytes: p.releaseBytes };
      return Object.assign(await window.launcher.state(), { synced: { files: p.files, bytes: total } });
    },
    pauseSync: async () => { paused = true; return true; },
    rollback: async () => { const v = state.previous; state.installed = v; state.previous = null; return Object.assign(await window.launcher.state(), { restored: v }); },
    copyDiagnostics: async () => true,
    onStateChanged: () => () => {},
    play: async () => { await wait(800); return true; },
    openLink: async (name) => console.log("open", name),
    window: async (a) => console.log("window", a),
    onSyncProgress: (cb) => listeners.push(cb)
  };
})();
