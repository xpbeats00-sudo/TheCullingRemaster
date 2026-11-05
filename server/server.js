// Local stand-in for The Culling's "ClientWeb" backend.
// Serves the root data / login / match-queue HTTP endpoints and the socket.io
// channel the front-end UI talks to, so the menus come up "online" and Solo /
// Duos queues drop you straight into a local match against bots.

const fs = require('fs');
const path = require('path');
const { ShowdownSeries, seriesPayout } = require('./showdown');
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
// The two offline matches the game can start (DefaultGame.ini OfflineMap /
// OfflineMap2): the lobby's map vote picks one.
const MAPS = { jungle: 0, prison: 1 };
// Contestants the game places on each map with patch_exe.py's 24 cap: Jungle
// has 24 player starts. Prison has 16, and whether more than 16 spawn there
// hasn't been measured, so it is scored as 16 (never more than it has).
const FIELD_BY_MAP = { jungle: 24, prison: 16 };
// Showdown (patch/make_showdown.py): you against one rival in the Jungle centre
// arena. No lobby or map vote; the menu starts it from "showdown:<format>".
// Rounds: first to 4 (ShowdownSeries), all in one match with the patched exe
// (patch/showdown_rounds.c): the HUD reports each round (/api/showdown/round)
// and the match result that ends the series pays for the series once
// (seriesPayout: its own economy, not a full match per round). A series can be
// over fast, so its result needs 15 s, not the 2 minutes of a normal match. The
// kits (the same for both sides; the game picks the round's) come from
// data/showdown.json, written by make_showdown.py.
const SHOWDOWN = { queue: 'showdown', map: 'arena', format: '1v1', field: 2, roundsToWin: 4,
  minSeconds: parseInt(process.env.CULLING_SHOWDOWN_MIN_SECONDS || '15', 10) };
let showdownKit = null, showdownKits = null;
try {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'showdown.json'), 'utf8'));
  showdownKit = data.kit || null;
  showdownKits = Array.isArray(data.kits) && data.kits.length ? data.kits : null;
} catch (e) { showdownKit = null; showdownKits = null; }
const showdownState = (phase, series) => ({ phase, series, kit: showdownKit, kits: showdownKits, format: SHOWDOWN.format });
const ranked = require('./ranked');
const { Sessions, MatchTickets, rateLimiter, clientIp } = require('./session');
const { CoalescedJsonFile, writeAtomicSync } = require('./store');
const { createMetrics, metricsAllowed } = require('./metrics');
const acc = require('./accounts');
const { MatchLobbies } = require('./matchlobby');
const { Friends } = require('./friends');
const { Activity } = require('./activity');
const { Leaderboard } = require('./leaderboard');

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
const MAX_ACCOUNTS = parseInt(process.env.CULLING_MAX_ACCOUNTS || String(MAX_PROFILES), 10);
// Accounts are required to play online: the game's own /api/login is only
// accepted for an account that pressed PLAY in the launcher from the same
// address (a play grant, see accounts.js and docs/ACCOUNTS.md). 0 turns that
// off (local play, tests, and the window before the launcher with accounts
// is published).
const REQUIRE_ACCOUNT = process.env.CULLING_REQUIRE_ACCOUNT !== '0';

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

// Items with an unlockLevel (the airdrops that start locked, from
// patch/make_airdrop_unlocks.py) are owned once the player reaches it.
const levelReached = (p, i) => !i.unlockLevel || ((p.stats && p.stats.level) || 1) >= i.unlockLevel;

function ownedItems(p) {
  const camos = ownedCamos(p);
  return catalog.filter((i) => !NOT_OWNABLE.has(i.class) && levelReached(p, i) && (!isCustom(i) || ownsItem(p, i, camos)))
    .map((i) => ({ i: i.tid, q: 1 }));
}
const entitlements = (p) => ({ data: { items: ownedItems(p) } });

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

// Season start caps (raise as the season matures): no player above level 14,
// so XP stops at the top of level 14. The game's own level curve is reported
// by the menu (levelXPHigh); without it, level 15 starts above 79,749 XP.
const SEASON = { maxLevel: 14, maxLevelXP: 79749 };
function seasonXPCap() {
  return levelXPHigh.length >= SEASON.maxLevel ? levelXPHigh[SEASON.maxLevel - 1] : SEASON.maxLevelXP;
}
function seasonClamp(p) {
  if (!p || !p.stats) return p;
  if (p.stats.xp > seasonXPCap()) p.stats.xp = seasonXPCap();
  if (p.stats.level > SEASON.maxLevel) p.stats.level = SEASON.maxLevel;
  return p;
}
// A win (or a ranked placement) needs the match to have run this long: the
// ticket starts when the match is sent, so an instant "victory" is refused.
const MIN_MATCH_SECONDS = parseInt(process.env.CULLING_MIN_MATCH_SECONDS || '120', 10);
// The menu logging in again this long after a match started means that match
// is over: a ticket still open then had no result (quit or crash).
const ABANDON_GRACE_MS = parseInt(process.env.CULLING_ABANDON_GRACE_MS || '60000', 10);

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
  leaderboard.changed();
}

// The global leaderboard (leaderboard.js): account players only, by username,
// recomputed at most every CULLING_LEADERBOARD_MIN_AGE_MS after a change.
const leaderboard = new Leaderboard({
  players: function* () {
    for (const [userID, key] of accounts.byUserID) {
      const a = accounts.get(key);
      const p = peekProfile(userID);
      if (a && p) yield { userID, username: a.username, profile: p };
    }
  },
  ranked, maxLevel: SEASON.maxLevel,
  minAgeMs: parseInt(process.env.CULLING_LEADERBOARD_MIN_AGE_MS || '30000', 10)
});

function newProfile(userID) {
  return {
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
}

function getProfile(userID) {
  if (!hasProfile(userID)) {
    profiles[userID] = newProfile(userID);
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
  return seasonClamp(p);
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

// Player accounts (launcher sign-in, play grants); see accounts.js.
const accounts = new acc.Accounts(path.join(DATA_DIR, 'accounts.json'), {
  secretFile: path.join(DATA_DIR, 'ip-hash-secret.txt'),
  saveDelayMs: SAVE_DELAY_MS,
  onSaveError: (e) => { metrics.error('save'); log('saving accounts failed:', e.message); }
});

// Login tokens (persisted) and the match tickets results are paid against.
const sessions = new Sessions(path.join(DATA_DIR, 'sessions.json'), Date.now, {
  saveDelayMs: SAVE_DELAY_MS,
  onSaveError: (e) => { metrics.error('save'); log('saving sessions failed:', e.message); }
});
const tickets = new MatchTickets(Date.now, path.join(DATA_DIR, 'tickets.json'), {
  saveDelayMs: SAVE_DELAY_MS,
  onSaveError: (e) => { metrics.error('save'); log('saving match tickets failed:', e.message); }
});
// Showdown series (showdown.js), in data/showdown-series.json so a restart
// mid-series keeps the score.
const showdowns = new ShowdownSeries({ roundsToWin: SHOWDOWN.roundsToWin, file: path.join(DATA_DIR, 'showdown-series.json'),
  saveDelayMs: SAVE_DELAY_MS, onSaveError: (e) => { metrics.error('save'); log('saving showdown series failed:', e.message); } });
// Friends (friends.json) and parties (memory); see friends.js.
// Recent activity for the launcher: matches today, players this week.
const activity = new Activity(Date.now, path.join(DATA_DIR, 'activity.json'));
const friends = new Friends(path.join(DATA_DIR, 'friends.json'), {
  saveDelayMs: SAVE_DELAY_MS,
  onSaveError: (e) => { metrics.error('save'); log('saving friends failed:', e.message); }
});
// Friend requests, removals and party invites per player: one a second, bursts of 20.
const allowFriendAction = rateLimiter(1, 20);
// Leaderboard requests per player: one every 2 seconds, bursts of 5.
const allowLeaderboard = rateLimiter(0.5, 5);
const allowHttp = rateLimiter(20, 60);
const allowSocket = rateLimiter(30, 90);
// New profiles per address: a burst of 10, then one a minute.
const allowNewProfile = rateLimiter(1 / 60, 10);
// Accounts per address: well-formed sign-up attempts (bounds probing which
// names / emails are taken) 20, then one a minute; accounts created 5, then
// one every 10 minutes. Wrong passwords: per address 10, then one a minute;
// per username 10, then one every 5 minutes (right passwords don't count).
const allowRegisterAttempt = rateLimiter(1 / 60, 20);
const allowRegister = rateLimiter(1 / 600, 5);
const allowLoginIp = rateLimiter(1 / 60, 10);
const allowLoginUser = rateLimiter(1 / 300, 10);

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function userFromRequest(req) {
  const token = bearerToken(req);
  return token ? sessions.userFor(token) : null;
}

const requestIp = (req) => clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
const socketIp = (socket) => clientIp(socket.handshake.address, socket.handshake.headers['x-forwarded-for']);

function normalizeUserID(raw) {
  let id = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!id) return '';
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
  const ipHash = accounts.hashIp(requestIp(req));
  if (REQUIRE_ACCOUNT && !accounts.useGrant(userID, ipHash)) {
    log('login refused (no play grant)', userID);
    return res.status(403).json({ errorCode: 'account-required', error: 'account-required' });
  }
  if (!hasProfile(userID)) {
    if (Object.keys(profiles).length >= MAX_PROFILES) return res.status(503).json({ error: 'server-full' });
    if (!allowNewProfile(requestIp(req))) return res.status(429).json({ error: 'too-many-new-players' });
  }
  const token = sessions.issue(userID);
  const p = getProfile(userID);
  // Where this profile last played from (hashed): an account can claim an
  // existing profile only from that address.
  if (p.lastLoginIpHash !== ipHash) { p.lastLoginIpHash = ipHash; saveProfiles(); }
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
  // Victory.exe posts "queueName" (form-encoded, camelCase); "queuename" is
  // the older field name. Reading only the lowercase one turned every queue
  // the game sent (Duo, Ranked, Showdown) into Solo.
  const queue = queueName(body.queueName !== undefined ? body.queueName : body.queuename);
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
  // Players sharing an address are told apart by the in-game name the HUD
  // sends (their Remaster account name).
  const nick = typeof body.nickname === 'string' ? body.nickname.trim().toLowerCase() : '';
  const claim = tickets.claim({ userID: userFromRequest(req), ip: requestIp(req),
    pick: nick ? (t) => String(usernameOf(t.userID) || '').toLowerCase() === nick : null });
  if (claim.error) {
    log('match result rejected', claim.error, requestIp(req));
    return res.status(409).json({ error: claim.error });
  }
  const userID = claim.ticket.userID;
  activity.match(userID);
  if (claim.ticket.map === SHOWDOWN.map) return showdownMatchResult(res, claim, body, userID);
  const p = getProfile(userID);
  // Bounded so a malformed report (e.g. "1e999" -> Infinity) can't write
  // Infinity/NaN credits or XP into profiles.json.
  const bounded = (v, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0);
  // Too short to be a real match: no win, and ranked counts it as last place.
  const tooShort = claim.elapsed < MIN_MATCH_SECONDS;
  const field = matchField(claim.ticket.map, body.cap);
  const r = {
    victory: !tooShort && (body.victory === true || body.victory === 'true'),
    // Every other contestant at most; damage within what 15 can take.
    kills: bounded(parseInt(body.kills, 10), field - 1),
    damage: bounded(Number(body.damage), 5000),
    // No longer than the match has actually run.
    timeAlive: bounded(Number(body.timeAlive), Math.min(4 * 3600, claim.elapsed + 30)),
    func: bounded(parseInt(body.func, 10), 1e6)
  };
  const startXP = p.stats.xp;
  const earned = matchXP(r);
  const credits = matchCredits(r);
  p.cullCredits += credits;
  let rankedResult = null;
  // Only the result of the ranked match itself scores it: a Solo, Duo or
  // Showdown result never finishes a ranked match left pending.
  if (p.ranked && p.ranked.pending && claim.ticket.ranked && p.ranked.pending.id === claim.ticket.ranked) {
    const reported = parseInt(body.placement, 10);
    // Within the field: a map whose contestants outnumber its field (or a
    // malformed rank) still scores, as last place at worst.
    const placement = tooShort ? field : r.victory ? 1 : Math.min(field, Math.max(1, Number.isFinite(reported) ? reported : field));
    if (tooShort) log('ranked result too short', Math.round(claim.elapsed) + ' s', 'counted as last place');
    const out = ranked.finishMatch(p, { matchId: body.matchId, placement, field, kills: r.kills, damage: r.damage, timeAlive: r.timeAlive },
      Date.now(), rankedGrant(p));
    if (out.error) log('ranked result rejected', out.error, JSON.stringify(body).slice(0, 200));
    else {
      rankedResult = { entry: out.entry, summary: ranked.summary(p) };
      log('ranked result', out.entry.matchId, 'place', out.entry.placement, out.entry.ratingBefore, '->', out.entry.ratingAfter,
        out.entry.tierAfter);
    }
  }
  const s = p.stats;
  s.xp = Math.min(seasonXPCap(), s.xp + earned);
  const level = Math.min(SEASON.maxLevel, levelForXP(s.xp) || s.level);
  const levelled = Boolean(level && level !== s.level);
  if (levelled) {
    log('level', userID, s.level, '->', level);
    s.level = level;
  }
  s.gamesPlayed += 1;
  s.kills += r.kills;
  s.wins += r.victory ? 1 : 0;
  s.totalDamage += Math.round(r.damage);
  s.minutesAlive += Math.round(r.timeAlive / 60);
  s.funcEarned += r.func;
  const mode = claim.ticket.mode || (showdown ? SHOWDOWN.queue : 'ffa');
  if (mode !== SHOWDOWN.queue) {
    if (!p.modes || typeof p.modes !== 'object') p.modes = {};
    const m = p.modes[mode] || (p.modes[mode] = { played: 0, wins: 0, kills: 0, damage: 0, minutesAlive: 0 });
    m.played += 1;
    m.wins += r.victory ? 1 : 0;
    m.kills += r.kills;
    m.damage += Math.round(r.damage);
    m.minutesAlive += Math.round(r.timeAlive / 60);
  }
  p.lastMatch = Object.assign({ at: Date.now(), xpEarned: earned }, r);
  saveProfiles();
  log('match result', userID, JSON.stringify(r), `+${earned} XP (${startXP} -> ${s.xp}), +${credits} credits`);
  const socket = socketsByUser.get(userID);
  if (socket) sendPlayer(socket, p);
  // A new level can unlock airdrops: the menu gets them without a restart.
  if (socket && levelled) socket.emit('entitlements-response', entitlements(p));
  setPresence(userID, 'menu');
  res.json({ startXP, xpEarned: earned, stats: s, credits, ranked: rankedResult, showdown: null });
});

// The match result of a Showdown match: the end of the series (the patched
// exe plays every round in the match; this result names the round it ends,
// which counts if the HUD's round report hasn't already). The series pays
// once, when it is over: seriesPayout's XP and credits, one game on the
// career, a win only for the series. Older builds play one round per match:
// the round counts here and the series pays when its last round does.
function showdownMatchResult(res, claim, body, userID) {
  const p = getProfile(userID);
  const victory = claim.elapsed >= SHOWDOWN.minSeconds && (body.victory === true || body.victory === 'true');
  const round = parseInt(body.showdownRound, 10);
  const before = showdowns.current(userID);
  let view = null;
  if (before && before.inMatch && Number.isInteger(round) && round > 0) {
    view = showdowns.recordInMatch(userID, round, victory ? 'W' : 'L');
  } else if (before && !before.inMatch) {
    view = showdowns.recordRound(userID, victory);
  }
  const s = showdowns.last(userID);
  if (s && s.inMatch && !s.over) showdowns.leave(userID);   // the match ended, so did the series
  if (s) view = showdowns.view(s);
  const paid = showdowns.claimPayout(userID);
  const startXP = p.stats.xp;
  const st = p.stats;
  let earned = 0, credits = 0;
  if (paid) {
    const r = seriesPayout(paid, { kills: body.kills, damage: body.damage, timeAlive: body.timeAlive,
      maxTime: Math.min(4 * 3600, claim.elapsed + 30) });
    earned = r.xp;
    credits = r.credits;
    p.cullCredits += credits;
    st.xp = Math.min(seasonXPCap(), st.xp + earned);
    const level = Math.min(SEASON.maxLevel, levelForXP(st.xp) || st.level);
    const levelled = Boolean(level && level !== st.level);
    if (levelled) { log('level', userID, st.level, '->', level); st.level = level; }
    st.gamesPlayed += 1;
    st.kills += r.kills;
    st.wins += r.victory ? 1 : 0;
    st.totalDamage += Math.round(r.damage);
    st.minutesAlive += Math.round(r.timeAlive / 60);
    p.lastMatch = { at: Date.now(), xpEarned: earned, victory: r.victory, kills: r.kills, damage: r.damage,
      timeAlive: r.timeAlive, func: 0, showdown: { wins: paid.wins, losses: paid.losses } };
    if (showdowns.markRecorded(userID)) recordShowdown(userID, paid.won);
    saveProfiles();
    log('showdown series paid', userID, paid.wins + '-' + paid.losses, paid.won ? 'VICTORY' : 'defeat',
      '+' + earned + ' XP, +' + credits + ' credits');
    const socket = socketsByUser.get(userID);
    if (socket) sendPlayer(socket, p);
    if (socket && levelled) socket.emit('entitlements-response', entitlements(p));
  } else if (view) {
    log('showdown round', userID, view.round, victory ? 'won' : 'lost', view.wins + '-' + view.losses);
  }
  setPresence(userID, 'menu');
  res.json({ startXP, xpEarned: earned, stats: st, credits, ranked: null,
    showdown: view ? showdownState(view.over ? 'over' : 'round-over', view) : null });
}

// A round of the in-match series, from the HUD as the game ends it (result
// "W" you, "L" the rival, "D" no one). Only the next round counts, once.
app.post('/api/showdown/round', (req, res) => {
  const body = bodyObject(req);
  const ticket = showdownTicket(req, body.nickname);
  if (!ticket || ticket.map !== SHOWDOWN.map) return res.status(409).json({ error: 'no-showdown' });
  const userID = ticket.userID;
  const round = parseInt(body.round, 10);
  const result = typeof body.result === 'string' ? body.result.toUpperCase() : '';
  const view = showdowns.recordInMatch(userID, round, result);
  if (view) {
    log('showdown round', userID, round, result, view.wins + '-' + view.losses, view.over ? (view.won ? 'VICTORY' : 'defeat') : '');
    if (view.over && showdowns.markRecorded(userID)) recordShowdown(userID, view.won);
    setPresence(userID, 'match', { mode: SHOWDOWN.queue, round: view.round });
  }
  const s = showdowns.last(userID);
  res.json({ counted: Boolean(view), series: s ? showdowns.view(s) : null });
});

// Showdown: the HUD asks which round this match is and what the kit holds
// (the pre-round panel). Only for a Showdown match that is being played.
// The Showdown match a HUD request is about: by token, else the one Showdown
// ticket from its address, else (players sharing an address) the one whose
// account name the HUD sends.
function showdownTicket(req, nickname) {
  const userID = userFromRequest(req);
  if (userID) return tickets.peek({ userID });
  const ip = requestIp(req);
  const mine = [...tickets.open.values()].filter((t) => t.ip === ip && t.map === SHOWDOWN.map);
  if (mine.length <= 1) return mine[0] || null;
  const nick = typeof nickname === 'string' ? nickname.trim().toLowerCase() : '';
  const named = nick ? mine.filter((t) => String(usernameOf(t.userID) || '').toLowerCase() === nick) : [];
  return named.length === 1 ? named[0] : null;
}

app.get('/api/showdown', (req, res) => {
  const ticket = showdownTicket(req, req.query && req.query.nickname);
  // The kits either way: on a shared address the ticket can't be told apart,
  // and the HUD then runs the series from the game's own round messages.
  if (!ticket || ticket.map !== SHOWDOWN.map) return res.json({ active: false, kit: showdownKit, kits: showdownKits });
  const series = showdowns.current(ticket.userID);
  res.json(Object.assign({ active: Boolean(series) }, showdownState('round', series ? showdowns.view(series) : null)));
});

// The HUD asks the game for the level matching the new XP and reports it back.
app.post('/api/setlevel', (req, res) => {
  const level = parseInt(bodyObject(req).level, 10);
  const userID = userFromRequest(req) || tickets.recentUser(requestIp(req));
  if (!userID) return res.status(409).json({ error: 'no-recent-match' });
  // Within the season cap and never above what the player's XP gives.
  const p0 = getProfile(userID);
  const allowed = Math.min(SEASON.maxLevel, levelForXP(p0.stats.xp) || SEASON.maxLevel);
  if (level > 0 && level <= allowed) {
    const p = p0;
    const levelled = level !== p.stats.level;
    if (levelled) log('level', userID, p.stats.level, '->', level);
    p.stats.level = level;
    saveProfiles();
    const socket = levelled && socketsByUser.get(userID);
    if (socket) socket.emit('entitlements-response', entitlements(p));
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

// ---------------------------------------------------------------- accounts

// Async handlers: a rejection goes to the error handler (JSON 500) instead of
// leaving the request hanging; too many password hashes queued is a 503.
const asyncRoute = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  if (e && e.code === 'busy' && !res.headersSent) return res.status(503).json({ error: 'busy' });
  next(e);
});

// The signed-in account of a request (Authorization: Bearer <account token>).
const accountFromRequest = (req) => accounts.accountForToken(bearerToken(req));

app.use(['/api/account', '/admin'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.post('/api/account/register', asyncRoute(async (req, res) => {
  const body = bodyObject(req);
  const ip = requestIp(req);
  const username = acc.normalizeUsername(body.username);
  if (username === null) return res.status(400).json({ error: 'invalid-username' });
  const email = acc.normalizeEmail(body.email);
  if (email === null) return res.status(400).json({ error: 'invalid-email' });
  if (!acc.validPassword(body.password)) return res.status(400).json({ error: 'weak-password' });
  if (!allowRegisterAttempt(ip)) return res.status(429).json({ error: 'too-many-attempts' });
  const key = username.toLowerCase();
  const conflict = () => (accounts.get(key) ? 'username-taken' : accounts.emailTaken(email) ? 'email-taken' : null);
  if (conflict()) return res.status(409).json({ error: conflict() });
  if (accounts.count >= MAX_ACCOUNTS) return res.status(503).json({ error: 'server-full' });
  if (!allowRegister(ip)) return res.status(429).json({ error: 'too-many-attempts' });
  let hash;
  try { hash = await acc.hashPassword(body.password); } catch (e) { allowRegister.refund(ip); throw e; }
  // Checked again: another sign-up may have taken the name while this one hashed.
  if (conflict()) { allowRegister.refund(ip); return res.status(409).json({ error: conflict() }); }
  if (accounts.count >= MAX_ACCOUNTS) { allowRegister.refund(ip); return res.status(503).json({ error: 'server-full' }); }
  // An existing profile is linked only if nobody owns it yet and its last game
  // login came from this address; otherwise the account gets a fresh ID.
  const claim = body.claimUserID;
  let userID;
  let claimed = false;
  if (acc.validSteamID(claim) && hasProfile(claim) && !accounts.ownsUserID(claim)
    && profiles[claim].lastLoginIpHash === accounts.hashIp(ip)) {
    userID = claim;
    claimed = true;
  } else {
    if (Object.keys(profiles).length >= MAX_PROFILES) { allowRegister.refund(ip); return res.status(503).json({ error: 'server-full' }); }
    do userID = acc.randomSteamID(); while (hasProfile(userID) || accounts.ownsUserID(userID));
  }
  accounts.create({ username, email, userID, password: hash });
  rememberAccountIp(accounts.get(key), ip);
  leaderboard.changed();
  getProfile(userID);
  const token = accounts.issueToken(key);
  log('account created', JSON.stringify(username), userID, claimed ? '(claimed an existing profile)' : '');
  res.json({ token, username, userID, claimed });
}));

// The last few addresses an account signed in from, hashed (accounts.hashIp).
const KNOWN_IPS = 5;
function accountKnowsIp(a, ip) {
  return Boolean(a && Array.isArray(a.knownIps) && a.knownIps.includes(accounts.hashIp(ip)));
}
function rememberAccountIp(a, ip) {
  if (!a) return;
  const h = accounts.hashIp(ip);
  a.knownIps = [h].concat((Array.isArray(a.knownIps) ? a.knownIps : []).filter((x) => x !== h)).slice(0, KNOWN_IPS);
  accounts.save();
}

app.post('/api/account/login', asyncRoute(async (req, res) => {
  const body = bodyObject(req);
  const ip = requestIp(req);
  const key = acc.usernameKey(body.username);
  // Every attempt counts against the limits; a right password is given back.
  if (!allowLoginIp(ip)) return res.status(429).json({ error: 'too-many-attempts' });
  // The per-username limit stops guessing spread over many addresses, but the
  // addresses the player has signed in from before (kept hashed) are exempt,
  // so someone else's wrong guesses can't lock the player out.
  const known = key && accountKnowsIp(accounts.get(key), ip);
  const userCounted = Boolean(key && !known);
  if (userCounted && !allowLoginUser(key)) { allowLoginIp.refund(ip); return res.status(429).json({ error: 'too-many-attempts' }); }
  const password = body.password;
  // No account can have a malformed name or an over-long password: no hash needed.
  if (!key || typeof password !== 'string' || password.length > 128) return res.status(401).json({ error: 'wrong-credentials' });
  const a = accounts.get(key);
  // An unknown name costs the same scrypt as a wrong password.
  const ok = await acc.verifyPassword(password, a ? a.password : await acc.dummyPasswordHash());
  if (!ok || !a) return res.status(401).json({ error: 'wrong-credentials' });
  allowLoginIp.refund(ip);
  if (userCounted) allowLoginUser.refund(key);
  rememberAccountIp(a, ip);
  a.lastLoginAt = Date.now();
  const token = accounts.issueToken(key);
  res.json({ token, username: a.username, userID: a.userID });
}));

app.get('/api/account/me', (req, res) => {
  const s = accountFromRequest(req);
  if (!s) return res.status(401).json({ error: 'signed-out' });
  res.json({ username: s.account.username, userID: s.account.userID, email: s.account.email });
});

// The launcher, right before starting the game: the game's own /api/login for
// this account is accepted from this address for the next 12 hours.
app.post('/api/account/play', (req, res) => {
  const s = accountFromRequest(req);
  if (!s) return res.status(401).json({ error: 'signed-out' });
  accounts.grant(s.account.userID, accounts.hashIp(requestIp(req)));
  log('play grant', s.account.userID);
  res.json({ username: s.account.username, userID: s.account.userID });
});

app.post('/api/account/logout', (req, res) => {
  accounts.revokeToken(bearerToken(req));
  res.json({});
});

// ---------------------------------------------------------------- operator

// Operator tools (tools/account_admin.js on the VPS): loopback without proxy
// headers only, like /metrics; anything else gets the same 404 as /metrics.
const operator = (req) => metricsAllowed(req.socket.remoteAddress, req.headers);

const STAT_KEYS = Object.keys(newProfile('').stats);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// A JSON value made safe to store: finite numbers (non-negative unless
// `negatives`), bounded strings, arrays and nesting.
function cleanValue(v, negatives, depth = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? (negatives ? v : Math.max(0, v)) : 0;
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'boolean' || v === null) return v;
  if (depth >= 6 || typeof v !== 'object') return null;
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => cleanValue(x, negatives, depth + 1));
  const out = {};
  for (const k of Object.keys(v).slice(0, 200)) {
    if (!UNSAFE_KEYS.has(k)) out[k] = cleanValue(v[k], negatives, depth + 1);
  }
  return out;
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const nonNegative = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);

// A profile from somewhere else (the owner's local server), reduced to the
// fields this server knows, with the account's user ID.
function sanitizeProfile(raw, userID) {
  const p = newProfile(userID);
  p.cullCredits = nonNegative(raw.cullCredits, p.cullCredits);
  p.premiumCurrency = nonNegative(Number(raw.premiumCurrency), p.premiumCurrency);
  // Missing: the profile predates the shop, and getProfile applies that rule.
  p.economy = nonNegative(raw.economy, 0);
  p.createdAt = nonNegative(raw.createdAt, p.createdAt);
  const card = raw.cardID;
  p.cardID = (Number.isSafeInteger(card) && card >= 0) || (typeof card === 'string' && /^\d{1,12}$/.test(card)) ? card : 0;
  const owned = Array.isArray(raw.owned) ? raw.owned : [];
  p.owned = [...new Set(owned.filter((t) => Number.isSafeInteger(t) && t >= 0 && (!catalog.length || catalogByTid.has(t))))];
  const stats = isPlainObject(raw.stats) ? raw.stats : {};
  for (const k of STAT_KEYS) p.stats[k] = nonNegative(stats[k], p.stats[k]);
  const level = levelForXP(p.stats.xp);
  if (level) p.stats.level = level;
  if (isPlainObject(raw.ranked)) {
    // Rating changes in the history can be negative; everything else not.
    const r = cleanValue(raw.ranked, false);
    r.history = Array.isArray(raw.ranked.history) ? raw.ranked.history.slice(0, 50).map((h) => cleanValue(h, true)) : [];
    if (!isPlainObject(r.processed)) r.processed = {};
    if (!isPlainObject(r.tiersReached)) r.tiersReached = {};
    // A match left running on another server can't be finished here.
    r.pending = null;
    p.ranked = r;
  }
  if (isPlainObject(raw.lastMatch)) p.lastMatch = cleanValue(raw.lastMatch, false);
  return p;
}

const profileSummary = (p) => (p ? { credits: p.cullCredits, xp: p.stats.xp, level: p.stats.level, wins: p.stats.wins,
  kills: p.stats.kills, owned: (p.owned || []).length } : null);

app.post('/admin/import-profile', (req, res) => {
  if (!operator(req)) return res.status(404).json({});
  const body = bodyObject(req);
  const key = acc.usernameKey(body.username);
  const a = key && accounts.get(key);
  if (!a) return res.status(404).json({ error: 'no-such-account' });
  if (!isPlainObject(body.profile)) return res.status(400).json({ error: 'invalid-profile' });
  const userID = a.userID;
  const old = peekProfile(userID);
  let backup = null;
  if (old) {
    const dir = path.join(DATA_DIR, 'import-backups');
    fs.mkdirSync(dir, { recursive: true });
    backup = path.join(dir, userID.replace(/[^A-Za-z0-9_-]/g, '_') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    writeAtomicSync(backup, JSON.stringify(old));
  }
  const before = profileSummary(old);
  const p = sanitizeProfile(body.profile, userID);
  if (old && old.lastLoginIpHash) p.lastLoginIpHash = old.lastLoginIpHash;
  profiles[userID] = p;
  saveProfiles();
  getProfile(userID);                 // applies the pre-shop rule if needed
  const socket = socketsByUser.get(userID);
  if (socket) sendPlayer(socket, profiles[userID]);
  const after = profileSummary(profiles[userID]);
  log('profile imported for', userID, JSON.stringify(before), '->', JSON.stringify(after));
  res.json({ username: a.username, userID, backup, before, after });
});

app.post('/admin/reset-password', asyncRoute(async (req, res) => {
  if (!operator(req)) return res.status(404).json({});
  const key = acc.usernameKey(bodyObject(req).username);
  const a = key && accounts.get(key);
  if (!a) return res.status(404).json({ error: 'no-such-account' });
  const password = acc.randomPassword(16);
  accounts.setPassword(key, await acc.hashPassword(password));
  const revoked = accounts.revokeAll(key);
  // Signed out everywhere, and the game can't log in on an old grant or session either.
  accounts.revokeGrant(a.userID);
  const sessionsRevoked = sessions.revokeUser(a.userID);
  log('password reset for', a.userID, '(' + revoked + ' tokens, ' + sessionsRevoked + ' game sessions revoked)');
  res.json({ username: a.username, password, revokedTokens: revoked });
}));

app.get('/api/news', (req, res) => res.json({ news: [] }));

app.get(['/health', '/api/health'], (req, res) => res.json(Object.assign({ ok: true, users: socketsByUser.size }, activity.summary())));

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
  // Never log what might be a password (a mistyped account or operator URL).
  const quiet = /^\/(api\/account|admin)(\/|$)/i.test(req.path);
  accessLog('  (unhandled HTTP route)', req.method, req.originalUrl.slice(0, 200),
    quiet ? '(body not logged)' : JSON.stringify(bodyObject(req)).slice(0, 300));
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
    matchLobbies: lobbies.stats(),
    leaderboard: leaderboard.stats(),
    accounts: Object.assign({ required: REQUIRE_ACCOUNT }, accounts.stats()),
    rateLimiterKeys: { http: allowHttp.size(), socket: allowSocket.size(), newProfile: allowNewProfile.size(),
      registerAttempt: allowRegisterAttempt.size(), register: allowRegister.size(), loginIp: allowLoginIp.size(),
      loginUser: allowLoginUser.size(), leaderboard: allowLeaderboard.size() },
    saving: { profiles: profileStore.stats, sessions: sessions.store ? sessions.store.stats : null,
      accounts: accounts.store ? accounts.store.stats : null },
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
  // Solo side: every mode but Duo; coop side: Duo (p.modes, from match results).
  const duo = (p.modes && p.modes.coop2) || { wins: 0, kills: 0 };
  const side = (wins, kills) => ({
    topWins: [], topKills: [], topTenMatches: [],
    tier4TopTen: [], tier3TopTen: [], tier2TopTen: [], tier1TopTen: [], tier0TopTen: [],
    currentSeasonTier: {}, currentSeasonScore: 0,
    currentSeasonWins: wins, currentSeasonKills: kills
  });
  return { solo: side(Math.max(0, p.stats.wins - duo.wins), Math.max(0, p.stats.kills - duo.kills)), coop: side(duo.wins, duo.kills) };
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

// Matchmaking: players searching the same playlist wait in one lobby and see
// each other (matchlobby.js), then each starts the match. Gather and countdown
// times are configurable (tests shorten them).
const lobbies = new MatchLobbies({
  options: {
    gatherMs: parseInt(process.env.CULLING_LOBBY_GATHER_MS || '10000', 10),
    // The pregame lobby: long enough to see the match's roster and the map.
    countdownMs: parseInt(process.env.CULLING_LOBBY_COUNTDOWN_MS || '10000', 10),
    maxPlayers: 16,
    maps: Object.keys(MAPS),
    // Who else is in each player's match: the game fills it with bots up to
    // 16 contestants (Victory.exe caps players plus bots at 16), or up to
    // FIELD_BY_MAP with patch_exe.py (menus from those builds read the map's).
    matchBots: 15,
    matchBotsByMap: Object.fromEntries(Object.entries(FIELD_BY_MAP).map(([m, n]) => [m, n - 1])),
    // No lobby note: menus never say the other contestants are bots.
    note: null
  },
  describe: (m) => lobbyCard(m.id),
  send: (m, payload) => {
    setPresence(m.id, payload.state === 'searching' ? 'searching' : 'lobby', { mode: lobbyQueue(payload.queue).mode });
    if (!m.socket.connected) return;
    m.socket.emit('remaster-lobby', payload);
    m.socket.emit('players-in-queue', { count: payload.players.length });
  },
  start: (lobby) => {
    log('lobby', lobby.id, lobby.queue, 'starting with', lobby.members.size, 'player(s)');
    for (const m of lobby.members.values()) if (m.socket.connected) launchMatch(m.socket, lobby.queue, lobby.map);
  }
});

// What other players see of someone in a lobby: no IDs, nothing private.
function lobbyCard(userID) {
  const p = peekProfile(userID);
  const key = accounts.keyForUserID(userID);
  const a = key ? accounts.get(key) : null;
  const rating = p && p.ranked && Number.isFinite(p.ranked.rating) ? Math.min(ranked.CONFIG.maxRating, p.ranked.rating) : null;
  return {
    name: a ? a.username : 'Player',
    level: p && p.stats ? Math.min(SEASON.maxLevel, p.stats.level || 1) : 1,
    cardID: p ? p.cardID || 0 : 0,
    rank: rating === null ? null : ranked.tierFor(rating).name
  };
}

// The menu's queue names carry a mode and sometimes a map ("ffa_jungle",
// "ffa_prison_coop2", "ranked_ffa"): one lobby per mode, the map as the
// player's first vote.
function lobbyQueue(raw) {
  const q = queueName(raw);
  const map = /prison/.test(q) ? 'prison' : /jungle/.test(q) ? 'jungle' : null;
  const mode = q.startsWith('ranked') ? 'ranked_ffa' : /coop2/.test(q) ? 'coop2' : q.startsWith('lightning') ? 'lightning'
    : /^(ffa|quick_play)/.test(q) ? 'ffa' : q;
  return { mode, map };
}

function startLocalMatch(socket, queue) {
  const { mode, map } = lobbyQueue(queue);
  const q = queueName(queue);           // cleaned: a malformed name is 'ffa'
  if (/^ranked/.test(q) && /coop2/.test(q)) {
    // Ranked Duo isn't a mode (yet): say so rather than start Ranked Solo.
    socket.emit('join-mm-fail', { reason: 'queue-unavailable' });
    return;
  }
  socket.emit('join-mm-ack');
  if (mode === SHOWDOWN.queue) {
    // Out of any lobby still searching: its match-ready would land mid-series.
    lobbies.leave(socket.userID);
    // The whole series is this match. One left unfinished is forfeited first.
    const before = showdowns.current(socket.userID);
    const { series, left } = showdowns.startSeries(socket.userID);
    if (left && before && before.recorded === false) { before.recorded = true; recordShowdown(socket.userID, false); }
    socket.emit('remaster-showdown', showdownState('round', series));
    setPresence(socket.userID, 'match', { mode: SHOWDOWN.queue, round: series.round });
    return launchMatch(socket, SHOWDOWN.queue, SHOWDOWN.map);
  }
  // A party leader queues the party: everyone online and in the menu joins
  // the same lobby, and their menus show the queue (join-mm-group).
  const p = friends.party(socket.userID);
  if (p && p.leader === socket.userID && p.members.length > 1) {
    const group = [{ id: socket.userID, socket }];
    for (const id of p.members) {
      const s = socketsByUser.get(id);
      if (id === socket.userID || !s || !s.connected || presenceState(id) === 'match') continue;
      // Duo is played in pairs: the leader and one party member.
      if (mode === 'coop2' && group.length >= 2) break;
      group.push({ id, socket: s });
      s.emit('join-mm-group');
    }
    lobbies.joinGroup(mode, group, map);
    log('party', p.id, 'queued', mode, group.length + '/' + p.members.length, 'player(s)');
    return;
  }
  lobbies.join(mode, { id: socket.userID, socket }, map);
}

// The lobby's countdown ended: this player's match starts (against bots, on
// their PC). Ranked counts from here, so cancelling in the lobby costs nothing.
function launchMatch(socket, queue, map) {
  const showdown = queue === SHOWDOWN.queue;
  // Duo: the pairs mode, you and a teammate (patch/make_duo.py); the menu
  // starts it from "duo:<map>".
  const duo = lobbyQueue(queue).mode === 'coop2';
  const mapIndex = Object.prototype.hasOwnProperty.call(MAPS, map) ? MAPS[map] : 0;
  let rankedId = null;
  if (String(queue).startsWith('ranked')) {
    const p = getProfile(socket.userID);
    const { match, abandoned } = ranked.startMatch(p, Date.now(), rankedGrant(p));
    if (abandoned) log('ranked abandoned', abandoned.matchId, abandoned.ratingBefore, '->', abandoned.ratingAfter);
    log('ranked match', match.id, 'rating', match.ratingBefore, 'mmr', match.mmr);
    rankedId = match.id;
    saveProfiles();
  }
  // The ticket says which match this is: its map, its mode, and the ranked
  // match it scores (only that ranked match is finished by its result).
  tickets.start(socket.userID, socketIp(socket), {
    map: showdown ? SHOWDOWN.map : Object.prototype.hasOwnProperty.call(MAPS, map) ? map : 'jungle',
    mode: showdown ? SHOWDOWN.queue : lobbyQueue(queue).mode,
    ranked: rankedId
  });
  if (!showdown) setPresence(socket.userID, 'match', { mode: lobbyQueue(queue).mode });
  log('match-ready ->', socket.userID, showdown ? 'showdown ' + SHOWDOWN.format : (duo ? 'duo map ' : 'offline map ') + mapIndex);
  socket.emit('match-ready', {
    gameServer: showdown ? 'showdown:' + SHOWDOWN.format : (duo ? 'duo:' : 'offline:') + mapIndex,
    nonce: crypto.randomBytes(8).toString('hex'),
    serverNonce: crypto.randomBytes(8).toString('hex')
  });
}

// How many contestants a match had: the stock 16 unless the game reports a
// higher cap (builds with patch_exe.py), then what the map places, within it.
function matchField(map, cap) {
  if (map === SHOWDOWN.map) return SHOWDOWN.field;
  const reported = parseInt(cap, 10);
  if (!Number.isInteger(reported) || reported <= ranked.CONFIG.field) return ranked.CONFIG.field;
  return Math.min(reported, ranked.CONFIG.maxField, FIELD_BY_MAP[map] || ranked.CONFIG.field);
}

// Back in the menu after a Showdown match: the final score, once. A series
// still unfinished from before this login (the player quit the match, or an
// older build's series between rounds) is a forfeit; one queued since the
// login is being played. Nothing ever starts a round by itself.
function sendShowdown(socket, loginAt) {
  const s = showdowns.current(socket.userID) || showdowns.last(socket.userID);
  if (!s) return;
  if (!s.over && s.startedAt >= loginAt) return;
  if (!s.over && showdowns.leave(socket.userID) && showdowns.markRecorded(socket.userID)) recordShowdown(socket.userID, false);
  if (s.over && showdowns.markAnnounced(socket.userID)) socket.emit('remaster-showdown', showdownState('over', showdowns.view(s)));
}

// ---------------------------------------------------------------- friends, parties, player cards

// What each player is doing, for their friends: menu, searching, lobby or
// match (with the mode, and the round in Showdown). Offline is derived.
const presence = new Map();     // userID -> { state, mode, round, since }
const MATCH_PRESENCE_MS = 45 * 60 * 1000;
const MODE_LABELS = { ffa: 'Solo', coop2: 'Duo', ranked_ffa: 'Ranked', showdown: 'Showdown', lightning: 'Lightning' };

function usernameOf(userID) {
  const key = accounts.keyForUserID(userID);
  const a = key ? accounts.get(key) : null;
  return a ? a.username : null;
}

function userIDForName(raw) {
  const a = accounts.get(acc.usernameKey(raw));
  return a ? a.userID : null;
}

function presenceState(userID) { return statusOf(userID).state; }

function setPresence(userID, state, extra = {}) {
  const was = presence.get(userID);
  const now = { state, mode: extra.mode || null, round: extra.round || null, since: Date.now() };
  if (was && was.state === now.state && was.mode === now.mode && was.round === now.round) return;
  presence.set(userID, now);
  notifyFriends(userID);
}

// A player's status as their friends see it.
function statusOf(userID) {
  const s = socketsByUser.get(userID);
  const st = presence.get(userID);
  const open = tickets.peek({ userID });
  // A match runs 25 minutes at most: an older open ticket (alt-F4, crash) no
  // longer shows the player as "In match".
  const playing = open && Date.now() - open.startedAt < MATCH_PRESENCE_MS ? open : null;
  let state = 'offline';
  if (st && st.state === 'match' && playing) state = 'match';
  else if (s && s.connected) state = st ? st.state : 'menu';
  else if (playing) state = 'match';
  const mode = st && st.mode && MODE_LABELS[st.mode] ? MODE_LABELS[st.mode] : null;
  let label = { offline: 'Offline', menu: 'In menu', searching: 'Searching', lobby: 'In lobby', match: 'In match' }[state];
  if (mode && state !== 'offline' && state !== 'menu') label += ' · ' + mode + (st.round && mode === 'Showdown' ? ' round ' + st.round : '');
  return { state, label, lastSeen: state === 'offline' ? friends.peek(userID).seen : null };
}

// A player as friends and party lists show them.
function friendEntry(userID) {
  return Object.assign({ username: usernameOf(userID) || 'Player' }, lobbyCard(userID), { status: statusOf(userID) });
}

function partyView(userID) {
  const p = friends.party(userID);
  if (!p) return null;
  return { id: p.id, leader: usernameOf(p.leader), you: usernameOf(userID),
    members: p.members.map((id) => Object.assign(friendEntry(id), { leader: id === p.leader })) };
}

const STATE_ORDER = { match: 0, lobby: 1, searching: 2, menu: 3, offline: 4 };

// Everything a player's friends panel shows, pushed whenever it changes.
function sendFriends(userID) {
  const socket = socketsByUser.get(userID);
  if (!socket || !socket.connected) return;
  const me = friends.peek(userID);
  const list = me.friends.map(friendEntry)
    .sort((a, b) => STATE_ORDER[a.status.state] - STATE_ORDER[b.status.state] || a.username.localeCompare(b.username));
  socket.emit('remaster-friends', {
    you: usernameOf(userID),
    friends: list,
    incoming: me.incoming.map(friendEntry),
    outgoing: me.outgoing.map(friendEntry),
    party: partyView(userID),
    invites: friends.invitesFor(userID).map((i) => ({ partyId: i.partyId, from: friendEntry(i.from) })),
    maxParty: friends.limits.maxParty
  });
}

// Someone's status or friendships changed: refresh their panel and their
// friends' and party members'.
function notifyFriends(userID) {
  const told = new Set([userID]);
  sendFriends(userID);
  const p = friends.party(userID);
  for (const id of friends.friendsOf(userID).concat(p ? p.members : [])) {
    if (told.has(id)) continue;
    told.add(id);
    sendFriends(id);
  }
}

// A finished Showdown series on the player's record (their card shows it).
function recordShowdown(userID, won) {
  const p = getProfile(userID);
  p.showdown = p.showdown || { won: 0, lost: 0 };
  if (won) p.showdown.won++; else p.showdown.lost++;
  saveProfiles();
}

// A player's card: who they are and what their profile records.
function playerCard(userID, viewer) {
  const p = peekProfile(userID) || BLANK_PROFILE;
  const s = p.stats || {};
  const games = s.gamesPlayed || 0;
  const wins = s.wins || 0;
  const kills = s.kills || 0;
  const losses = Math.max(0, games - wins);          // every match not won ends in a death
  const card = Object.assign({ username: usernameOf(userID) || 'Player' }, lobbyCard(userID), {
    wins, losses, games, kills,
    kd: losses ? Math.round(kills / losses * 100) / 100 : kills,
    winRate: games ? Math.round(wins / games * 1000) / 10 : 0,
    minutesPlayed: s.minutesAlive || 0,
    damage: Math.round(s.totalDamage || 0),
    memberSince: p.createdAt || null,
    showdown: p.showdown ? { won: p.showdown.won || 0, lost: p.showdown.lost || 0 } : { won: 0, lost: 0 },
    ranked: null,
    status: statusOf(userID)
  });
  const r = p.ranked;
  if (r && Number.isFinite(r.rating)) {
    const rating = Math.min(ranked.CONFIG.maxRating, r.rating);
    card.ranked = {
      season: { id: ranked.CONFIG.season.id, name: ranked.CONFIG.season.name },
      tier: ranked.tierFor(rating).name, rating,
      peakTier: r.peakTier || ranked.tierFor(rating).name,
      matches: r.matches || 0, wins: r.wins || 0,
      tiersReached: ranked.TIERS.filter((t) => r.tiersReached && r.tiersReached[t.name]).map((t) => t.name)
    };
  }
  if (viewer) {
    const me = friends.peek(viewer);
    card.relation = viewer === userID ? 'you' : me.friends.includes(userID) ? 'friend'
      : me.outgoing.includes(userID) ? 'requested' : me.incoming.includes(userID) ? 'asked-you' : 'none';
  }
  return card;
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
    activity.seen(userID);
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
    const loginAt = Date.now();
    later(() => sendShowdown(socket, loginAt), 1500);
    if (usernameOf(userID)) friends.seen(userID);
    // The menu logging in means the game is back in the menu: a match the HUD
    // never reported (a crash) no longer keeps the player "In match", so a
    // party leader's queue includes them again. The ticket stays claimable.
    presence.delete(userID);
    const dropped = tickets.abandon(userID, ABANDON_GRACE_MS);
    if (dropped) log('match ended without a result', userID, dropped.mode || '', Math.round((Date.now() - dropped.startedAt) / 1000) + ' s');
    notifyFriends(userID);
  });

  on('join-mm', (msg) => startLocalMatch(socket, msg && msg.queueName));
  on('leave-mm', () => {
    lobbies.leave(socket.userID);
    socket.emit('leave-mm-ack');
    setPresence(socket.userID, 'menu');
    // The party leader cancelling takes the party out of the lobby too.
    const p = friends.party(socket.userID);
    if (p && p.leader === socket.userID) {
      for (const id of p.members) {
        if (id === socket.userID || !lobbies.leave(id)) continue;
        const s = socketsByUser.get(id);
        if (s) s.emit('leave-mm-group');
        setPresence(id, 'menu');
      }
    }
  });
  // Showdown: leave the series from the menu (the next round isn't played).
  on('showdown-leave', () => {
    const series = showdowns.leave(socket.userID);
    if (series) {
      if (showdowns.markRecorded(socket.userID)) recordShowdown(socket.userID, false);
      socket.emit('remaster-showdown', showdownState('left', series));
    }
  });
  // Matchmaking lobby: this player's map vote (MatchLobby.js).
  on('lobby-vote-map', (msg) => { lobbies.vote(socket.userID, msg && typeof msg.map === 'string' ? msg.map : null); });
  on('leave-group', () => socket.emit('left-group', 0));

  on('set-card', (msg) => {
    if (!socket.userID) return;
    // Card IDs are item type IDs (the game sends a number or a numeric string).
    const id = msg && msg.cardID;
    const ok = (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && /^\d{1,12}$/.test(id));
    const p = getProfile(socket.userID);
    // Only a card the player owns (ranked reward cards included once earned).
    const item = ok ? catalogByTid.get(Number(id)) : null;
    const owned = item && !NOT_OWNABLE.has(item.class) && levelReached(p, item) && (!isCustom(item) || ownsItem(p, item));
    if (ok && Number(id) !== 0 && !owned) log('set-card refused (not owned)', socket.userID, id);
    p.cardID = ok && (Number(id) === 0 || owned) ? id : 0;
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
    entitlements(getProfile(socket.userID)));
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
    const p = getProfile(socket.userID);
    // Nothing to buy: an unknown ID, currency or a crate is never "bought".
    if (!item || NOT_OWNABLE.has(item.class)) {
      socket.emit('purchase-fail', { reason: 'unknown-item' });
      return;
    }
    if (item.rankedReward && !p.owned.includes(typeId)) {
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
    const p = getProfile(socket.userID);
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

  // Friends and parties (Friends.js). Every action answers with
  // remaster-friend-result and pushes the new state (remaster-friends).
  const friendAction = (action, fn) => on(action, (msg) => {
    const me = socket.userID;
    const reply = (r) => socket.emit('remaster-friend-result', Object.assign({ action }, r));
    if (!usernameOf(me)) return reply({ error: 'no-account' });
    if (action !== 'friends-get' && action !== 'player-card' && !allowFriendAction(me)) return reply({ error: 'slow-down' });
    fn(me, msg && typeof msg === 'object' ? msg : {}, reply);
  });
  const target = (msg) => (typeof msg.username === 'string' && msg.username.length <= 40 ? userIDForName(msg.username) : null);
  friendAction('friends-get', (me) => sendFriends(me));
  friendAction('friend-request', (me, msg, reply) => {
    const to = target(msg);
    if (!to) return reply({ error: 'no-such-player', username: msg.username });
    const r = friends.request(me, to);
    reply(Object.assign({ username: usernameOf(to) }, r));
    if (r.ok) { notifyFriends(me); sendFriends(to); }
  });
  for (const [action, method] of [['friend-accept', 'accept'], ['friend-decline', 'decline'], ['friend-remove', 'remove']]) {
    friendAction(action, (me, msg, reply) => {
      const other = target(msg);
      if (!other) return reply({ error: 'no-such-player', username: msg.username });
      const r = friends[method](me, other);
      reply(Object.assign({ username: usernameOf(other) }, r));
      if (r.ok) { notifyFriends(me); notifyFriends(other); }
    });
  }
  friendAction('party-invite', (me, msg, reply) => {
    const to = target(msg);
    if (!to) return reply({ error: 'no-such-player', username: msg.username });
    const r = friends.invite(me, to);
    reply(Object.assign({ username: usernameOf(to) }, r));
    if (!r.ok) return;
    const s = socketsByUser.get(to);
    if (s && s.connected) s.emit('remaster-party-invite', { partyId: r.partyId, from: friendEntry(me) });
    notifyFriends(me);
    sendFriends(to);
  });
  // Who was in a party before a change: a party left with one player is
  // dropped, and that last player hears of it too.
  const membersOf = (p) => (p ? p.members.slice() : []);
  friendAction('party-accept', (me, msg, reply) => {
    const before = membersOf(friends.party(me));
    const r = friends.acceptInvite(me, shortString(msg.partyId, 40, ''));
    reply(r.ok ? { ok: true, partyId: r.party.id } : r);
    if (!r.ok) return;
    for (const id of before) sendFriends(id);
    for (const id of r.party.members) notifyFriends(id);
  });
  friendAction('party-decline', (me, msg, reply) => {
    const partyId = shortString(msg.partyId, 40, '');
    const before = membersOf(friends.parties.get(partyId));
    const r = friends.declineInvite(me, partyId);
    reply(r.ok ? { ok: true } : r);
    if (r.ok) for (const id of new Set([me].concat(before))) sendFriends(id);
  });
  friendAction('party-leave', (me, msg, reply) => {
    const before = membersOf(friends.party(me));
    const p = friends.leave(me);
    reply(p ? { ok: true } : { error: 'not-in-party' });
    for (const id of new Set([me].concat(before))) sendFriends(id);
  });
  // A player's card: yours, or anyone's by username (no such player: found false).
  friendAction('player-card', (me, msg) => {
    const id = msg.username === undefined ? me : target(msg);
    socket.emit('remaster-player-card', id ? Object.assign({ found: true }, playerCard(id, me))
      : { found: false, username: typeof msg.username === 'string' ? msg.username.slice(0, 40) : null });
  });

  // The global leaderboard (Leaderboard.js): every board, with your own rows.
  on('remaster-leaderboard-get', () => {
    if (!allowLeaderboard(socket.userID)) return socket.emit('remaster-leaderboard', { error: 'slow-down' });
    socket.emit('remaster-leaderboard', leaderboard.view(usernameOf(socket.userID) ? socket.userID : null));
  });

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
    if (!socket.lobby) return socket.emit('lobby-update-fail', {});
    const map = socket.lobby && /prison|jungle2/i.test(socket.lobby.mapName) ? 1 : 0;
    tickets.start(socket.userID, socket.ip, { map: map ? 'prison' : 'jungle', mode: 'custom' });
    socket.emit('match-ready', { gameServer: 'offline:' + map, nonce: 'x', serverNonce: 'x' });
  });

  socket.on('disconnect', (reason) => {
    accessLog('socket disconnected', socket.userID || socket.id, reason);
    connectedSockets--;
    const left = (socketsByIp.get(socket.ip) || 1) - 1;
    if (left > 0) socketsByIp.set(socket.ip, left); else socketsByIp.delete(socket.ip);
    clearTimeout(socket.loginTimer);
    if (socket.userID && socketsByUser.get(socket.userID) === socket) {
      lobbies.leave(socket.userID);
      socketsByUser.delete(socket.userID);
      if (usernameOf(socket.userID)) friends.seen(socket.userID);
      notifyFriends(socket.userID);
      // Offline with no match running: nothing to remember about them.
      if (!tickets.peek({ userID: socket.userID })) presence.delete(socket.userID);
    }
  });
});

// A stand-in for players with no profile (looked up, never stored).
const BLANK_PROFILE = { stats: { wins: 0, kills: 0, level: 1, rank: 0 }, cardID: 0 };

// ---------------------------------------------------------------- start / stop

// Writes everything unsaved, synchronously. Safe to call more than once.
function flushAll(why) {
  const wroteProfiles = profileStore.flushSync();
  const wroteSessions = sessions.flushSync();
  tickets.flushSync();
  showdowns.flushSync();
  const wroteAccounts = accounts.flushSync();
  friends.flushSync();
  activity.flushSync();
  if (wroteProfiles || wroteSessions || wroteAccounts) {
    log('saved on ' + why + ':', [wroteProfiles && 'profiles', wroteSessions && 'sessions', wroteAccounts && 'accounts']
      .filter(Boolean).join(', '));
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
  accounts.close();
  friends.close();
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
