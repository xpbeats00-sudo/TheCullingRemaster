// The pages' only bridge to the main process.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function on(channel) {
  return (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("launcher", {
  state: () => ipcRenderer.invoke("state"),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),
  sync: () => ipcRenderer.invoke("sync"),
  pingServers: () => ipcRenderer.invoke("ping-servers"),
  play: () => ipcRenderer.invoke("play"),
  chooseGameFolder: () => ipcRenderer.invoke("choose-game-folder"),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),
  openLink: (name) => ipcRenderer.invoke("open-link", name),
  window: (action) => ipcRenderer.invoke("window", action),
  onSyncProgress: on("sync-progress"),
  // Startup screen: boot progress (p 0..1, label), then hand over.
  onProgress: (cb) => {
    const off = on("boot-progress")(({ p, label }) => cb(p, label));
    ipcRenderer.invoke("boot");
    return off;
  },
  splashDone: () => ipcRenderer.invoke("splash-done")
});
