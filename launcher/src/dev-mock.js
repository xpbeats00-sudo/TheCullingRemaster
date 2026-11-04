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
      serverId: "eu", closeOnLaunch: false, playIntro: true, playerName: "",
      links: { website: "https://xplab.shop/", discord: "https://discord.gg/example", support: "https://xplab.shop/faq.html" }
    },
    game: { ok: true, funcLauncher: true, clientDll: true },
    online: true, error: null, release: "1.0.1", installed: "1.0.1",
    pending: { files: 0, bytes: 0 },
    servers: [
      { id: "eu", name: "The Culling Remaster EU", region: "Europe" },
      { id: "us", name: "The Culling Remaster US", region: "America" }
    ],
    nameSupported: true,
    busy: false
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.launcher = {
    state: async () => JSON.parse(JSON.stringify(state)),
    pingServers: async () => { await wait(400); return [{ id: "eu", ok: true, ms: 16, users: 24 }, { id: "us", ok: true, ms: 32, users: 18 }]; },
    setPlayerName: async (name) => { await wait(150); state.settings.playerName = name.replace(/\s+/g, " ").trim(); return window.launcher.state(); },
    setSetting: async (k, v) => { state.settings[k] = v; return window.launcher.state(); },
    chooseGameFolder: async () => window.launcher.state(),
    checkUpdates: async () => { await wait(600); return window.launcher.state(); },
    sync: async () => {
      const total = 205391611;
      for (let i = 0; i <= 20; i++) { await wait(80); listeners.forEach((cb) => cb({ phase: "download", file: "Victory/Content/Paks/LocalServer-WindowsClient_P.pak", doneBytes: total * i / 20, totalBytes: total })); }
      return Object.assign(await window.launcher.state(), { synced: { files: 1, bytes: total } });
    },
    play: async () => { await wait(800); return true; },
    openLink: async (name) => console.log("open", name),
    window: async (a) => console.log("window", a),
    onSyncProgress: (cb) => listeners.push(cb)
  };
})();
