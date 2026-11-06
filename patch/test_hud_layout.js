// HUD layout at the resolutions players use: the real hud.html (stock page,
// CSS and images from the paks, the Remaster's scripts from patch/src) in a
// headless browser, driven by patch/hud_harness/harness.js.
//
// For every resolution and scenario it checks that the HUD's parts are on
// screen, don't cover each other, and that names and labels aren't cut off;
// screenshots and every rectangle go to patch/research/hud-harness/report/.
//
// The browser is Microsoft Edge (or Chrome; set HUD_BROWSER to its exe),
// headless, driven over the DevTools protocol: no npm packages needed.
// Coherent GT is not Chromium: what Chromium lays out the same way (flex,
// absolute positions, vw/vh) is checked here; Coherent's missing features
// (CSS grid, object-fit, flex gap) are checked by a source scan below.
//
// usage: node test_hud_layout.js [--no-build] [--only <scenario>]
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const HERE = __dirname;
const SITE = path.join(HERE, "research", "hud-harness");
const REPORT = path.join(SITE, "report");
const JS_DIR = path.join(HERE, "src", "Victory", "Content", "uiresources", "hud", "js");

const RESOLUTIONS = [
  [1280, 720], [1920, 1080], [2560, 1440], [3440, 1440], [1600, 1200]
];
const SCENARIOS = ["match", "duo", "spectate", "showdown", "showdown-end", "scoreboard"];
// Drawn parts that must be fully on screen when shown (containers like the
// 40vw-tall bottom-left column are layout boxes, not drawn).
const ON_SCREEN = ["airdrop", "func", "movement", "armor", "buffs", "health", "stamina", "party", "compass",
  "killfeedFirst", "timer", "weapon0", "weapon4", "weaponTip", "spectator", "spectateButtons", "showdown",
  "showdownBanner", "location", "chat", "eomScoreboard"];
const BOTTOM_LEFT = ["airdrop", "func", "movement", "armor", "buffs", "health", "stamina"];
// Pairs that must not overlap when both are shown.
const APART = [
  ...BOTTOM_LEFT.map((p) => ["party", p]),
  ...BOTTOM_LEFT.map((p) => ["weaponStack", p]),
  ["showdown", "weaponStack"], ["showdown", "compass"], ["showdown", "timer"], ["showdown", "party"],
  ["showdown", "killfeedFirst"], ["showdown", "chat"],
  ["killfeedFirst", "compass"], ["killfeedFirst", "timer"], ["killfeed", "wounds"], ["chat", "compass"],
  ["compass", "timer"], ["compass", "ping"],
  ["spectator", "weaponStack"], ["spectator", "spectateButtons"],
  ["showdownBanner", "compass"]
];

function browserExe() {
  const c = [process.env.HUD_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe"].filter(Boolean);
  return c.find((p) => fs.existsSync(p));
}

function serve(root) {
  const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
    ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff" };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// A minimal DevTools protocol client over Node's own WebSocket.
async function devtools(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hud-harness-"));
  const proc = spawn(exe, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profile,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
    "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").split("\n");
  const ws = new WebSocket("ws://127.0.0.1:" + port + wsPath.trim());
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
    } else if (msg.method == "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push((d.exception && d.exception.description || d.text).split("\n")[0] + " @" + (d.url || "").split("/").pop() + ":" + d.lineNumber);
    } else if (msg.method == "Runtime.consoleAPICalled" && process.env.HUD_DEBUG) {
      console.log("  [console]", msg.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(" ").slice(0, 200));
    }
  };
  const errors = [];
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const n = ++id;
    waiting.set(n, { ok, no });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page("Page.enable");
  await page("Runtime.enable");
  return {
    page,
    errors,
    async close() {
      try { await send("Browser.close"); } catch { /* gone */ }
      ws.close();
      await new Promise((r) => setTimeout(r, 300));
      try { proc.kill(); } catch { /* gone */ }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    }
  };
}

async function evaluate(page, expr) {
  const r = await page("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception || {}));
  return r.result.value;
}

function union(rects) {
  const v = rects.filter((r) => r && r.visible);
  if (!v.length) return null;
  const x = Math.min(...v.map((r) => r.x)), y = Math.min(...v.map((r) => r.y));
  return { x, y, w: Math.max(...v.map((r) => r.x + r.w)) - x, h: Math.max(...v.map((r) => r.y + r.h)) - y, visible: true };
}

function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 1 && h > 1 ? [w, h] : null;
}

function check(rects, clipped, W, H) {
  const problems = [];
  for (const k of ON_SCREEN) {
    const r = rects[k];
    if (!r || !r.visible) continue;
    if (r.x < -1 || r.y < -1 || r.x + r.w > W + 1 || r.y + r.h > H + 1)
      problems.push(`${k} off screen: ${r.x},${r.y} ${r.w}x${r.h} in ${W}x${H}`);
  }
  for (const [a, b] of APART) {
    const ra = rects[a], rb = rects[b];
    if (!ra || !rb || !ra.visible || !rb.visible) continue;
    const o = overlap(ra, rb);
    if (o) problems.push(`${a} overlaps ${b} by ${o[0]}x${o[1]} px`);
  }
  // One line ending in "..." is a deliberate cut (reported as a note); text
  // wrapped out of its box or cut without an ellipsis is a failure.
  for (const c of clipped) {
    if (!c.ellipsis) problems.push(`clipped text ${c.sel} "${c.text}" needs ${c.need}px, has ${c.have}px`);
  }
  return problems;
}

// Coherent GT (the game's UI engine) has no CSS grid, no object-fit and no
// flex gap: styles the Remaster's HUD scripts inject must not rely on them.
function coherentScan() {
  const problems = [];
  for (const f of fs.readdirSync(JS_DIR).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(JS_DIR, f), "utf8");
    // Only inside CSS text the scripts write (quoted strings).
    const strings = src.match(/"(?:[^"\\\n]|\\.)*"/g) || [];
    for (const s of strings) {
      if (/display:\s*grid|grid-template/.test(s)) problems.push(`${f}: CSS grid (unsupported in Coherent GT): ${s.slice(0, 80)}`);
      if (/object-fit/.test(s)) problems.push(`${f}: object-fit (unsupported in Coherent GT): ${s.slice(0, 80)}`);
      if (/[{;\s]gap:\s*[\d.]/.test(s)) problems.push(`${f}: flex gap (unsupported in Coherent GT): ${s.slice(0, 80)}`);
    }
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
  if (!args.includes("--no-build")) execFileSync("python", ["-I", path.join(HERE, "hud_harness.py")], { stdio: "inherit" });

  const scan = coherentScan();
  console.log(scan.length ? "Coherent scan: FAIL\n  " + scan.join("\n  ") : "Coherent scan: PASS");

  const exe = browserExe();
  if (!exe) {
    console.log("BLOCKED: no Edge or Chrome found (set HUD_BROWSER); see docs/HUD_RESOLUTION_AUDIT.md for the manual check");
    process.exit(scan.length ? 1 : 2);
  }
  fs.mkdirSync(REPORT, { recursive: true });
  const server = await serve(SITE);
  const base = "http://127.0.0.1:" + server.address().port + "/uiresources/hud/harness.html";
  const dt = await devtools(exe);
  const results = [];
  let failed = scan.length > 0;
  try {
    for (const scenario of SCENARIOS.filter((s) => !only || s == only)) {
      for (const names of ["short", "long"]) {
        for (const [W, H] of RESOLUTIONS) {
          await dt.page("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
          await dt.page("Page.navigate", { url: `${base}?scenario=${scenario}&names=${names}` });
          let ready = false;
          for (let i = 0; i < 200 && !ready; i++) {
            await new Promise((r) => setTimeout(r, 50));
            ready = await evaluate(dt.page, "!!(window.HudHarness && HudHarness.ready)").catch(() => false);
          }
          assert(ready, `harness not ready: ${scenario} ${W}x${H}`);
          // The HUD must have bound its data like in game, or nothing is measured.
          assert(await evaluate(dt.page, "HudHarness.bound"), `HUD never bound: ${scenario} ${W}x${H}`);
          const pageErrors = dt.errors.splice(0);
          if (pageErrors.length) console.log("  page errors:\n    " + pageErrors.join("\n    "));
          // HUD_EVAL="<js expression>": print it for every layout (debugging).
          if (process.env.HUD_EVAL) console.log("  eval:", JSON.stringify(await evaluate(dt.page, process.env.HUD_EVAL)));
          const rects = await evaluate(dt.page, "HudHarness.measure()");
          rects.weaponStack = union([rects.weapon0, rects.weapon4]);
          const clipped = await evaluate(dt.page, "HudHarness.clipped()");
          const problems = check(rects, clipped, W, H);
          const board = await evaluate(dt.page, "HudHarness.scoreboard()");
          if (scenario == "scoreboard") {
            // Every contestant's row is on screen or can be scrolled to.
            if (!board || board.rows < 24) problems.push(`scoreboard shows ${board ? board.rows : 0} of 24 rows`);
            else if (board.lastBottom > H && !board.scrolls) problems.push(`scoreboard rows run off screen (last ends at ${board.lastBottom}px of ${H}) and don't scroll`);
          }
          const tag = `${scenario}-${names}-${W}x${H}`;
          if (names == "short") {
            const shot = await dt.page("Page.captureScreenshot", { format: "png" });
            fs.writeFileSync(path.join(REPORT, tag + ".png"), Buffer.from(shot.data, "base64"));
          }
          const notes = clipped.filter((c) => c.ellipsis)
            .map((c) => `note: ${c.sel} "${c.text}" ends in "..." (${c.need}px in ${c.have}px)`);
          results.push({ scenario, names, resolution: `${W}x${H}`, problems, notes, rects, clipped, board, pageErrors });
          console.log(`${problems.length ? "FAIL" : "PASS"} ${tag}${problems.concat(notes).map((p) => "\n  " + p).join("")}`);
          if (problems.length) failed = true;
        }
      }
    }
  } finally {
    await dt.close();
    server.close();
  }
  fs.writeFileSync(path.join(REPORT, "report.json"), JSON.stringify({ scan, results }, null, 1));
  console.log(`${results.filter((r) => !r.problems.length).length}/${results.length} layouts pass; report in ${REPORT}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
