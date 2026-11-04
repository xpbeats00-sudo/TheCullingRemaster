// Local stand-in for The Culling's "ClientWeb" backend.
// Serves the root data / login / match-queue HTTP endpoints and the socket.io
// channel the front-end UI talks to, so the menus come up "online" and Solo /
// Duos queues drop you straight into a local match against bots.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const socketio = require('socket.io');
const eioParser = require('engine.io-parser');

// The game's socket.io 1.x client (engine.io-client 1.x in Coherent GT) asks
// for binary polling and can only parse binary-framed payloads. engine.io 3
// sends text unless a packet is binary, so restore the 1.x behaviour of
// always framing as binary when the client supports it.
const stockEncodePayload = eioParser.encodePayload;
eioParser.encodePayload = function (packets, supportsBinary, callback) {
  if (supportsBinary) return eioParser.encodePayloadAsBinary(packets, callback);
  return stockEncodePayload.call(this, packets, supportsBinary, callback);
};

const HOST = process.env.CULLING_HOST || '127.0.0.1';
const PORT = parseInt(process.env.CULLING_PORT || '8000', 10);
// The address clients are told to use (behind HTTPS on the VPS, e.g.
// https://xplab.shop:8443); defaults to the listen address for local play.
const BASE = (process.env.CULLING_PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/+$/, '');
const DATA_DIR = process.env.CULLING_DATA_DIR || path.join(__dirname, 'data');
const PROFILE_FILE = path.join(DATA_DIR, 'profiles.json');

// Queue name -> offline map index understood by the game's StartOfflineMatch
// (0 = Jungle / "The Island", 1 = Prison).
const QUEUE_MAPS = { ffa: 0, coop2: 0, lightning: 0, ranked_ffa: 0 };
const ranked = require('./ranked');
const { Sessions, MatchTickets, rateLimiter, clientIp } = require('./session');
const { CoalescedJsonFile, writeAtomicSync } = require('./store');
const { createMetrics, metricsAllowed } = require('./metrics');

// How often changed profiles / sessions are written (at most once per this
// many ms; a crash loses at most about this much, a graceful stop nothing).
const SAVE_DELAY_MS = parseInt(process.env.CULLING_SAVE_DELAY_MS || '1000', 10);
// One line per HTTP request and socket event: useful locally, too chatty for
// the shared server (the service runs with NODE_ENV=production).
const ACCESS_LOG = process.env.CULLING_ACCESS_LOG
  ? process.env.CULLING_ACCESS_LOG !== '0'
  : process.env.NODE_ENV !== 'production';
// Limits for what clients can make the server hold.
const MAX_USERID_LENGTH = 64;
const MAX_SOCKETS_PER_IP = parseInt(process.env.CULLING_MAX_SOCKETS_PER_IP || '32', 10);
const LOGIN_TIMEOUT_MS = 60 * 1000;
const MAX_PROFILES = parseInt(process.env.CULLING_MAX_PROFILES || '100000', 10);

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}
const accessLog = ACCESS_LOG ? log : () => {};

const metrics = createMetrics({ gauges: () => gauges() });

// ---------------------------------------------------------------- items

// Every customization item: the game's own (built from the paks by
// patch/build_catalog.py) are owned by every player for free; custom content
// added by the patch generators (catalog entries with a "source") is bought
// with cull credits, which matches pay out.
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
let catalog = [];
try { catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch (e) {
  console.warn('No item catalog at', CATALOG_FILE, '- customization will be empty');
}
const CATALOG_VERSION = 'local-' + crypto.createHash('sha1').update(JSON.stringify(catalog)).digest('hex').slice(0, 12);
const NOT_OWNABLE = new Set(['CullingCurrencyDataAsset', 'CullCrateDataAsset']);

const isCustom = (i) => Boolean(i.source);
// Ranked rewards are earned, never sold.
const isForSale = (i) => isCustom(i) && !i.rankedReward;
const catalogByTid = new Map(catalog.map((i) => [i.tid, i]));

// Short keys are what the game's native parser reads for each type.
let inventoryTypesCache = null;
function inventoryTypes() {
  return catalog.map((i) => ({
    tid: i.tid,
    tn: i.displayName,
    pc: Math.round(i.purchaseCost),
    ais: isForSale(i),
    mq: i.maxQuantity,
    r: i.rarity,
    rv: Math.round(i.purchaseCost * i.resale),
    ppc: Math.round(i.premiumCost),
    aps: i.premiumPurchasable,
    ctg: i.storeCategory,
    ftr: false,
    nw: false,
    osl: false
  }));
}

// Custom camos are a one-time purchase: owning a camo's skin on one weapon
// owns that camo on every weapon. The camo is the part of the asset name after
// "_XP_" (".../IceAxe_XP_Lava_Storm" -> "Lava_Storm").
const camoKey = (i) => (i.source === 'xp-camos' ? String(i.asset).split('_XP_')[1] || null : null);

function ownedCamos(p) {
  const out = new Set();
  for (const tid of p.owned || []) {
    const key = camoKey(catalogByTid.get(tid) || {});
    if (key) out.add(key);
  }
  return out;
}

function ownsItem(p, i, camos = ownedCamos(p)) {
  return (p.owned || []).includes(i.tid) || camos.has(camoKey(i));
}

function ownedItems(p) {
  const camos = ownedCamos(p);
  return catalog.filter((i) => !NOT_OWNABLE.has(i.class) && (!isCustom(i) || ownsItem(p, i, camos)))
    .map((i) => ({ i: i.tid, q: 1 }));
}

// Cull credits: a starting balance, then earned in matches.
const STARTING_CREDITS = 10000;
const ECONOMY_VERSION = 1;

function matchCredits(r) {
  return 100 + 25 * r.kills + Math.floor(r.damage / 20) + Math.floor(r.timeAlive / 30) + (r.victory ? 400 : 0);
}

// ---------------------------------------------------------------- levels

// XP needed per level, reported by the game itself (GetLevelXPHigh) the first
// time the menu connects; persisted so the server can level players up.
const LEVELS_FILE = path.join(DATA_DIR, 'levels.json');
let levelXPHigh = [];
try { levelXPHigh = JSON.parse(fs.readFileSync(LEVELS_FILE, 'utf8')); } catch (e) { levelXPHigh = []; }

function levelForXP(xp) {
  if (!levelXPHigh.length) return null;
  let level = 1;
  for (let i = 0; i < levelXPHigh.length; i++) {
    if (levelXPHigh[i] > 0 && xp > levelXPHigh[i]) level = i + 2;
    else break;
  }
  return Math.min(level, levelXPHigh.length);
}

// ---------------------------------------------------------------- profiles

fs.mkdirSync(DATA_DIR, { recursive: true });
// No prototype: a client-supplied ID such as "constructor" is never a profile.
let profiles = Object.create(null);
try {
  Object.assign(profiles, JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') {
    // Unreadable profiles.json: keep it for inspection instead of overwriting it with an empty one.
    const keep = PROFILE_FILE + '.unreadable-' + Date.now();
    try { fs.copyFileSync(PROFILE_FILE, keep); } catch (e2) { /* nothing to keep */ }
    console.error('profiles.json could not be read (' + e.message + '); a copy is at ' + keep);
  }
}
const hasProfile = (userID) => typeof userID === 'string' && Object.prototype.hasOwnProperty.call(profiles, userID);

// Atomic (temp file, fsync, rename) and coalesced: at most one write per
// SAVE_DELAY_MS, off the request path. See store.js. Compact JSON: the whole
// file is serialized on the event loop for each write, and indenting made it
// ~70% larger and ~50% slower to produce.
const profileStore = new CoalescedJsonFile(PROFILE_FILE, () => JSON.stringify(profiles), {
  delayMs: SAVE_DELAY_MS,
  onError: (e) => { metrics.error('save'); log('saving profiles failed:', e.message); }
});
function saveProfiles() {
  profileStore.markDirty();
}

function getProfile(userID) {
  if (!hasProfile(userID)) {
    profiles[userID] = {
      userID,
      cullCredits: STARTING_CREDITS,
      premiumCurrency: 999999,
      owned: [],
      economy: ECONOMY_VERSION,
      cardID: 0,
      createdAt: Date.now(),
      stats: {
        damage_Axe: 0, damage_Blade: 0, damage_Bleed: 0, damage_Bludgeon: 0,
        damage_Bow: 0, damage_Explosion: 0, damage_Fists: 0, damage_Gun: 0,
        damage_Other: 0, damage_Self: 0, damage_Spear: 0, damage_Throw: 0,
        damage_Trap: 0, funcEarned: 0, gamesPlayed: 0, kills: 0, level: 1,
        minutesAlive: 0, mmr: 0, mmrUncertainty: 0, rank: 0, rp: 0,
        rpForNextRank: 100, rpTowardsNextRank: 0, totalDamage: 0, wins: 0, xp: 0
      }
    };
    saveProfiles();
  }
  const p = profiles[userID];
  if ((p.economy || 0) < ECONOMY_VERSION) {
    // Profiles from before the shop had 999999 credits and everything owned.
    p.cullCredits = STARTING_CREDITS;
    p.owned = p.owned || [];
    p.economy = ECONOMY_VERSION;
    saveProfiles();
  }
  return p;
}

function sendPlayer(socket, p) {
  socket.emit('player-response', {
    data: { player: { cullCredits: p.cullCredits, premiumCurrency: String(p.premiumCurrency), migrated: true } }
  });
}

// Read-only view of a player (other players' cards, season summaries): never
// creates a profile, so lookups can't grow profiles.json.
function peekProfile(userID) {
  return hasProfile(userID) ? profiles[userID] : null;
}

// Login tokens (persisted) and the match tickets results are paid against.
const sessions = new Sessions(path.join(DATA_DIR, 'sessions.json'), Date.now, {
  saveDelayMs: SAVE_DELAY_MS,
  onSaveError: (e) => { metrics.error('save'); log('saving sessions failed:', e.message); }
});
const tickets = new MatchTickets();
const allowHttp = rateLimiter(20, 60);
const allowSocket = rateLimiter(30, 90);
// New profiles per address: a burst of 10, then one a minute.
const allowNewProfile = rateLimiter(1 / 60, 10);

function userFromRequest(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? sessions.userFor(m[1]) : null;
}

const requestIp = (req) => clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
const socketIp = (socket) => clientIp(socket.handshake.address, socket.handshake.headers['x-forwarded-for']);

function normalizeUserID(raw) {
  let id = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!id) id = 'steam:76561198000000000';
  if (!id.includes(':')) id = 'steam:' + id;
  return id;
}

// A user ID the server will store: short, printable, no control characters.
const validUserID = (id) => typeof id === 'string' && id.length <= MAX_USERID_LENGTH && /^[\x21-\x7e]+$/.test(id);

// ---------------------------------------------------------------- HTTP

const app = express();
app.disable('x-powered-by');
let stopping = false;

// Telemetry, for the VPS operator only: answered to loopback connections
// that carry no proxy headers. Caddy always adds X-Forwarded-For, so
// https://<domain>/metrics is refused even though Caddy itself is loopback.
app.get('/metrics', (req, res) => {
  if (!metricsAllowed(req.socket.remoteAddress, req.headers)) return res.status(404).json({});
  // Load tests start the server with --expose-gc to compare post-GC heap.
  if (req.query.gc === '1' && typeof global.gc === 'function') global.gc();
  res.setHeader('Cache-Control', 'no-store');
  res.json(metrics.report());
});

// Request timing per route (the matched route pattern, so unknown URLs all
// count as one key and the table stays small).
app.use((req, res, next) => {
  const t0 = performance.now();
  res.on('finish', () => {
    const route = req.route ? req.method + ' ' + (Array.isArray(req.route.path) ? req.route.path[0] : req.route.path)
      : res.statusCode === 429 ? 'rate-limited' : req.method === 'OPTIONS' ? 'OPTIONS' : 'unmatched';
    metrics.request(route, res.statusCode, performance.now() - t0);
  });
  next();
});

app.use((req, res, next) => {
  if (stopping) { res.setHeader('Connection', 'close'); return res.status(503).json({ error: 'stopping' }); }
  if (!allowHttp(requestIp(req))) return res.status(429).json({ error: 'too-many-requests' });
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.text({ type: '*/*', limit: '1mb' }));

app.use((req, res, next) => {
  accessLog('HTTP', req.method, req.originalUrl);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function bodyObject(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch (e) { /* fall through */ }
    return Object.fromEntries(new URLSearchParams(req.body));
  }
  return {};
}

function rootData(userID) {
  const data = {
    login: `${BASE}/api/login`,
    socket: BASE,
    matchqueue: `${BASE}/api/matchqueue`,
    news: `${BASE}/api/news`,
    authenticated: false,
    redeemSystemOnline: false,
    challenges: { challengeMap: {} }
  };
  if (userID) {
    const p = getProfile(userID);
    data.authenticated = false; // keep the UI on its normal login -> socket path
    data.userID = userID;
    data.stats = Object.assign({ userID }, p.stats);
  }
  return data;
}

app.get(['/api', '/api/'], (req, res) => {
  res.json(rootData(userFromRequest(req)));
});

app.post('/api/login', (req, res) => {
  const body = bodyObject(req);
  const userID = normalizeUserID(body.userid);
  if (!validUserID(userID)) return res.status(400).json({ error: 'invalid-userid' });
  if (!hasProfile(userID)) {
    if (Object.keys(profiles).length >= MAX_PROFILES) return res.status(503).json({ error: 'server-full' });
    if (!allowNewProfile(requestIp(req))) return res.status(429).json({ error: 'too-many-new-players' });
  }
  const token = sessions.issue(userID);
  getProfile(userID);
  log('login', userID, 'authType=' + body.authType, 'appid=' + body.appid, 'build=' + body.build);
  res.json({ token, redirect: `${BASE}/api`, userID, build: body.build || '0' });
});

app.post('/api/matchqueue', (req, res) => {
  const body = bodyObject(req);
  // The game posts this itself; trust the body's userid only when that
  // player's menu is connected from the same address.
  let userID = userFromRequest(req);
  if (!userID) {
    const claimed = normalizeUserID(body.userid);
    const s = validUserID(claimed) ? socketsByUser.get(claimed) : null;
    if (s && socketIp(s) === requestIp(req)) userID = claimed;
  }
  if (!userID) return res.status(401).json({ error: 'not-logged-in' });
  const queue = queueName(body.queuename);
  log('matchqueue', userID, queue);
  res.json({ status: 'ok', queueName: queue });
  const socket = socketsByUser.get(userID);
  if (socket) startLocalMatch(socket, queue);
  else log('  no socket for', userID, '(' + socketsByUser.size + ' logged in)');
});

// XP for one match against bots, scaled to the game's level curve (level 2
// at 2,000 XP): a win with a few kills is roughly a level early on.
function matchXP(r) {
  return 250                                   // finishing a match
    + 150 * r.kills
    + Math.floor(r.damage)
    + Math.floor(r.timeAlive / 2)
    + (r.victory ? 1500 : 0);
}

// Posted by the in-match HUD (patched hud.js) when you die or win. Paid once
// per match a player's menu started (the HUD has no token, so the ticket is
// found by address when needed).
app.post('/api/matchresult', (req, res) => {
  const body = bodyObject(req);
  const claim = tickets.claim({ userID: userFromRequest(req), ip: requestIp(req) });
  if (claim.error) {
    log('match result rejected', claim.error, requestIp(req));
    return res.status(409).json({ error: claim.error });
  }
  const userID = claim.ticket.userID;
  const p = getProfile(userID);
  // Bounded so a malformed report (e.g. "1e999" -> Infinity) can't write
  // Infinity/NaN credits or XP into profiles.json.
  const bounded = (v, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0);
  const r = {
    victory: body.victory === true || body.victory === 'true',
    kills: bounded(parseInt(body.kills, 10), 200),
    damage: bounded(Number(body.damage), 1e6),
    // No longer than the match has actually run.
    timeAlive: bounded(Number(body.timeAlive), Math.min(4 * 3600, claim.elapsed + 30)),
    func: bounded(parseInt(body.func, 10), 1e6)
  };
  const startXP = p.stats.xp;
  const earned = matchXP(r);
  const credits = matchCredits(r);
  p.cullCredits += credits;
  let rankedResult = null;
  if (p.ranked && p.ranked.pending) {
    const placement = body.victory === true || body.victory === 'true' ? 1 : parseInt(body.placement, 10);
    const out = ranked.finishMatch(p, { matchId: body.matchId, placement, kills: r.kills, damage: r.damage, timeAlive: r.timeAlive },
      Date.now(), rankedGrant(p));
    if (out.error) log('ranked result rejected', out.error, JSON.stringify(body).slice(0, 200));
    else {
      rankedResult = { entry: out.entry, summary: ranked.summary(p) };
      log('ranked result', out.entry.matchId, 'place', out.entry.placement, out.entry.ratingBefore, '->', out.entry.ratingAfter,
        out.entry.tierAfter);
    }
  }
  const s = p.stats;
  s.xp += earned;
  const level = levelForXP(s.xp);
  if (level && level !== s.level) {
    log('level', userID, s.level, '->', level);
    s.level = level;
  }
  s.gamesPlayed += 1;
  s.kills += r.kills;
  s.wins += r.victory ? 1 : 0;
  s.totalDamage += Math.round(r.damage);
  s.minutesAlive += Math.round(r.timeAlive / 60);
  s.funcEarned += r.func;
  p.lastMatch = Object.assign({ at: Date.now(), xpEarned: earned }, r);
  saveProfiles();
  log('match result', userID, JSON.stringify(r), `+${earned} XP (${startXP} -> ${s.xp}), +${credits} credits`);
  const socket = socketsByUser.get(userID);
  if (socket) sendPlayer(socket, p);
  res.json({ startXP, xpEarned: earned, stats: s, credits, ranked: rankedResult });
});

// The HUD asks the game for the level matching the new XP and reports it back.
app.post('/api/setlevel', (req, res) => {
  const level = parseInt(bodyObject(req).level, 10);
  const userID = userFromRequest(req) || tickets.recentUser(requestIp(req));
  if (!userID) return res.status(409).json({ error: 'no-recent-match' });
  if (level > 0 && level <= 1000) {
    const p = getProfile(userID);
    if (level !== p.stats.level) log('level', userID, p.stats.level, '->', level);
    p.stats.level = level;
    saveProfiles();
  }
  res.json({ ok: true });
});

// The menu reports the game's XP curve (XP at the top of each level).
app.post('/api/levelcurve', (req, res) => {
  const raw = bodyObject(req).high;
  if (!Array.isArray(raw) || raw.length > 1000) return res.status(400).json({ error: 'invalid-curve' });
  const high = raw.map(Number).filter((n) => Number.isFinite(n));
  // Keep the strictly increasing prefix; past the max level the game repeats or returns 0.
  const curve = [];
  for (const n of high) {
    if (n > 0 && (!curve.length || n > curve[curve.length - 1])) curve.push(n);
    else break;
  }
  // The curve is the game's, the same for every player: the first report sets
  // it, and after that only the VPS operator (loopback, not through Caddy) can
  // replace it, so no client can change everyone's levels.
  if (curve.length && levelXPHigh.length && !metricsAllowed(req.socket.remoteAddress, req.headers)) {
    if (JSON.stringify(curve) !== JSON.stringify(levelXPHigh)) log('level curve change refused from', requestIp(req));
    return res.json({ ok: true, levels: levelXPHigh.length });
  }
  if (curve.length && JSON.stringify(curve) !== JSON.stringify(levelXPHigh)) {
    levelXPHigh = curve;
    writeAtomicSync(LEVELS_FILE, JSON.stringify(curve));
    log('level curve', curve.length, 'levels; level 2 at', curve[0] + 1, 'XP; max at', curve[curve.length - 1]);
    for (const p of Object.values(profiles)) p.stats.level = levelForXP(p.stats.xp) || p.stats.level;
    saveProfiles();
  }
  res.json({ ok: true, levels: curve.length });
});

app.get('/api/news', (req, res) => res.json({ news: [] }));

app.get(['/health', '/api/health'], (req, res) => res.json({ ok: true, users: socketsByUser.size }));

app.get('/api/ranked', (req, res) => {
  const userID = userFromRequest(req);
  if (!userID) return res.status(401).json({ error: 'not-logged-in' });
  res.json(ranked.summary(getProfile(userID)));
});

// Breadcrumbs from the menus (UiTrace.js): the last one before a UI freeze
// says which step hung.
// Off on the shared server (CULLING_UITRACE=0).
app.post('/api/uitrace', (req, res) => {
  if (process.env.CULLING_UITRACE === '0') return res.status(404).json({});
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(bodyObject(req));
  log('  ui-trace', body.slice(0, 300));
  res.json({});
});

app.use((req, res) => {
  accessLog('  (unhandled HTTP route)', req.method, req.originalUrl.slice(0, 200), JSON.stringify(bodyObject(req)).slice(0, 300));
  res.json({});
});

// Malformed bodies (bad JSON, too large) and handler bugs: a JSON error, no
// stack trace to the client, and counted in /metrics.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) log('HTTP error', req.method, req.originalUrl.slice(0, 200), err.stack || err.message);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? 'server-error' : String(err.type || 'bad-request') });
});

// ---------------------------------------------------------------- socket.io

const server = http.createServer(app);
// Keep-alive connections idle for longer than this are closed (Caddy reuses
// its upstream connections well within it).
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;
// maxHttpBufferSize: engine.io 3 accepts 100 MB messages by default; nothing
// the game sends is more than a few KB.
const io = socketio(server, { pingInterval: 10000, pingTimeout: 30000, cookie: false, maxHttpBufferSize: 1e6 });
const socketsByUser = new Map();
const socketsByIp = new Map();      // address -> open sockets
let connectedSockets = 0;

function gauges() {
  return {
    connectedSockets,
    loggedInUsers: socketsByUser.size,
    profiles: Object.keys(profiles).length,
    sessionTokens: sessions.size,
    openMatchTickets: tickets.open.size,
    rateLimiterKeys: { http: allowHttp.size(), socket: allowSocket.size(), newProfile: allowNewProfile.size() },
    saving: { profiles: profileStore.stats, sessions: sessions.store ? sessions.store.stats : null },
    stopping
  };
}

if (process.env.CULLING_DEBUG_TRANSPORT) {
  server.prependListener('request', (req, res) => {
    if (!req.url.startsWith('/socket.io')) return;
    log('EIO', req.method, req.url, JSON.stringify(req.headers).slice(0, 400));
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => { if (chunks.length) log('EIO body', JSON.stringify(Buffer.concat(chunks).toString('latin1')).slice(0, 300)); });
    const write = res.write.bind(res), end = res.end.bind(res);
    const out = [];
    res.write = (c, ...a) => { if (c) out.push(Buffer.from(c)); return write(c, ...a); };
    res.end = (c, ...a) => {
      if (c && typeof c !== 'function') out.push(Buffer.from(c));
      log('EIO reply', res.statusCode, JSON.stringify(res.getHeader('content-type')), JSON.stringify(Buffer.concat(out).toString('latin1')).slice(0, 300));
      return end(c, ...a);
    };
  });
  server.prependListener('upgrade', (req) => log('EIO upgrade', req.url));
  io.engine.on('connection', (conn) => {
    log('EIO open', conn.id, 'transport=' + conn.transport.name);
    conn.on('upgrade', (t) => log('EIO upgraded', conn.id, 'to', t.name));
    conn.on('packet', (p) => log('EIO in ', conn.id, p.type, String(p.data || '').slice(0, 120)));
    conn.on('packetCreate', (p) => log('EIO out', conn.id, p.type, String(p.data || '').slice(0, 120)));
    conn.on('close', (reason) => log('EIO close', conn.id, reason));
  });
}

function emptyLeaderboard(p) {
  const side = () => ({
    topWins: [], topKills: [], topTenMatches: [],
    tier4TopTen: [], tier3TopTen: [], tier2TopTen: [], tier1TopTen: [], tier0TopTen: [],
    currentSeasonTier: {}, currentSeasonScore: 0,
    currentSeasonWins: p.stats.wins, currentSeasonKills: p.stats.kills
  });
  return { solo: side(), coop: side() };
}

// ---------------------------------------------------------------- ranked

// Tier rewards (design doc section 8): each tier's emblem calling card, plus
// extras: displayName of custom items, optionally only one weapon's skin.
const RANKED_EXTRAS = {
  Hunter: [{ name: 'Teal Current' }],
  Executioner: [{ name: 'Animated - Dark Synthwave' }],
  Reaper: [{ name: 'Lava Storm', asset: 'FiremansAxe_' }],
  Warlord: [{ name: 'Abyss Lightning' }],
  Apex: [{ name: 'Animated - Golden Reaper' }]
};

function rankedGrant(p) {
  return (tier) => {
    const wanted = [{ name: 'Ranked - ' + tier, ranked: true }].concat(RANKED_EXTRAS[tier] || []);
    const granted = [];
    for (const w of wanted) {
      for (const i of catalog) {
        if (!isCustom(i) || i.displayName !== w.name || Boolean(i.rankedReward) !== Boolean(w.ranked)) continue;
        if (w.asset && !i.asset.includes('/' + w.asset)) continue;
        if (!p.owned.includes(i.tid)) { p.owned.push(i.tid); granted.push(i.tid); }
      }
    }
    log('ranked reward', tier, granted.length, 'items');
    return [{ tier, items: granted.length }];
  };
}

// Queue names are short identifiers; anything else is treated as "ffa".
function queueName(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? raw : 'ffa';
}

function startLocalMatch(socket, queue) {
  queue = queueName(queue);
  const mapIndex = Object.prototype.hasOwnProperty.call(QUEUE_MAPS, queue) ? QUEUE_MAPS[queue] : 0;
  tickets.start(socket.userID, socketIp(socket));
  if (String(queue).startsWith('ranked')) {
    const p = getProfile(socket.userID || normalizeUserID());
    const { match, abandoned } = ranked.startMatch(p, Date.now(), rankedGrant(p));
    if (abandoned) log('ranked abandoned', abandoned.matchId, abandoned.ratingBefore, '->', abandoned.ratingAfter);
    log('ranked match', match.id, 'rating', match.ratingBefore, 'mmr', match.mmr);
    saveProfiles();
  }
  socket.emit('join-mm-ack');
  socket.emit('players-in-queue', { count: 1 });
  // One pending match per socket: a repeated join replaces it, a disconnect cancels it.
  clearTimeout(socket.matchTimer);
  socket.matchTimer = setTimeout(() => {
    socket.matchTimer = null;
    if (!socket.connected) return;
    log('match-ready ->', socket.userID, 'offline map', mapIndex);
    socket.emit('match-ready', {
      gameServer: 'offline:' + mapIndex,
      nonce: crypto.randomBytes(8).toString('hex'),
      serverNonce: crypto.randomBytes(8).toString('hex')
    });
  }, 1500);
}

// A short string from a client message, or `fallback`.
const shortString = (v, max, fallback) => (typeof v === 'string' && v.length <= max ? v : fallback);

io.on('connection', (socket) => {
  const ip = socketIp(socket);
  const here = (socketsByIp.get(ip) || 0) + 1;
  if (stopping || here > MAX_SOCKETS_PER_IP) {
    log('socket refused', stopping ? '(stopping)' : '(' + here + ' open from ' + ip + ')');
    socket.disconnect(true);
    return;
  }
  socketsByIp.set(ip, here);
  connectedSockets++;
  socket.ip = ip;
  accessLog('socket connected', socket.id);
  socket.emit('login_ready');
  // A socket that never logs in is closed rather than held forever.
  socket.loginTimer = setTimeout(() => { if (!socket.userID) socket.disconnect(true); }, LOGIN_TIMEOUT_MS);

  socket.use((packet, next) => {
    try {
      const [name, payload] = packet;
      if (stopping || !allowSocket(socket.ip)) { metrics.error('socketDropped'); return; }  // dropped while over the limit
      // Everything but login needs a logged-in socket.
      if (name !== 'login' && !socket.userID) { metrics.error('socketDropped'); return; }
      if (ACCESS_LOG && name !== 'login') accessLog('  <-', name, payload === undefined ? '' : JSON.stringify(payload).slice(0, 300));
      next();
    } catch (e) {
      metrics.error('socketHandler');
    }
  });

  // Every handler is timed for /metrics and can't take the process down: a
  // malformed message that makes one throw is logged, counted and ignored.
  const on = (name, fn) => socket.on(name, (...args) => {
    const t0 = performance.now();
    let failed = false;
    try {
      fn(...args);
    } catch (e) {
      failed = true;
      log('socket handler error', name, socket.userID || socket.id, e.stack || e.message);
    }
    metrics.socketEvent(name, performance.now() - t0, failed);
  });

  // Delayed pushes are dropped if the socket has gone by then.
  const later = (fn, ms) => setTimeout(() => {
    if (!socket.connected) return;
    try { fn(); } catch (e) { metrics.error('socketHandler'); log('delayed push failed', e.message); }
  }, ms);

  on('login', (msg) => {
    // Only a token from /api/login identifies a player.
    const token = msg && typeof msg === 'object' ? msg.token : msg;
    const userID = sessions.userFor(token);
    if (!userID) {
      log('socket login refused (no valid token)', socket.ip);
      socket.emit('auth-fail', { reason: 'invalid-token' });
      socket.disconnect(true);
      return;
    }
    // Logging in again as someone else: forget the old mapping.
    if (socket.userID && socket.userID !== userID && socketsByUser.get(socket.userID) === socket) {
      socketsByUser.delete(socket.userID);
    }
    clearTimeout(socket.loginTimer);
    socket.userID = userID;
    socketsByUser.set(userID, socket);
    const p = getProfile(userID);
    log('socket login', userID);

    socket.emit('auth-response');
    sendPlayer(socket, p);
    socket.emit('update-premium-currency', String(p.premiumCurrency));
    socket.emit('player-online-response', { data: socketsByUser.size });
    socket.emit('player-counts', { online: socketsByUser.size, inQueue: 0 });
    socket.emit('update-queue-status', {
      ffa: { isActive: true }, coop2: { isActive: true }, lightning: { isActive: true }, ranked_ffa: { isActive: true }
    }, Date.now());
    socket.emit('update-average-queue-time', 2000);
    later(sendEntitlements, 2000);
  });

  on('join-mm', (msg) => startLocalMatch(socket, msg && msg.queueName));
  on('leave-mm', () => socket.emit('leave-mm-ack'));
  on('leave-group', () => socket.emit('left-group', 0));

  on('set-card', (msg) => {
    if (!socket.userID) return;
    // Card IDs are item type IDs (the game sends a number or a numeric string).
    const id = msg && msg.cardID;
    const ok = (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && /^\d{1,12}$/.test(id));
    getProfile(socket.userID).cardID = ok ? id : 0;
    saveProfiles();
  });
  on('get-cards', (msg) => {
    const users = msg && Array.isArray(msg.users) ? msg.users.slice(0, 100) : [];
    socket.emit('get-cards-result', {
      cards: users.map((u) => {
        const p = peekProfile(u);
        return { userID: shortString(u, MAX_USERID_LENGTH, ''), cardID: p ? p.cardID : 0, cardLevel: p ? p.stats.level : 1,
          cardRank: p ? p.stats.rank : 0 };
      })
    });
  });

  // Inventory / cosmetics: the item catalog and the player's owned items.
  // The game only asks for owned items now and then, so push them whenever
  // the catalog has (re)loaded as well.
  const sendEntitlements = () => socket.emit('entitlements-response',
    { data: { items: ownedItems(getProfile(socket.userID || normalizeUserID())) } });
  on('get-entitlements', sendEntitlements);
  on('get-inventory-types', (version) => {
    if (version === CATALOG_VERSION) {
      socket.emit('inventory-types-response', { data: { versionOK: true, currentVersion: CATALOG_VERSION } });
    } else {
      // The catalog never changes while running: build the list once.
      if (!inventoryTypesCache) inventoryTypesCache = inventoryTypes();
      socket.emit('inventory-types-response', { data: { versionOK: false, currentVersion: CATALOG_VERSION, types: inventoryTypesCache } });
    }
    later(sendEntitlements, 1000);
  });
  // Custom content costs cull credits; anything else is already owned.
  on('purchase-entitlement', (msg) => {
    const typeId = parseInt(msg && msg.entitlementID, 10);
    const item = catalogByTid.get(typeId);
    const p = getProfile(socket.userID || normalizeUserID());
    if (item && item.rankedReward && !p.owned.includes(typeId)) {
      socket.emit('purchase-fail', { reason: 'ranked-reward' });
      return;
    }
    if (item && isForSale(item) && !ownsItem(p, item)) {
      const price = Math.round(item.purchaseCost);
      if (p.cullCredits < price) {
        log('purchase refused', socket.userID, typeId, `${p.cullCredits} < ${price}`);
        socket.emit('purchase-fail', { reason: 'not-enough-credits' });
        return;
      }
      p.cullCredits -= price;
      p.owned.push(typeId);
      saveProfiles();
      log('purchase', socket.userID, typeId, item.displayName, `-${price} (${p.cullCredits} left)`);
    }
    socket.emit('purchase-success', { data: JSON.stringify({ itemAddData: { typeId, quantity: 1 } }) });
    sendPlayer(socket, p);
    sendEntitlements();
  });
  on('get-premium-types', () => {
    socket.emit('premium-types-response', { data: { versionOK: false, currentVersion: 'local-1', types: [] } });
  });
  on('check-dlc-items', () => socket.emit('check-dlc-items-success'));
  on('redeem-tokens', () => {});
  on('start-item-migration', () => socket.emit('item-migration', { data: {} }));
  on('open-crate', () => socket.emit('open-crate-fail', { reason: 'no-crates' }));
  on('premium-purchase', () => socket.emit('premium-purchase-fail', { message: 'The store is not available on the local server.' }));
  on('purchase-item', () => socket.emit('purchase-item-fail', { message: 'The store is not available on the local server.' }));
  on('purchase-item-authenticated', () => socket.emit('purchase-item-authenticated-fail', { message: 'The store is not available on the local server.' }));

  on('player-leaderboard-request', () => {
    const p = getProfile(socket.userID || normalizeUserID());
    socket.emit('player-leaderboard-response', { data: emptyLeaderboard(p) });
  });
  on('get-season-summary', (msg) => {
    const asked = msg && msg.userID;
    // Echoed back as sent (a string or a number), if it is a sane one.
    const userID = !asked ? socket.userID
      : (typeof asked === 'number' && Number.isFinite(asked)) || shortString(asked, MAX_USERID_LENGTH, null) !== null ? asked : null;
    const wanted = userID === null ? null : normalizeUserID(userID);
    // Someone else's summary is looked up, never created.
    const p = wanted === socket.userID ? getProfile(socket.userID) : peekProfile(wanted);
    socket.emit('season-summary-response', { userID, data: JSON.stringify(emptyLeaderboard(p || BLANK_PROFILE).solo) });
  });
  on('get-friends', () => socket.emit('get-friends-ack', []));
  on('group-invite', () => socket.emit('group-invite-fail', { reason: 'target-offline' }));

  // Private ("custom") lobbies also go straight to a local bot match.
  on('lobby-create', (msg) => {
    socket.lobby = {
      code: crypto.randomBytes(3).toString('hex'),
      owner: socket.userID,
      mapName: shortString(msg && msg.mapName, 64, '') || 'Jungle_P',
      members: [{ user: socket.userID, team: 0 }]
    };
    socket.emit('lobby-update', socket.lobby);
  });
  on('lobby-join', () => socket.emit('lobby-join-fail', { reason: 'not-found' }));
  on('lobby-set-map', (msg) => {
    if (!socket.lobby) return socket.emit('lobby-update-fail', {});
    socket.lobby.mapName = shortString(msg && msg.mapName, 64, '') || socket.lobby.mapName;
    socket.emit('lobby-update', socket.lobby);
  });
  on('lobby-leave', () => { socket.lobby = null; socket.emit('lobby-leave-ack'); });
  on('lobby-start-match', () => {
    const map = socket.lobby && /prison|jungle2/i.test(socket.lobby.mapName) ? 1 : 0;
    tickets.start(socket.userID, socket.ip);
    socket.emit('match-ready', { gameServer: 'offline:' + map, nonce: 'x', serverNonce: 'x' });
  });

  socket.on('disconnect', (reason) => {
    accessLog('socket disconnected', socket.userID || socket.id, reason);
    connectedSockets--;
    const left = (socketsByIp.get(socket.ip) || 1) - 1;
    if (left > 0) socketsByIp.set(socket.ip, left); else socketsByIp.delete(socket.ip);
    clearTimeout(socket.loginTimer);
    clearTimeout(socket.matchTimer);
    if (socket.userID && socketsByUser.get(socket.userID) === socket) socketsByUser.delete(socket.userID);
  });
});

// A stand-in for players with no profile (looked up, never stored).
const BLANK_PROFILE = { stats: { wins: 0, kills: 0, level: 1, rank: 0 }, cardID: 0 };

// ---------------------------------------------------------------- start / stop

// Writes everything unsaved, synchronously. Safe to call more than once.
function flushAll(why) {
  const wroteProfiles = profileStore.flushSync();
  const wroteSessions = sessions.flushSync();
  if (wroteProfiles || wroteSessions) {
    log('saved on ' + why + ':', [wroteProfiles && 'profiles', wroteSessions && 'sessions'].filter(Boolean).join(', '));
  }
}

// Graceful stop. WinSW 2.12 stops the service by attaching to node's console
// and sending CTRL_C_EVENT (Node: SIGINT), then waits <stoptimeout> before
// killing it; Ctrl+C in a terminal is the same signal, SIGTERM is the POSIX
// equivalent, SIGBREAK is Ctrl+Break and SIGHUP the console closing. Data is
// saved first, synchronously, so even a short grace period loses nothing.
// Exit code: WinSW 2.12 ignores it during its own stop, but if node exits by
// itself with 0 it reports the service as stopped (no restart). So only the
// stop requests (SIGINT, SIGTERM) exit 0; a console closing under us exits 1
// and the service's restart-on-failure applies.
function shutdown(signal) {
  const code = signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1;
  if (stopping) return;
  stopping = true;
  log('stopping (' + signal + ')');
  flushAll(signal);
  // From here on every change is written immediately (there should be none:
  // new requests and socket events are refused while stopping).
  profileStore.close();
  if (sessions.store) sessions.store.close();
  // Let replies already in flight go out, then exit.
  io.close();
  server.close();
  setTimeout(() => { flushAll('exit'); process.exit(code); }, 300);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => shutdown(sig));
process.on('exit', () => flushAll('exit'));
process.on('uncaughtException', (e) => {
  // State may be inconsistent: save what is there and let WinSW restart us.
  metrics.error('process');
  log('uncaught exception', e && e.stack ? e.stack : e);
  try { flushAll('crash'); } finally { process.exit(1); }
});
process.on('unhandledRejection', (e) => {
  metrics.error('process');
  log('unhandled rejection', e && e.stack ? e.stack : e);
});

server.listen(PORT, HOST, () => {
  log(`The Culling local server listening on ${BASE}  (ClientWeb root: ${BASE}/api)`);
});
