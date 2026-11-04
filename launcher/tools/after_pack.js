// electron-builder afterPack hook: flips Electron's fuses on the packaged
// launcher before the installer is made. The launcher's exe can then no
// longer be used as a general Node.js runtime (ELECTRON_RUN_AS_NODE,
// NODE_OPTIONS, --inspect) and only loads its own app.asar.
"use strict";

const path = require("path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

module.exports = async function afterPack(context) {
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true
  });
  console.log("  fuses flipped:", path.basename(exe));
};
