// electron-builder afterPack hook: flips Electron's fuses on the packaged
// launcher before the installer is made. The launcher's exe can then no
// longer be used as a general Node.js runtime (ELECTRON_RUN_AS_NODE,
// NODE_OPTIONS, --inspect), only loads its own app.asar, and refuses an
// app.asar that doesn't match the hash electron-builder embedded in the exe.
//
// Every fuse is set explicitly (strictlyRequireAllFuses): a fuse a newer
// Electron adds fails the build until it is decided here.
"use strict";

const path = require("path");

module.exports = async function afterPack(context) {
  // @electron/fuses 2 is an ES module.
  const { flipFuses, FuseVersion, FuseV1Options } = await import("@electron/fuses");
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Electron's defaults, kept: no custom V8 snapshot; the pages are file://
    // (loadFile), so file:// keeps its privileges; WebAssembly trap handlers on.
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    [FuseV1Options.WasmTrapHandlers]: true
  });
  console.log("  fuses flipped:", path.basename(exe));
};
