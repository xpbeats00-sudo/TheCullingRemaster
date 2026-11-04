// The launcher's diagnostics log: one JSON line per event in launcher.log
// (the app's logs folder), rolled to launcher.1.log at 1 MB. The last lines
// are kept in memory for "Copy diagnostics".
"use strict";

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 1 << 20;
const KEEP = 200;

function createLog(dir) {
  const file = path.join(dir, "launcher.log");
  const recent = [];
  function log(event, data = {}) {
    const line = JSON.stringify(Object.assign({ t: new Date().toISOString(), event }, data));
    recent.push(line);
    if (recent.length > KEEP) recent.shift();
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, "launcher.1.log")); } catch { /* new log */ }
      fs.appendFileSync(file, line + "\n");
    } catch { /* logging never breaks the launcher */ }
  }
  log.file = file;
  log.recent = () => recent.slice();
  return log;
}

module.exports = { createLog };
