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
// CULLING_PORT=0 listens on a free port the system picks (the tests: suites
// never collide); the port is then written to CULLING_PORT_FILE, if set.
let BASE = (process.env.CULLING_PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/+$/, '');
const DATA_DIR = process.env.CULLING_DATA_DIR || path.join(__dirname, 'data');
const PROFILE_FILE = path.join(DATA_DIR, 'profiles.json');

// Queue name -> offline map index understood by the game's StartOfflineMatch
// (0 = Jungle / "The Island", 1 = Prison).
// The two offline matches the game can start (DefaultGame.ini OfflineMap /
// OfflineMap2): the lobby's map vote picks one.
// With CULLING_NIGHT_MAPS=1 the vote also offers the night maps (2 Jungle
// Night, 3 Prison Night; patch/make_weather.py), which open by URL with their
// weather (server/weather.js).
const weather = require('./weather');
const WEATHER = weather.settings();
const MAPS = weather.maps(WEATHER);
// Contestants the game places on each map: one per pod, 16 on Jungle and
// Prison (weather.js FIELD; the night maps are copies of the day ones).
const FIELD_BY_MAP = weather.fieldByMap(WEATHER);
// Showdown (patch/make_showdown.py): you against one rival in the Jungle centre
// arena. No lobby or map vote; the menu starts it from "showdown:<format>".
// Team Showdown (showdown_duo/trio/quad, playlists.js): your team of N (you
// and AI teammates) against N AI rivals. A party of up to N shares a lobby
// (one team, no map vote) and match record; the menu starts it from
// "showdown:<N>" (the arena URL with ?TeamSize=N).
// Rounds: first to 4 (ShowdownSeries), all in one match with the patched exe
// (patch/showdown_rounds.c): the HUD reports each round (/api/showdown/round)
// and the match result that ends the series pays for the series once
// (seriesPayout: its own economy, not a full match per round). A series can be
// over fast, so its result needs 15 s, not the 2 minutes of a normal match. The
// kits (the same for both sides; the game picks the round's) come from
// data/showdown.json, written by make_showdown.py.
// A round reported sooner than minRoundSeconds after the series started or the
// round before doesn't count (FULL_AUDIT_2026-11-06 round 2: instant "W"
// rounds); the series' result is held to the match-pay limits (PAY,
// MIN_MATCH_SECONDS) like any other match.
const SHOWDOWN = { queue: 'showdown', map: 'arena', format: '1v1', field: 2, roundsToWin: 4,
  minSeconds: parseInt(process.env.CULLING_SHOWDOWN_MIN_SECONDS || '15', 10),
  minRoundSeconds: parseInt(process.env.CULLING_SHOWDOWN_MIN_ROUND_SECONDS || '20', 10) };
let showdownKit = null, showdownKits = null;
try {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'showdown.json'), 'utf8'));
  showdownKit = data.kit || null;
  showdownKits = Array.isArray(data.kits) && data.kits.length ? data.kits : null;
} catch (e) { showdownKit = null; showdownKits = null; }
const showdownState = (phase, series) => ({ phase, series, kit: showdownKit, kits: showdownKits,
  format: series && series.format ? series.format : SHOWDOWN.format });
const ranked = require('./ranked');
const { Sessions, MatchTickets, rateLimiter, clientIp } = require('./session');
const { CoalescedJsonFile, writeAtomicSync } = require('./store');
const { createMetrics, metricsAllowed } = require('./metrics');
const acc = require('./accounts');
const { MatchLobbies } = require('./matchlobby');
const playlists = require('./playlists');
const { Friends } = require('./friends');
const { Activity } = require('./activity');
const { Leaderboard } = require('./leaderboard');
const custom = require('./custommatch');
const backups = require('./backup');

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
// "_XP_" (".../IceAxe_XP_Lava_Storm" -> "Lava_Storm"). The VFX camos
// (patch/make_vfx_camos.py, ".../Katana_XP_VFX_Dark_Matter") work the same way.
const CAMO_SOURCES = new Set(['xp-camos', 'xp-vfx-camos']);
const camoKey = (i) => (CAMO_SOURCES.has(i.source) ? String(i.asset).split('_XP_')[1] || null : null);

function ownedCamos(p) {
  const out = new Set();
  for (const tid of p.owned || []) {
    const key = camoKey(catalogByTid.get(tid) || {});
    if (key) out.add(key);
  }
  return out;
}

// owned: the player's owned type IDs as a Set (ownedItems checks every
// catalog item against it).
function ownsItem(p, i, camos = ownedCamos(p), owned = null) {
  return (owned ? owned.has(i.tid) : (p.owned || []).includes(i.tid)) || camos.has(camoKey(i));
}

// Items with an unlockLevel (the airdrops that start locked, from
// patch/make_airdrop_unlocks.py) are owned once the player reaches it.
const levelReached = (p, i) => !i.unlockLevel || ((p.stats && p.stats.level) || 1) >= i.unlockLevel;

function ownedItems(p) {
  const camos = ownedCamos(p);
  const owned = new Set(p.owned || []);
  return catalog.filter((i) => !NOT_OWNABLE.has(i.class) && levelReached(p, i) && (!isCustom(i) || ownsItem(p, i, camos, owned)))
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
// Match pay is bounded by what a real match could earn (FULL_AUDIT_2026-11-06
// P0 #1: instant fake results paid kills, damage, XP and credits). A result
// shorter than MIN_MATCH_SECONDS pays nothing; kills and damage can't come
// faster than these rates (the ticket's elapsed time includes loading and the
// pod countdown, so real players are far inside them); and match credits and
// XP stop at a daily cap (UTC day). 0 turns a limit off.
const intEnv = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
const PAY = {
  secondsPerKill: intEnv('CULLING_SECONDS_PER_KILL', 20),
  damagePerSecond: intEnv('CULLING_DAMAGE_PER_SECOND', 10),
  dailyCredits: intEnv('CULLING_DAILY_MATCH_CREDITS', 8000),
  dailyXP: intEnv('CULLING_DAILY_MATCH_XP', 40000)
};
// What is left of today's match credits and XP for a player; take() records
// what was paid. The day's totals live on the profile (p.matchPay).
function dailyPay(p, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (!p.matchPay || typeof p.matchPay !== 'object' || p.matchPay.day !== day) p.matchPay = { day, credits: 0, xp: 0 };
  const t = p.matchPay;
  const left = (cap, used) => (cap > 0 ? Math.max(0, cap - (Number(used) || 0)) : Infinity);
  return {
    credits: (n) => Math.min(n, left(PAY.dailyCredits, t.credits)),
    xp: (n) => Math.min(n, left(PAY.dailyXP, t.xp)),
    take(credits, xp) { t.credits = (Number(t.credits) || 0) + credits; t.xp = (Number(t.xp) || 0) + xp; }
  };
}
// The menu turning a match down this soon after its match-ready (a cancel
// that crossed it, or match-declined) means the player never went in.
const DECLINE_WINDOW_MS = intEnv('CULLING_DECLINE_WINDOW_MS', 15000);
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
// Addresses on tickets are kept hashed (accounts.hashIp), never raw.
const tickets = new MatchTickets(Date.now, path.join(DATA_DIR, 'tickets.json'), {
  saveDelayMs: SAVE_DELAY_MS, hashIp: (ip) => accounts.hashIp(ip),
  onSaveError: (e) => { metrics.error('save'); log('saving match tickets failed:', e.message); }
});
// Showdown series (showdown.js), in data/showdown-series.json so a restart
// mid-series keeps the score.
const showdowns = new ShowdownSeries({ roundsToWin: SHOWDOWN.roundsToWin, file: path.join(DATA_DIR, 'showdown-series.json'),
  minRoundMs: SHOWDOWN.minRoundSeconds * 1000, saveDelayMs: SAVE_DELAY_MS, onSaveError: (e) => { metrics.error('save'); log('saving showdown series failed:', e.message); } });
// Friends (friends.json) and parties (memory); see friends.js.
// Recent activity for the launcher: matches today, players this week.
const activity = new Activity(Date.now, path.join(DATA_DIR, 'activity.json'));
const friends = new Friends(path.join(DATA_DIR, 'friends.json'), {
  saveDelayMs: SAVE_DELAY_MS,
  onSaveError: (e) => { metrics.error('save'); log('saving friends failed:', e.message); }
});
// Friend requests, removals and party invites per player: one a second, bursts of 20.
const allowFriendAction = rateLimiter(1, 20);
// Player cards per player: one a second, bursts of 10 (a card shows a
// player's record to anyone: this bounds looking names up in bulk).
const allowPlayerCard = rateLimiter(1, 10);
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

// Client text in the log: only letters, digits, _ . - and at most 32 of them
// (a 1 MB field with newlines could forge lines and roll the logs away).
const logField = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[^\w.-]/g, '').slice(0, 32) : '');
// A user ID in a log line about a refusal: a short hash, never the Steam ID.
const loggedID = (userID) => 'id#' + crypto.createHash('sha256').update(String(userID)).digest('hex').slice(0, 12);

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

// errorCode: what the game's menu reads from a refused /api/login (every
// refusal carries one, so the menu can say why it is offline).
app.use((req, res, next) => {
  if (stopping) { res.setHeader('Connection', 'close'); return res.status(503).json({ errorCode: 'stopping', error: 'stopping' }); }
  if (!allowHttp(requestIp(req))) return res.status(429).json({ errorCode: 'rate-limited', error: 'too-many-requests' });
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

// The request's fields: always an object (a body of JSON null, a number or a
// string is no fields, never a TypeError in the route: SERVER_AUDIT_2 F7).
function bodyObject(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    let parsed;
    try { parsed = JSON.parse(req.body); } catch (e) { return Object.fromEntries(new URLSearchParams(req.body)); }
    return parsed && typeof parsed === 'object' ? parsed : {};
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
  if (!validUserID(userID)) return res.status(400).json({ errorCode: 'invalid-userid', error: 'invalid-userid' });
  const ipHash = accounts.hashIp(requestIp(req));
  if (REQUIRE_ACCOUNT && !accounts.useGrant(userID, ipHash)) {
    log('login refused (no play grant)', loggedID(userID));
    return res.status(403).json({ errorCode: 'account-required', error: 'account-required' });
  }
  if (!hasProfile(userID)) {
    if (Object.keys(profiles).length >= MAX_PROFILES) return res.status(503).json({ errorCode: 'server-full', error: 'server-full' });
    if (!allowNewProfile(requestIp(req))) {
      return res.status(429).json({ errorCode: 'too-many-new-players', error: 'too-many-new-players' });
    }
  }
  const token = sessions.issue(userID);
  const p = getProfile(userID);
  // Where this profile last played from (hashed): an account can claim an
  // existing profile only from that address.
  if (p.lastLoginIpHash !== ipHash) { p.lastLoginIpHash = ipHash; saveProfiles(); }
  log('login', userID, 'authType=' + logField(body.authType), 'appid=' + logField(body.appid), 'build=' + logField(body.build));
  res.json({ token, redirect: `${BASE}/api`, userID, build: body.build || '0' });
});

// Every playlist, what it takes and whether it can be played (playlists.js).
app.get('/api/playlists', (req, res) => res.json({ playlists: playlists.list() }));

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

// The answers to results already paid, by the ticket's player and address
// (hashed): the HUD retries a post whose answer it didn't get (a slow first
// post), and a repeat within RESULT_REPLY_MS gets the same answer (200, same
// body) instead of a 409 that the HUD shows as "wasn't saved". Nothing is
// paid again. Found the way the ticket was: by token, else by address (and
// the HUD's nickname on a shared address), so another player still gets 409.
const RESULT_REPLY_MS = 10 * 60 * 1000;
const MAX_RESULT_REPLIES = 2000;
const resultReplies = new Map();     // userID + '|' + ipHash -> { userID, ipHash, at, body }, oldest first
function rememberResult(userID, ipHash, body) {
  const key = userID + '|' + ipHash;
  resultReplies.delete(key);
  resultReplies.set(key, { userID, ipHash, at: Date.now(), body: JSON.parse(JSON.stringify(body)) });
  while (resultReplies.size > MAX_RESULT_REPLIES) resultReplies.delete(resultReplies.keys().next().value);
}
function repeatedResult(userID, ipHash, nick) {
  const cutoff = Date.now() - RESULT_REPLY_MS;
  for (const [k, r] of resultReplies) { if (r.at >= cutoff) break; resultReplies.delete(k); }
  if (userID) return resultReplies.get(userID + '|' + ipHash) || null;
  const mine = [...resultReplies.values()].filter((r) => r.ipHash === ipHash
    && (!nick || String(usernameOf(r.userID) || '').toLowerCase() === nick));
  return mine.length === 1 ? mine[0] : null;
}

// Posted by the in-match HUD (patched hud.js) when you die or win. Paid once
// per match a player's menu started (the HUD has no token, so the ticket is
// found by address when needed).
app.post('/api/matchresult', (req, res) => {
  const body = bodyObject(req);
  // Players sharing an address are told apart by the in-game name the HUD
  // sends (their Remaster account name).
  const nick = typeof body.nickname === 'string' ? body.nickname.trim().toLowerCase() : '';
  const tokenUser = userFromRequest(req);
  const ipHash = accounts.hashIp(requestIp(req));
  const claim = tickets.claim({ userID: tokenUser, ip: requestIp(req),
    pick: nick ? (t) => String(usernameOf(t.userID) || '').toLowerCase() === nick : null });
  if (claim.error) {
    const again = claim.error === 'no-match' ? repeatedResult(tokenUser, ipHash, nick) : null;
    if (again) { log('match result repeated', again.userID, 'the stored answer'); return res.json(again.body); }
    log('match result rejected', claim.error, requestIp(req));
    return res.status(409).json({ error: claim.error });
  }
  const userID = claim.ticket.userID;
  const send = (out) => { rememberResult(userID, ipHash, out); res.json(out); };
  if (claim.ticket.map === SHOWDOWN.map) {
    activity.match(userID);
    return showdownMatchResult(send, claim, body, userID);
  }
  const p = getProfile(userID);
  // Bounded so a malformed report (e.g. "1e999" -> Infinity) can't write
  // Infinity/NaN credits or XP into profiles.json.
  const bounded = (v, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0);
  // Too short to be a real match: no win, and ranked counts it as last place.
  const tooShort = claim.elapsed < MIN_MATCH_SECONDS;
  const field = matchField(claim.ticket.map, body.cap);
  // A ranked team match (the ticket says which mode it scores): you can kill
  // every contestant but your own team.
  const rankedMode = claim.ticket.ranked ? ranked.modeId(claim.ticket.rankedMode) : null;
  const teamSize = rankedMode ? ranked.MODES[rankedMode].teamSize : 1;
  // Every other contestant at most, and no faster than PAY.secondsPerKill.
  const maxKills = Math.min(teamSize > 1 ? teamContestants(claim.ticket.map) - teamSize : field - 1,
    PAY.secondsPerKill > 0 ? Math.floor(claim.elapsed / PAY.secondsPerKill) : Infinity);
  // Within what 15 can take, and no faster than PAY.damagePerSecond.
  const maxDamage = Math.min(5000, PAY.damagePerSecond > 0 ? claim.elapsed * PAY.damagePerSecond : Infinity);
  const r = {
    victory: !tooShort && (body.victory === true || body.victory === 'true'),
    kills: bounded(parseInt(body.kills, 10), maxKills),
    damage: bounded(Number(body.damage), maxDamage),
    // No longer than the match has actually run.
    timeAlive: bounded(Number(body.timeAlive), Math.min(4 * 3600, claim.elapsed + 30)),
    func: bounded(parseInt(body.func, 10), 1e6)
  };
  const startXP = p.stats.xp;
  // Too short to be a real match: nothing paid and nothing on the career
  // (ranked still scores it as last place, below). Otherwise within the day's cap.
  const today = dailyPay(p);
  // A custom match (its settings are the player's own: more crates, faster
  // recyclers) pays half, still within the limits above.
  const rate = claim.ticket.mode === 'custom' ? 0.5 : 1;
  const fullXP = Math.floor(matchXP(r) * rate), fullCredits = Math.floor(matchCredits(r) * rate);
  const earned = tooShort ? 0 : today.xp(fullXP);
  const credits = tooShort ? 0 : today.credits(fullCredits);
  if (tooShort) log('match result too short', userID, Math.round(claim.elapsed) + ' s', 'nothing paid');
  else if (earned < fullXP || credits < fullCredits) log('match result over the daily cap', userID, credits + ' credits', earned + ' XP');
  today.take(credits, earned);
  p.cullCredits += credits;
  let rankedResult = null;
  // Only the result of the ranked match itself scores it: a Solo, Duo or
  // Showdown result never finishes a ranked match left pending, and a ranked
  // ticket scores only the pending match of its own mode (Ranked Duos can't
  // finish a Ranked Solo match, or the other way round).
  const pendingRanked = rankedMode ? ranked.record(p, rankedMode) : null;
  if (pendingRanked && pendingRanked.pending && pendingRanked.pending.id === claim.ticket.ranked) {
    const reported = parseInt(body.placement, 10);
    let placement, rankedField;
    if (teamSize > 1) {
      // The team's placement among the match's teams (ranked.teamPlacement):
      // first for the team's win (posted after your own death too, by the
      // HUD's team result), otherwise the team slice of your position; last
      // when the match was too short to be real or the position is malformed.
      rankedField = pendingRanked.pending.field;
      placement = tooShort ? rankedField : ranked.teamPlacement(rankedMode, reported, r.victory, rankedField);
    } else {
      // Within the field: a map whose contestants outnumber its field still
      // scores, as last place at worst; a malformed rank (missing, 0, negative)
      // is last place, never first. First place is the win, which needs a
      // victory on a match long enough to be real (tooShort); without one the
      // best a report can claim is second.
      rankedField = field;
      placement = tooShort ? field : r.victory ? 1
        : Number.isInteger(reported) && reported >= 1 ? Math.min(field, Math.max(2, reported)) : field;
    }
    if (tooShort) log('ranked result too short', Math.round(claim.elapsed) + ' s', 'counted as last place');
    // The ranked match is the one the server's ticket names (a client-sent
    // matchId is ignored).
    const out = ranked.finishMatch(p, { matchId: claim.ticket.ranked, placement, field: rankedField, kills: r.kills, damage: r.damage,
      timeAlive: r.timeAlive }, Date.now(), rankedGrant(p), rankedMode);
    if (out.error) log('ranked result rejected', out.error, JSON.stringify(body).slice(0, 200));
    else {
      // How the HUD decided the team's result (hud.js teamOutcome): logged and
      // kept on the entry, never scored.
      if (teamSize > 1 && typeof body.teamOutcome === 'string' && /^(won|out|left|waited)$/.test(body.teamOutcome)) {
        out.entry.teamOutcome = body.teamOutcome;
      }
      rankedResult = { entry: out.entry, summary: ranked.summary(p, Date.now(), rankedMode) };
      log('ranked result', rankedMode, out.entry.matchId, 'place', out.entry.placement + '/' + out.entry.field,
        out.entry.ratingBefore, '->', out.entry.ratingAfter, out.entry.tierAfter, out.entry.teamOutcome || '');
    }
  } else if (claim.ticket.ranked) {
    log('ranked result not scored: the ticket\'s', rankedMode, 'match', claim.ticket.ranked, 'is not pending');
  }
  const s = p.stats;
  s.xp = Math.min(seasonXPCap(), s.xp + earned);
  // What was really added (less than earned near the season cap).
  const xpAdded = s.xp - startXP;
  const level = Math.min(SEASON.maxLevel, levelForXP(s.xp) || s.level);
  const levelled = Boolean(level && level !== s.level);
  if (levelled) {
    log('level', userID, s.level, '->', level);
    s.level = level;
  }
  if (!tooShort) careerMatch(userID, p, r, claim.ticket.mode);
  p.lastMatch = Object.assign({ at: Date.now(), xpEarned: xpAdded }, r);
  saveProfiles();
  log('match result', userID, JSON.stringify(r), `+${xpAdded} XP (${startXP} -> ${s.xp}), +${credits} credits`);
  const socket = socketsByUser.get(userID);
  if (socket) sendPlayer(socket, p);
  // A new level can unlock airdrops: the menu gets them without a restart.
  if (socket && levelled) socket.emit('entitlements-response', entitlements(p));
  setPresence(userID, 'menu');
  send({ startXP, xpEarned: xpAdded, stats: s, credits, ranked: rankedResult, showdown: null });
});

// A real match on the career: games, kills, wins, damage and time, overall and
// per mode, and the launcher's matches-today count.
function careerMatch(userID, p, r, ticketMode) {
  const s = p.stats;
  activity.match(userID);
  s.gamesPlayed += 1;
  s.kills += r.kills;
  s.wins += r.victory ? 1 : 0;
  s.totalDamage += Math.round(r.damage);
  s.minutesAlive += Math.round(r.timeAlive / 60);
  s.funcEarned += r.func;
  // Tickets saved by an older server have no mode: Solo. (This read a
  // `showdown` variable that no longer exists here, so such a result was a 500
  // after its ticket was taken and its XP and credits added: SERVER_AUDIT_2 F4.)
  const mode = ticketMode || 'ffa';
  if (mode !== SHOWDOWN.queue) {
    if (!p.modes || typeof p.modes !== 'object') p.modes = {};
    const m = p.modes[mode] || (p.modes[mode] = { played: 0, wins: 0, kills: 0, damage: 0, minutesAlive: 0 });
    m.played += 1;
    m.wins += r.victory ? 1 : 0;
    m.kills += r.kills;
    m.damage += Math.round(r.damage);
    m.minutesAlive += Math.round(r.timeAlive / 60);
  }
}

// The match result of a Showdown match: the end of the series (the patched
// exe plays every round in the match; this result names the round it ends,
// which counts if the HUD's round report hasn't already). The series pays
// once, when it is over: seriesPayout's XP and credits, one game on the
// career, a win only for the series. Older builds play one round per match:
// the round counts here and the series pays when its last round does.
// The match-pay limits hold here too: a series shorter than MIN_MATCH_SECONDS
// (its match's ticket time) or a forfeit with no round played pays nothing and
// puts nothing on the career, kills and damage are bounded by the series' time
// at the PAY rates, and the daily cap applies.
function showdownMatchResult(send, claim, body, userID) {
  const p = getProfile(userID);
  const tooShort = claim.elapsed < MIN_MATCH_SECONDS;
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
  const played = paid ? paid.rounds.filter((x) => x !== 'left').length : 0;
  if (paid && (tooShort || !played)) {
    // Nothing paid and no win on the record (a loss still counts as one).
    if (showdowns.markRecorded(userID) && !paid.won) recordShowdown(userID, false, paid.mode);
    log('showdown series not paid', userID, paid.wins + '-' + paid.losses,
      tooShort ? 'too short (' + Math.round(claim.elapsed) + ' s)' : 'no round played');
  } else if (paid) {
    const r = seriesPayout(paid, { kills: body.kills, damage: body.damage, timeAlive: body.timeAlive,
      maxTime: Math.min(4 * 3600, claim.elapsed + 30),
      maxKills: PAY.secondsPerKill > 0 ? Math.floor(claim.elapsed / PAY.secondsPerKill) : Infinity,
      maxDamage: PAY.damagePerSecond > 0 ? claim.elapsed * PAY.damagePerSecond : Infinity });
    const today = dailyPay(p);
    earned = today.xp(r.xp);
    credits = today.credits(r.credits);
    today.take(credits, earned);
    p.cullCredits += credits;
    st.xp = Math.min(seasonXPCap(), st.xp + earned);
    earned = st.xp - startXP;                 // what was really added (near the season cap: less)
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
    if (showdowns.markRecorded(userID)) recordShowdown(userID, paid.won, paid.mode);
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
  send({ startXP, xpEarned: earned, stats: st, credits, ranked: null,
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
    // A series over sooner than a real match could be goes on the record with
    // its match result (showdownMatchResult), which holds it to the limits.
    const realLength = (Date.now() - ticket.startedAt) / 1000 >= MIN_MATCH_SECONDS;
    if (view.over && realLength && showdowns.markRecorded(userID)) recordShowdown(userID, view.won, view.mode);
    setPresence(userID, 'match', { mode: view.mode, round: view.round });
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
  const mine = tickets.fromIp(ip).filter((t) => t.map === SHOWDOWN.map);
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
  // Ranked records: Solo (ranked) and the team modes (rankedTeams.duo/trio/quad).
  const rankedRecord = (src) => {
    // Rating changes in the history can be negative; everything else not.
    const r = cleanValue(src, false);
    r.history = Array.isArray(src.history) ? src.history.slice(0, 50).map((h) => cleanValue(h, true)) : [];
    if (!isPlainObject(r.processed)) r.processed = {};
    if (!isPlainObject(r.tiersReached)) r.tiersReached = {};
    // A match left running on another server can't be finished here.
    r.pending = null;
    return r;
  };
  if (isPlainObject(raw.ranked)) p.ranked = rankedRecord(raw.ranked);
  if (isPlainObject(raw.rankedTeams)) {
    for (const mode of ranked.TEAM_MODE_IDS) {
      if (!isPlainObject(raw.rankedTeams[mode])) continue;
      if (!p.rankedTeams) p.rankedTeams = {};
      p.rankedTeams[mode] = rankedRecord(raw.rankedTeams[mode]);
    }
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
  // The asked mode (?mode=solo|duo|trio|quad; Solo by default, as older menus
  // and HUDs read it) at the top, and every mode's summary under `modes` (the
  // Ranked screen's tabs). Reading a team mode never played writes nothing.
  const p = getProfile(userID);
  const mode = ranked.modeId(req.query && req.query.mode);
  const modes = ranked.summaries(p);
  res.json(Object.assign({}, modes[mode], { modes }));
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
  const out = { error: status >= 500 ? 'server-error' : String(err.type || 'bad-request') };
  // A login body that can't be read has no user ID in it.
  if (req.path === '/api/login' && status < 500) out.errorCode = 'invalid-userid';
  res.status(status).json(out);
});

// ---------------------------------------------------------------- socket.io

const server = http.createServer(app);
// Keep-alive connections idle for longer than this are closed (Caddy reuses
// its upstream connections well within it).
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;
// The socket layer, before any login (performance review P1: four clients
// uploading ~1 MB polling payloads kept a core busy: engine.io concatenates
// the body chunk by chunk, and the binary payload is decoded byte by byte):
// - maxHttpBufferSize: a message is at most 64 KB (engine.io 3's default is
//   100 MB; nothing the game sends is more than a few KB);
// - a polling upload whose Content-Length is over that is refused (413)
//   before its body is read, and polling uploads are rate limited per address
//   (as many as socket events: a client posts at most one batch per event);
// - new sessions (handshakes, polling or websocket) are rate limited per
//   address: a burst of 30, then one a second.
const SOCKET_MAX_BYTES = intEnv('CULLING_SOCKET_MAX_BYTES', 64 * 1024);
const allowSocketPost = rateLimiter(30, 90);
const allowHandshake = rateLimiter(1, 30);
const io = socketio(server, { pingInterval: 10000, pingTimeout: 30000, cookie: false, maxHttpBufferSize: SOCKET_MAX_BYTES,
  allowRequest: (req, fn) => {
    const ok = allowHandshake(clientIp(req.connection.remoteAddress, req.headers['x-forwarded-for']));
    if (!ok) metrics.error('handshakeRefused');
    fn(ok ? null : 'too-many-sessions', ok);
  } });
// engine.io's request listener calls io.engine.handleRequest: polling uploads
// are checked first, and a refused one never reaches engine.io.
const engineHandleRequest = io.engine.handleRequest.bind(io.engine);
io.engine.handleRequest = (req, res) => {
  if (req.method === 'POST') {
    const length = parseInt(req.headers['content-length'], 10);
    const tooBig = Number.isFinite(length) && length > SOCKET_MAX_BYTES;
    if (tooBig || !allowSocketPost(requestIp(req))) {
      metrics.error(tooBig ? 'socketUploadTooBig' : 'socketDropped');
      res.writeHead(tooBig ? 413 : 429, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end();
      return;
    }
  }
  engineHandleRequest(req, res);
};
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
    presence: presence.size,
    backups: { dir: BACKUP_DIR, everyMs: BACKUP_EVERY_MS, keep: BACKUP_KEEP, last: lastBackup },
    matchLobbies: lobbies.stats(),
    leaderboard: leaderboard.stats(),
    accounts: Object.assign({ required: REQUIRE_ACCOUNT }, accounts.stats()),
    rateLimiterKeys: { http: allowHttp.size(), socket: allowSocket.size(), socketPost: allowSocketPost.size(),
      handshake: allowHandshake.size(), newProfile: allowNewProfile.size(),
      registerAttempt: allowRegisterAttempt.size(), register: allowRegister.size(), loginIp: allowLoginIp.size(),
      loginUser: allowLoginUser.size(), leaderboard: allowLeaderboard.size(), playerCard: allowPlayerCard.size() },
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

// Queue names and playlists (playlists.js): a malformed name is Solo.
const queueName = playlists.queueName;

// Matchmaking: players searching the same playlist wait in one lobby and see
// each other (matchlobby.js), then each starts the match. Gather and countdown
// times are configurable (tests shorten them).
const lobbies = new MatchLobbies({
  options: {
    gatherMs: parseInt(process.env.CULLING_LOBBY_GATHER_MS || '10000', 10),
    // The pregame lobby: long enough to see the match's roster and the map.
    countdownMs: parseInt(process.env.CULLING_LOBBY_COUNTDOWN_MS || '10000', 10),
    // Team Showdown: a lobby is one team (your party, up to its size).
    maxPlayers: { default: 16, showdown_duo: 2, showdown_trio: 3, showdown_quad: 4 },
    maps: Object.keys(MAPS),
    // Team Showdown is always the arena: no map vote, its own bots (2N - 1).
    queues: { showdown_duo: { maps: false, matchBots: 3 }, showdown_trio: { maps: false, matchBots: 5 },
      showdown_quad: { maps: false, matchBots: 7 } },
    // Who else is in each player's match: the game fills it with bots up to
    // the map's pods (FIELD_BY_MAP: 16; Victory.exe caps players plus bots at
    // 16 stock, and the patched exe at the mode's free starts).
    matchBots: 15,
    matchBotsByMap: Object.fromEntries(Object.entries(FIELD_BY_MAP).map(([m, n]) => [m, n - 1])),
    // No lobby note: menus never say the other contestants are bots.
    note: null
  },
  // In a ranked team lobby, each player's rank is their rank in that mode.
  describe: (m) => { const l = lobbies.lobbyOf(m.id); return lobbyCard(m.id, l ? l.queue : null); },
  send: (m, payload) => {
    setPresence(m.id, payload.state === 'searching' ? 'searching' : 'lobby', { mode: payload.queue });
    const s = memberSocket(m);
    if (!s) return;
    s.emit('remaster-lobby', payload);
    s.emit('players-in-queue', { count: payload.players.length });
  },
  start: (lobby) => allocateMatch(lobby),
  onError: (e, lobby, where) => lobbyFailed(e, lobby, where)
});

// A ranked record's rating this season, within the season cap, or null (none,
// or last season's: a record is only brought to the new season when played).
function seasonRating(rec) {
  return rec && Number.isFinite(rec.rating) && rec.season === ranked.CONFIG.season.id
    ? Math.min(ranked.CONFIG.maxRating, rec.rating) : null;
}

// What other players see of someone in a lobby: no IDs, nothing private.
// `playlist`: the lobby's; a ranked team playlist shows that mode's rank (none
// before the player's first match in it), anything else the Solo rank; this
// season's only.
function lobbyCard(userID, playlist) {
  const p = peekProfile(userID);
  const key = accounts.keyForUserID(userID);
  const a = key ? accounts.get(key) : null;
  const teamMode = ranked.modeForPlaylist(playlist);
  const rec = teamMode && teamMode !== 'solo' ? ranked.record(p, teamMode) : p && p.ranked;
  const rating = seasonRating(rec);
  return {
    name: a ? a.username : 'Player',
    level: p && p.stats ? Math.min(SEASON.maxLevel, p.stats.level || 1) : 1,
    cardID: p ? p.cardID || 0 : 0,
    rank: rating === null ? null : ranked.tierFor(rating).name
  };
}

// The playlist a queue name asks for, as { mode, map }: one lobby per
// playlist, the map as the player's first vote.
function lobbyQueue(raw) {
  const r = playlists.resolve(raw);
  let map = r.map;
  // A night map (CULLING_NIGHT_MAPS=1, server/weather.js) is asked for by name.
  if (map && /night/i.test(r.queue) && MAPS[map + '-night'] !== undefined) map += '-night';
  return { mode: r.playlist.id, map };
}

// The team modes: the team size, and the prefix of the match the menu opens
// ("duo:<map>", "trio:<map>", "quad:<map>"; patch/make_duo.py's URLs). A party
// never holds more than its team (playlists.js maxParty = teamSize).
const TEAM_MODES = { coop2: { size: 2, start: 'duo:' }, coop3: { size: 3, start: 'trio:' }, coop4: { size: 4, start: 'quad:' } };
// Ranked Duos, Trios and Quads launch exactly as the casual team matches (the
// same URLs: Ranked Solo is Solo's offline:<map> too); only the ticket's
// ranked match makes them ranked.
TEAM_MODES.ranked_coop2 = TEAM_MODES.coop2;
TEAM_MODES.ranked_coop3 = TEAM_MODES.coop3;
TEAM_MODES.ranked_coop4 = TEAM_MODES.coop4;

// Contestants a team match on `map` has (every team mode needs the patched
// exe, which places the map's full field: 16, one per pod; Trios take 15).
function teamContestants(map) {
  return FIELD_BY_MAP[map] || ranked.CONFIG.maxField;
}

// A socket that is logged in and connected now, for a player.
function liveSocket(userID) {
  const s = socketsByUser.get(userID);
  return s && s.connected ? s : null;
}

// The socket a lobby member is reached on: the one they queued from while it
// is connected, else the one they are logged in on now (after a reconnect).
function memberSocket(m) {
  return m.socket && m.socket.connected ? m.socket : liveSocket(m.id);
}

// Refuses a queue request, saying why (the menu shows `message`).
function refuseQueue(socket, reason, message, extra = {}) {
  log('queue refused', socket.userID, reason);
  socket.emit('join-mm-fail', Object.assign({ reason, message }, extra));
}

// Takes a whole party out of matchmaking: everyone in its lobby leaves, and
// each member's menu is told why (`reason`, `message`). `except` (the player
// who asked, answered with leave-mm-ack instead) isn't told again. Returns
// whether the party was queued.
function cancelPartyQueue(party, reason, message, except = null) {
  const queued = lobbies.partyMembers(party.id);
  if (!queued.length) return false;
  log('party', party.id, 'queue cancelled:', reason);
  for (const id of queued) {
    lobbies.leave(id);
    setPresence(id, 'menu');
    const s = id === except ? null : liveSocket(id);
    if (s) s.emit('leave-mm-group', { reason, message });
  }
  return true;
}

// Whether `userID` is waiting in a lobby as part of `party`.
function partyQueued(party, userID) {
  const lobby = lobbies.lobbyOf(userID);
  return !!lobby && lobby.members.get(userID).party === party.id;
}

// A party member offline for longer than this (and not in a match) leaves the
// party, and the others are told: a party never waits on someone who has
// gone, and is never led by someone who isn't there. Coming back in time
// (the menu logs in again, e.g. after every match) keeps their place.
// A timer's work: an exception is counted and logged, never uncaught (the
// server exits on an uncaught exception).
function guarded(what, fn) {
  try { return fn(); } catch (e) { metrics.error('timer'); log(what, 'failed:', e && e.stack ? e.stack : e); }
}

const PARTY_OFFLINE_MS = parseInt(process.env.CULLING_PARTY_OFFLINE_MS || '120000', 10);
const offlineTimers = new Map();     // userID -> timer
function stopWatchingOffline(userID) {
  clearTimeout(offlineTimers.get(userID));
  offlineTimers.delete(userID);
}
function watchPartyOffline(userID) {
  stopWatchingOffline(userID);
  if (!friends.party(userID)) return;
  const timer = setTimeout(() => guarded('party offline check', () => {
    offlineTimers.delete(userID);
    if (liveSocket(userID)) return;
    if (presenceState(userID) === 'match') return watchPartyOffline(userID);   // playing: their menu comes back after
    const p = friends.party(userID);
    if (!p) return;
    const before = p.members.slice();
    const wasLeader = p.leader === userID;
    const name = usernameOf(userID) || 'A party member';
    friends.leave(userID);
    const leader = p.members.length > 1 ? usernameOf(p.leader) : null;
    log('party', p.id, 'removed offline member', userID, wasLeader && leader ? '(leader now ' + p.leader + ')' : '');
    for (const id of before) {
      if (id === userID) continue;
      const s = liveSocket(id);
      if (s) {
        s.emit('remaster-party-notice', { reason: 'member-offline', username: name, leader,
          message: name + ' has been offline for a while and left the party.' + (wasLeader && leader ? ' ' + leader + ' leads now.' : '') });
      }
      sendFriends(id);
    }
  }), PARTY_OFFLINE_MS);
  if (timer.unref) timer.unref();
  offlineTimers.set(userID, timer);
}

// A player asks to queue (the menu's join-mm, or the game's /api/matchqueue).
// A party queues as one: only its leader can queue it, every member must be
// in the menu, the playlist must take a party that size, and every member
// joins one lobby and later gets the same match. Nothing is half done: a
// request that can't be met is refused, with the reason, before anyone moves.
function startLocalMatch(socket, raw) {
  const userID = socket.userID;
  const { queue: q, playlist } = playlists.resolve(raw);
  const { map } = lobbyQueue(raw);      // the first vote (a night map by name when offered)
  const mode = playlist.id;
  const p = friends.party(userID);
  const size = p ? p.members.length : 1;
  const current = lobbies.lobbyOf(userID);

  // A party member doesn't queue on their own. Already in their party's lobby
  // (they pressed a mode again): they stay there. Otherwise: refused.
  if (p && size > 1 && p.leader !== userID) {
    if (current && lobbies.lobbyOf(p.leader) === current) {
      socket.emit('join-mm-group', { queueName: q, playlist: current.queue, partyId: p.id });
      socket.emit('remaster-lobby', lobbies.view(current));
      return;
    }
    const leader = usernameOf(p.leader) || 'Your party leader';
    return refuseQueue(socket, 'party-leader-queues',
      leader + ' leads your party: only the leader can queue it. Leave the party to queue on your own.');
  }
  const ok = playlists.checkParty(playlist, size);
  if (!ok.ok) return refuseQueue(socket, ok.error, ok.message, { playlist: mode });

  // Already queued for this playlist (with the whole party, if in one):
  // nothing changes (a repeated request).
  if (current && current.queue === mode && (size === 1 || partyQueued(p, userID))) {
    socket.emit('join-mm-ack');
    socket.emit('remaster-lobby', lobbies.view(current));
    return;
  }
  // Another playlist: allowed while that lobby is still searching (the party
  // moves together), not once its match is counting down.
  if (current && current.state !== 'searching') {
    return refuseQueue(socket, 'match-starting', 'Your match is about to start: leave the lobby before choosing another mode.');
  }

  // Every member must be here to play: online, in the menu, not in a match.
  const others = p && size > 1 ? p.members.filter((id) => id !== userID) : [];
  const away = others.filter((id) => !liveSocket(id) || presenceState(id) === 'match');
  if (away.length) {
    const names = away.map((id) => usernameOf(id) || 'A party member');
    return refuseQueue(socket, 'party-not-ready', names.join(', ') + (names.length > 1 ? ' are' : ' is')
      + ' not in the menu (offline or in a match): your party can queue when everyone is back.',
    { members: names });
  }

  if (playlist.kind === 'showdown' && playlist.teamSize === 1) {
    socket.emit('join-mm-ack');
    // Out of any lobby still searching: its match-ready would land mid-series.
    lobbies.leave(userID);
    return launchMatch(socket, SHOWDOWN.queue, SHOWDOWN.map, { matchId: newMatchId(), lobbyId: null, partyId: null });
  }

  socket.emit('join-mm-ack');
  if (!others.length) {
    lobbies.join(mode, { id: userID, socket }, playlist.kind === 'showdown' ? null : map);
    return;
  }
  // The party: the members' menus follow the leader (join-mm-group, with the
  // queue so they show the right mode), then everyone joins one lobby at once.
  for (const id of others) liveSocket(id).emit('join-mm-group', { queueName: q, playlist: mode, partyId: p.id });
  const group = [{ id: userID, socket }].concat(others.map((id) => ({ id, socket: liveSocket(id) })));
  const lobby = lobbies.joinGroup(mode, group, playlist.kind === 'showdown' ? null : map, p.id);
  log('party', p.id, 'queued', mode, 'lobby', lobby.id, p.members.length, 'player(s)');
}

const newMatchId = () => crypto.randomBytes(8).toString('hex');

// Test hook: CULLING_FAULT_ALLOCATION=1 makes every lobby's match allocation
// fail (test/party.test.js), so the failure path is exercised for real.
const FAULT_ALLOCATION = process.env.CULLING_FAULT_ALLOCATION === '1';
// CULLING_FAULT_ALLOCATION=throw: the allocation throws instead (test/audit2.test.js),
// as a bug there would, from the lobby's countdown timer.
const FAULT_ALLOCATION_THROWS = process.env.CULLING_FAULT_ALLOCATION === 'throw';
const ALLOCATION_FAILED = 'The match could not be set up. Nobody was sent in: queue again.';

// A lobby's countdown ended: its match. Every member gets the same match id
// and lobby id (and their party's id), on their match-ready and their ticket.
// A party is all or nothing: if any member can't be sent (gone since the
// countdown), none of that party is, and each is told why; nothing (ticket,
// ranked match) has been started for them.
function allocateMatch(lobby) {
  const matchId = newMatchId();
  const members = [...lobby.members.values()];
  const fail = (ids, message) => {
    for (const id of ids) {
      setPresence(id, 'menu');
      const s = liveSocket(id);
      if (s) s.emit('join-mm-fail', { reason: 'allocation-failed', message, playlist: lobby.queue });
    }
  };
  if (FAULT_ALLOCATION) {
    log('lobby', lobby.id, 'allocation failed (CULLING_FAULT_ALLOCATION)');
    return fail(members.map((m) => m.id), ALLOCATION_FAILED);
  }
  if (FAULT_ALLOCATION_THROWS) throw new Error('allocation threw (CULLING_FAULT_ALLOCATION=throw)');
  const go = [];
  const byParty = new Map();
  for (const m of members) {
    if (!m.party) { if (memberSocket(m)) go.push(m); continue; }
    if (!byParty.has(m.party)) byParty.set(m.party, []);
    byParty.get(m.party).push(m);
  }
  for (const [party, list] of byParty) {
    const gone = list.filter((m) => !memberSocket(m));
    if (gone.length) {
      log('lobby', lobby.id, 'party', party, 'not allocated:', gone.length, 'member(s) gone');
      fail(list.map((m) => m.id), (gone.map((m) => usernameOf(m.id) || 'A party member').join(', '))
        + ' left before the match started: your party was not sent in.');
      continue;
    }
    go.push(...list);
  }
  log('lobby', lobby.id, lobby.queue, 'match', matchId, 'starting with', go.length, 'player(s)');
  // One player's match failing to start never stops the others' (that player
  // is told; nothing more was started for them).
  for (const m of go) {
    try {
      launchMatch(memberSocket(m), lobby.queue, lobby.map, { matchId, lobbyId: lobby.id, partyId: m.party || null });
    } catch (e) {
      metrics.error('timer');
      log('lobby', lobby.id, 'match for', m.id, 'failed to start:', e && e.stack ? e.stack : e);
      fail([m.id], ALLOCATION_FAILED);
    }
  }
}

// A lobby's view or match set-up threw (from its timers: uncaught, that would
// stop the server). Counted and logged; if the match set-up failed, nobody of
// the lobby was sent in, and each member is told.
function lobbyFailed(e, lobby, where) {
  metrics.error('timer');
  log('lobby', lobby ? lobby.id : '?', where, 'failed:', e && e.stack ? e.stack : e);
  if (where !== 'start' || !lobby) return;
  for (const id of lobby.members.keys()) {
    try {
      setPresence(id, 'menu');
      const s = liveSocket(id);
      if (s) s.emit('join-mm-fail', { reason: 'allocation-failed', message: ALLOCATION_FAILED, playlist: lobby.queue });
    } catch (e2) { log('telling', id, 'failed:', e2.message); }
  }
}

// The match starts for this player (against bots, on their PC). Ranked counts
// from here, so cancelling in the lobby costs nothing. `shared` is the match
// record the player's lobby shares: { matchId, lobbyId, partyId }.
function launchMatch(socket, queue, map, shared = {}) {
  const sdPlaylist = playlists.resolve(queue).playlist;
  const showdown = sdPlaylist.kind === 'showdown';
  const mode = showdown ? sdPlaylist.id : lobbyQueue(queue).mode;
  // Duo, Trios, Quads: the pairs mode with you and 1-3 teammates
  // (patch/make_duo.py); the menu starts it from "duo:<map>" ("trio:", "quad:").
  const team = TEAM_MODES[mode] || null;
  const mapIndex = Object.prototype.hasOwnProperty.call(MAPS, map) ? MAPS[map] : 0;
  let rankedId = null;
  const rankedMode = ranked.modeForPlaylist(mode);
  if (rankedMode && playlists.PLAYLISTS[mode].ranked) {
    const p = getProfile(socket.userID);
    // A team match is scored among its teams: the map's contestants / team size.
    const ticketMap = Object.prototype.hasOwnProperty.call(MAPS, map) ? map : 'jungle';
    const opts = { mode: rankedMode, field: team ? ranked.teamField(rankedMode, teamContestants(ticketMap)) : undefined };
    const { match, abandoned } = ranked.startMatch(p, Date.now(), rankedGrant(p), opts);
    if (abandoned) log('ranked abandoned', rankedMode, abandoned.matchId, abandoned.ratingBefore, '->', abandoned.ratingAfter);
    log('ranked match', rankedMode, match.id, 'rating', match.ratingBefore, 'mmr', match.mmr, 'field', match.field,
      shared.partyId ? 'party ' + shared.partyId : '');
    rankedId = match.id;
    saveProfiles();
  }
  const matchId = shared.matchId || newMatchId();
  // The match-ready's nonce, kept on the ticket: match-declined names it.
  const nonce = crypto.randomBytes(8).toString('hex');
  // The ticket says which match this is: its map, its mode, the ranked match
  // it scores (only that ranked match is finished by its result), and the
  // shared record (match, lobby, party).
  tickets.start(socket.userID, socketIp(socket), {
    nonce,
    map: showdown ? SHOWDOWN.map : Object.prototype.hasOwnProperty.call(MAPS, map) ? map : 'jungle',
    mode,
    ranked: rankedId,
    // Which mode's rating that ranked match is (solo, duo, trio, quad).
    rankedMode: rankedId ? rankedMode : null,
    matchId,
    lobbyId: shared.lobbyId || null,
    partyId: shared.partyId || null
  });
  if (!showdown) setPresence(socket.userID, 'match', { mode });
  else beginSeries(socket, sdPlaylist);
  // Night maps and weather: the map's URL with the match's weather preset and
  // seed ("map:<solo|duo>:<index>[?TeamSize=N]?Weather=..."); otherwise the
  // stock answers (offline:, duo:, trio:, quad:<map>).
  const sky = showdown ? null : weather.weatherFor(WEATHER, map);
  // Showdown: "showdown:1v1" (the arena URL), team Showdown "showdown:<N>"
  // (the arena URL with ?TeamSize=N; ClientWeb.js RemasterShowdownURL).
  const answer = showdown ? 'showdown:' + (sdPlaylist.teamSize > 1 ? sdPlaylist.teamSize : SHOWDOWN.format)
    : weather.gameServer(WEATHER, MAPS[map] === undefined ? 'jungle' : map, team, sky);
  log('match-ready ->', socket.userID, showdown ? 'showdown ' + sdPlaylist.format : (team ? team.start + ' map ' : 'offline map ') + mapIndex,
    'match', matchId, shared.partyId ? 'party ' + shared.partyId : '', sky ? 'weather ' + sky.preset + ' seed ' + sky.seed : '');
  socket.emit('match-ready', {
    gameServer: answer,
    nonce,
    serverNonce: crypto.randomBytes(8).toString('hex'),
    // The shared record. Each player's match still runs on their own PC with
    // AI contestants (and an AI teammate in Duo): netplay is false.
    matchId,
    lobbyId: shared.lobbyId || null,
    partyId: shared.partyId || null,
    playlist: mode,
    // The ranked mode this match is rated in (null: not ranked).
    ranked: rankedId ? rankedMode : null,
    netplay: false
  });
}

// The menu turned down the match it was just sent: the player left the search
// as the match-ready crossed it (leave-mm), or the menu ignored the
// match-ready (match-declined). Within DECLINE_WINDOW_MS of the match-ready
// and with no result yet, the match is closed: its ticket, and its pending
// ranked match without any penalty (it was never played); friends see the
// player back in the menu. Returns whether a match was closed. `nonce`: the
// match-ready's (match-declined sends it): only that match is closed; without
// one (older menus, leave-mm), the player's latest. The window holds either
// way, so a match being played can never be declined (a way out of a ranked
// loss).
function declineMatch(userID, why, nonce = null) {
  const t = tickets.peek({ userID });
  if (!t || Date.now() - t.startedAt > DECLINE_WINDOW_MS) return false;
  if (typeof nonce === 'string' && nonce && t.nonce && nonce !== t.nonce) return false;
  tickets.cancel(userID, t.id);
  if (t.ranked && ranked.cancelMatch(getProfile(userID), ranked.modeId(t.rankedMode), t.ranked)) saveProfiles();
  setPresence(userID, 'menu');
  log('match declined', userID, why, t.mode || '', t.ranked ? 'ranked ' + t.ranked + ' dropped' : '');
  return true;
}

// The whole series is this match (any team size): one left unfinished is
// forfeited first. The menu gets the series, friends see the round.
function beginSeries(socket, playlist) {
  const userID = socket.userID;
  const before = showdowns.current(userID);
  const { series, left } = showdowns.startSeries(userID, { mode: playlist.id, teamSize: playlist.teamSize });
  if (left && before && before.recorded === false) { before.recorded = true; recordShowdown(userID, false, before.mode); }
  socket.emit('remaster-showdown', showdownState('round', series));
  setPresence(userID, 'match', { mode: playlist.id, round: series.round });
}

// How many contestants a match had: the stock 16 unless the game reports a
// higher cap (builds with patch_exe.py), then what the map places, within it.
function matchField(map, cap) {
  if (map === SHOWDOWN.map) return SHOWDOWN.field;   // Showdown results are scored by showdownMatchResult
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
  if (!s.over && showdowns.leave(socket.userID) && showdowns.markRecorded(socket.userID)) recordShowdown(socket.userID, false, s.mode);
  if (s.over && showdowns.markAnnounced(socket.userID)) socket.emit('remaster-showdown', showdownState('over', showdowns.view(s)));
}

// ---------------------------------------------------------------- friends, parties, player cards

// What each player is doing, for their friends: menu, searching, lobby or
// match (with the mode, and the round in Showdown). Offline is derived.
const presence = new Map();     // userID -> { state, mode, round, since }
const MATCH_PRESENCE_MS = 45 * 60 * 1000;
const MODE_LABELS = { ffa: 'Solo', coop2: 'Duo', coop3: 'Trios', coop4: 'Quads', ranked_ffa: 'Ranked',
  ranked_coop2: 'Ranked Duos', ranked_coop3: 'Ranked Trios', ranked_coop4: 'Ranked Quads', showdown: 'Showdown',
  showdown_duo: 'Showdown Duos', showdown_trio: 'Showdown Trios', showdown_quad: 'Showdown Quads',
  lightning: 'Lightning', custom: 'Custom' };

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

// Every 10 minutes: what is remembered of players with no menu connected and
// no match running (a match never reported: a crash) is dropped.
const presenceSweep = setInterval(() => guarded('presence sweep', () => {
  for (const id of [...presence.keys()]) if (!liveSocket(id) && !tickets.peek({ userID: id })) presence.delete(id);
}), 10 * 60 * 1000);
if (presenceSweep.unref) presenceSweep.unref();

function setPresence(userID, state, extra = {}) {
  const was = presence.get(userID);
  // Back in the menu with no menu connected (the HUD's result after the game
  // was closed): offline, nothing to remember. These entries used to stay
  // for good (SERVER_AUDIT_2 F8).
  if (state === 'menu' && !liveSocket(userID)) {
    if (presence.delete(userID)) notifyFriends(userID);
    return;
  }
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
  if (mode && state !== 'offline' && state !== 'menu') label += ' · ' + mode + (st.round && /^Showdown/.test(mode) ? ' round ' + st.round : '');
  return { state, label, lastSeen: state === 'offline' ? friends.peek(userID).seen : null };
}

// A player as friends and party lists show them. `status` (what they are
// doing now, when they were last seen) is only for their friends and party
// (mayWatch): pushFriends and playerCard leave it out for anyone else.
function friendEntry(userID) {
  return Object.assign({ username: usernameOf(userID) || 'Player' }, lobbyCard(userID), { status: statusOf(userID) });
}
function mayWatch(viewer, userID) {
  if (viewer === userID || friends.areFriends(viewer, userID)) return true;
  const p = friends.party(viewer);
  return Boolean(p && p.members.includes(userID));
}
const withoutStatus = (e) => { const out = Object.assign({}, e); delete out.status; return out; };

// entry: friendEntry, or a cached one (flushFriends).
function partyView(userID, entry = friendEntry) {
  const p = friends.party(userID);
  if (!p) return null;
  return { id: p.id, leader: usernameOf(p.leader), you: usernameOf(userID),
    members: p.members.map((id) => Object.assign({}, entry(id), { leader: id === p.leader })) };
}

const STATE_ORDER = { match: 0, lobby: 1, searching: 2, menu: 3, offline: 4 };

// Everything a player's friends panel shows, pushed whenever it changes.
// The pushes are coalesced: every panel that changes during one turn of the
// event loop is sent once, right after it, and each player's entry is worked
// out once for all the panels that show it. Built and sent on the spot, one
// status change of a player with 200 friends online built 40,000 entries and
// blocked the event loop for ~85 ms (SERVER_AUDIT_2 P2, test/friends_load.js).
const friendsDirty = new Set();
let friendsFlush = null;
function sendFriends(userID) {
  friendsDirty.add(userID);
  if (!friendsFlush) friendsFlush = setImmediate(flushFriends);
}
function flushFriends() {
  friendsFlush = null;
  const ids = [...friendsDirty];
  friendsDirty.clear();
  const cache = new Map();
  const entry = (id) => {
    let e = cache.get(id);
    if (!e) cache.set(id, (e = friendEntry(id)));
    return e;
  };
  const t0 = performance.now();
  for (const id of ids) guarded('friends push', () => pushFriends(id, entry));
  // Timed in /metrics like a socket event (one per flush, however many panels).
  metrics.socketEvent('(friends push)', performance.now() - t0, false);
}
function pushFriends(userID, entry) {
  const socket = socketsByUser.get(userID);
  if (!socket || !socket.connected) return;
  const me = friends.peek(userID);
  // Friends and party members with their status; anyone else (requests) without.
  const shown = (id) => (mayWatch(userID, id) ? entry(id) : withoutStatus(entry(id)));
  const list = me.friends.map(entry)
    .sort((a, b) => STATE_ORDER[a.status.state] - STATE_ORDER[b.status.state] || a.username.localeCompare(b.username));
  socket.emit('remaster-friends', {
    you: usernameOf(userID),
    friends: list,
    incoming: me.incoming.map(shown),
    outgoing: me.outgoing.map(shown),
    party: partyView(userID, shown),
    invites: friends.invitesFor(userID).map((i) => ({ partyId: i.partyId, from: shown(i.from) })),
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

// A finished Showdown series on the player's record (their card shows it):
// 1v1 under `showdown` (as before), team Showdown per playlist under
// `showdownTeams` ({ showdown_duo: { won, lost }, ... }).
const SHOWDOWN_TEAM_MODES = ['showdown_duo', 'showdown_trio', 'showdown_quad'];
function recordShowdown(userID, won, mode) {
  const p = getProfile(userID);
  let rec;
  if (SHOWDOWN_TEAM_MODES.includes(mode)) {
    if (!p.showdownTeams || typeof p.showdownTeams !== 'object') p.showdownTeams = {};
    rec = p.showdownTeams[mode] = p.showdownTeams[mode] || { won: 0, lost: 0 };
  } else {
    rec = p.showdown = p.showdown || { won: 0, lost: 0 };
  }
  if (won) rec.won++; else rec.lost++;
  saveProfiles();
}

function showdownTeamsCard(p) {
  const out = {};
  for (const m of SHOWDOWN_TEAM_MODES) {
    const r = p.showdownTeams && p.showdownTeams[m];
    out[m] = { won: (r && r.won) || 0, lost: (r && r.lost) || 0 };
  }
  return out;
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
    showdownTeams: showdownTeamsCard(p),
    ranked: null
  });
  // What they are doing now: for themselves, their friends and their party only.
  if (viewer && mayWatch(viewer, userID)) card.status = statusOf(userID);
  // Ranked Solo this season (null: not played this season), like the team modes.
  const r = p.ranked;
  const rating = seasonRating(r);
  if (rating !== null && (r.matches || 0) > 0) {
    card.ranked = {
      season: { id: ranked.CONFIG.season.id, name: ranked.CONFIG.season.name },
      tier: ranked.tierFor(rating).name, rating,
      peakTier: r.peakTier || ranked.tierFor(rating).name,
      matches: r.matches || 0, wins: r.wins || 0,
      tiersReached: ranked.TIERS.filter((t) => r.tiersReached && r.tiersReached[t.name]).map((t) => t.name)
    };
  }
  // The team modes this season (null: not played this season).
  card.rankedTeams = {};
  for (const mode of ranked.TEAM_MODE_IDS) {
    const t = ranked.record(p, mode);
    const thisSeason = t && Number.isFinite(t.rating) && t.season === ranked.CONFIG.season.id && (t.matches || 0) > 0;
    const rating = thisSeason ? Math.min(ranked.CONFIG.maxRating, t.rating) : null;
    card.rankedTeams[mode] = thisSeason ? { tier: ranked.tierFor(rating).name, rating, matches: t.matches || 0, wins: t.wins || 0 } : null;
  }
  if (viewer) {
    const me = friends.peek(viewer);
    card.relation = viewer === userID ? 'you' : me.friends.includes(userID) ? 'friend'
      : me.outgoing.includes(userID) ? 'requested' : me.incoming.includes(userID) ? 'asked-you' : 'none';
  }
  return card;
}

// The full item list (get-inventory-types with a stale version): about 800
// KB, so it is built and encoded once (the catalog never changes while
// running) and written to each socket as is, at most once a minute per socket
// (FULL_AUDIT_2026-11-06 P1: a stale version re-sent it on every request).
const INVENTORY_RESEND_MS = 60 * 1000;
let inventoryTypesPacket = null;
function sendInventoryTypes(socket) {
  const payload = () => ({ data: { versionOK: false, currentVersion: CATALOG_VERSION, types: inventoryTypes() } });
  if (!inventoryTypesPacket) {
    io.encoder.encode({ type: io.parser.EVENT, nsp: '/', data: ['inventory-types-response', payload()] },
      (encoded) => { inventoryTypesPacket = encoded; });
  }
  if (inventoryTypesPacket) socket.client.packet(inventoryTypesPacket, { preEncoded: true });
  else socket.emit('inventory-types-response', payload());       // (the encoder answered later: never for text)
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
    stopWatchingOffline(userID);         // back in time: their party keeps them
    activity.seen(userID);
    const p = getProfile(userID);
    log('socket login', userID);

    socket.emit('auth-response');
    sendPlayer(socket, p);
    socket.emit('update-premium-currency', String(p.premiumCurrency));
    socket.emit('player-online-response', { data: socketsByUser.size });
    socket.emit('player-counts', { online: socketsByUser.size, inQueue: 0 });
    socket.emit('update-queue-status', {
      ffa: { isActive: true }, coop2: { isActive: true }, coop3: { isActive: true }, coop4: { isActive: true },
      lightning: { isActive: true }, ranked_ffa: { isActive: true }, ranked_coop2: { isActive: true },
      ranked_coop3: { isActive: true }, ranked_coop4: { isActive: true }
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
    const me = socket.userID;
    // Sent as the match-ready crossed it: the menu ignores that match.
    declineMatch(me, 'leave-mm');
    // A party queued together leaves together, whoever cancels: the others'
    // menus are told who did.
    const p = friends.party(me);
    if (!(p && partyQueued(p, me) && cancelPartyQueue(p, p.leader === me ? 'party-leader-cancelled' : 'party-member-cancelled',
      (usernameOf(me) || 'A party member') + ' cancelled the search.', me))) {
      lobbies.leave(me);
    }
    socket.emit('leave-mm-ack');
    setPresence(me, 'menu');
  });
  // The menu ignored a match-ready (the player had asked to leave).
  // Payload: { nonce: the match-ready's nonce, queueName } (nonce may be missing).
  on('match-declined', (msg) => {
    declineMatch(socket.userID, 'match-declined', msg && typeof msg === 'object' ? shortString(msg.nonce, 64, null) : null);
  });
  // Showdown: leave the series from the menu (the next round isn't played).
  on('showdown-leave', () => {
    const series = showdowns.leave(socket.userID);
    if (series) {
      if (showdowns.markRecorded(socket.userID)) recordShowdown(socket.userID, false, series.mode);
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
    } else if (socket.inventorySentAt && Date.now() - socket.inventorySentAt < INVENTORY_RESEND_MS) {
      metrics.error('socketDropped');      // this socket has the list: not again so soon
    } else {
      socket.inventorySentAt = Date.now();
      sendInventoryTypes(socket);
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
    const partyId = shortString(msg.partyId, 40, '');
    // A party searching can't change: join when its search is over (that
    // includes a leader still searching alone before anyone joined).
    const target = friends.parties.get(partyId);
    if (target && target.members.some((id) => lobbies.lobbyOf(id))) {
      return reply({ error: 'party-in-queue', message: 'That party is searching for a match: accept when its search is over.' });
    }
    const old = friends.party(me);
    const before = membersOf(old);
    // Out of whatever search this player was in (their old party's, or
    // their own) before they join.
    if (old && partyQueued(old, me)) {
      cancelPartyQueue(old, 'party-changed', (usernameOf(me) || 'A party member') + ' joined another party: the search was stopped.');
    } else if (lobbies.lobbyOf(me)) {
      lobbies.leave(me);
      setPresence(me, 'menu');
      socket.emit('leave-mm-group', { reason: 'joined-party', message: 'You joined a party: its leader queues for it.' });
    }
    const r = friends.acceptInvite(me, partyId);
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
    const was = friends.party(me);
    const before = membersOf(was);
    if (was && partyQueued(was, me)) {
      cancelPartyQueue(was, 'party-changed', (usernameOf(me) || 'A party member') + ' left the party: the search was stopped.');
    }
    const p = friends.leave(me);
    reply(p ? { ok: true } : { error: 'not-in-party' });
    for (const id of new Set([me].concat(before))) sendFriends(id);
  });
  // A player's card: yours, or anyone's by username (no such player: found false).
  friendAction('player-card', (me, msg, reply) => {
    if (!allowPlayerCard(me)) return reply({ error: 'slow-down' });
    const id = msg.username === undefined ? me : target(msg);
    socket.emit('remaster-player-card', id ? Object.assign({ found: true }, playerCard(id, me))
      : { found: false, username: typeof msg.username === 'string' ? msg.username.slice(0, 40) : null });
  });

  // The global leaderboard (Leaderboard.js): every board, with your own rows.
  on('remaster-leaderboard-get', () => {
    if (!allowLeaderboard(socket.userID)) return socket.emit('remaster-leaderboard', { error: 'slow-down' });
    socket.emit('remaster-leaderboard', leaderboard.view(usernameOf(socket.userID) ? socket.userID : null));
  });

  // CUSTOM (custommatch.js): a private lobby of one, played on the player's
  // PC with the map and the settings the CUSTOM screen picked. Nobody can join
  // one (there is no multiplayer hosting): the menu says to use a party.
  on('lobby-create', (msg) => {
    socket.lobby = custom.lobby(crypto.randomBytes(3).toString('hex'), socket.userID, lobbyCard(socket.userID),
      msg && msg.cullingcard, msg && msg.mapName);
    socket.emit('lobby-update', socket.lobby);
  });
  on('lobby-join', () => socket.emit('lobby-join-fail', { reason: custom.JOIN_REFUSED }));
  on('lobby-set-map', (msg) => {
    if (!socket.lobby) return socket.emit('lobby-update-fail', {});
    socket.lobby.mapName = custom.mapName(msg && msg.mapName, socket.lobby.mapName);
    socket.emit('lobby-update', socket.lobby);
  });
  // The CUSTOM MATCH SETTINGS screen: whole numbers within each setting's
  // bounds; anything else keeps the setting as it was. Acknowledged on its
  // own event (a lobby-update would reset the settings screen's focus).
  on('lobby-set-mods', (msg) => {
    if (!socket.lobby) return socket.emit('lobby-set-mods-fail', { reason: 'not-in-lobby' });
    socket.lobby.mods = custom.cleanMods(msg && msg.mods, socket.lobby.mods);
    socket.emit('lobby-set-mods-ack', { mods: socket.lobby.mods });
  });
  on('lobby-leave', () => { socket.lobby = null; socket.emit('lobby-leave-ack'); });
  on('lobby-start-match', () => {
    if (!socket.lobby) return socket.emit('lobby-start-match-fail', { reason: 'not-in-lobby' });
    // Out of any matchmaking lobby: its match-ready would land on top of this
    // one. A party queued together stops its search for everyone, with the
    // reason, as the other exits do (never a party sent on without a member).
    const me = socket.userID;
    const party = friends.party(me);
    if (!(party && partyQueued(party, me) && cancelPartyQueue(party,
      party.leader === me ? 'party-leader-cancelled' : 'party-member-cancelled',
      (usernameOf(me) || 'A party member') + ' started a custom match: the search was stopped.', me))) {
      lobbies.leave(me);
    }
    const map = custom.mapIndex(socket.lobby.mapName);
    const gameServer = custom.gameServer(socket.lobby.mapName, socket.lobby.mods);
    const nonce = crypto.randomBytes(8).toString('hex');
    tickets.start(socket.userID, socketIp(socket), { map: custom.MAP_KEYS[map], mode: 'custom', nonce });
    setPresence(socket.userID, 'match', { mode: 'custom' });
    log('match-ready ->', socket.userID, gameServer);
    socket.emit('match-ready', { gameServer, nonce,
      serverNonce: crypto.randomBytes(8).toString('hex') });
  });

  socket.on('disconnect', (reason) => {
    accessLog('socket disconnected', socket.userID || socket.id, reason);
    connectedSockets--;
    const left = (socketsByIp.get(socket.ip) || 1) - 1;
    if (left > 0) socketsByIp.set(socket.ip, left); else socketsByIp.delete(socket.ip);
    clearTimeout(socket.loginTimer);
    if (socket.userID && socketsByUser.get(socket.userID) === socket) {
      const me = socket.userID;
      // Gone mid-search: the party's search stops for everyone, with the
      // reason (never a party sent on without one of its members).
      const p = friends.party(me);
      if (!(p && partyQueued(p, me) && cancelPartyQueue(p, p.leader === me ? 'party-leader-disconnected' : 'party-member-disconnected',
        (usernameOf(me) || 'A party member') + ' disconnected: the search was stopped.', me))) {
        lobbies.leave(me);
      }
      socketsByUser.delete(socket.userID);
      if (usernameOf(socket.userID)) friends.seen(socket.userID);
      notifyFriends(socket.userID);
      // Offline with no match running: nothing to remember about them.
      if (!tickets.peek({ userID: socket.userID })) presence.delete(socket.userID);
      watchPartyOffline(me);
    }
  });
});

// A stand-in for players with no profile (looked up, never stored).
const BLANK_PROFILE = { stats: { wins: 0, kills: 0, level: 1, rank: 0 }, cardID: 0 };

// ---------------------------------------------------------------- backups

// A daily snapshot of the data folder (backup.js), in <data>/backups unless
// CULLING_BACKUP_DIR says otherwise; the newest CULLING_BACKUP_KEEP are kept.
// Everything held in memory is written first, so the snapshot is complete and
// consistent; that blocks the event loop briefly once a day (backups.last.ms
// in /metrics). CULLING_BACKUP_EVERY_MS=0 turns it off.
const BACKUP_DIR = process.env.CULLING_BACKUP_DIR || path.join(DATA_DIR, 'backups');
const BACKUP_EVERY_MS = parseInt(process.env.CULLING_BACKUP_EVERY_MS || String(24 * 3600 * 1000), 10);
const BACKUP_KEEP = parseInt(process.env.CULLING_BACKUP_KEEP || '14', 10);
let lastBackup = null;
function dailyBackup() {
  if (stopping || !(BACKUP_EVERY_MS > 0)) return;
  try {
    const newest = backups.latestAt(BACKUP_DIR, 'daily');
    if (newest !== null && Date.now() - newest < BACKUP_EVERY_MS) return;
    const t0 = performance.now();
    flushAll('backup');
    const r = backups.snapshot(DATA_DIR, BACKUP_DIR, 'daily', { keep: BACKUP_KEEP });
    const ms = Math.round(performance.now() - t0);
    lastBackup = { at: Date.now(), dir: r.dir, files: r.files, bytes: r.bytes, ms };
    log('backup', r.dir, r.files, 'files', (r.bytes / 1048576).toFixed(1) + ' MB', ms + ' ms',
      r.removed.length ? '(removed ' + r.removed.length + ' older)' : '');
  } catch (e) {
    metrics.error('backup');
    lastBackup = { at: Date.now(), error: e.message };
    log('backup failed:', e.message);
  }
}
if (BACKUP_EVERY_MS > 0) {
  const first = setTimeout(dailyBackup, parseInt(process.env.CULLING_BACKUP_FIRST_MS || '60000', 10));
  const every = setInterval(dailyBackup, Math.min(BACKUP_EVERY_MS, 3600 * 1000));
  if (first.unref) first.unref();
  if (every.unref) every.unref();
}

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
  const port = server.address().port;
  if (!process.env.CULLING_PUBLIC_URL) BASE = `http://${HOST}:${port}`;
  if (process.env.CULLING_PORT_FILE) {
    const file = process.env.CULLING_PORT_FILE;
    fs.writeFileSync(file + '.tmp', String(port));
    fs.renameSync(file + '.tmp', file);
  }
  log(`The Culling local server listening on ${BASE}  (ClientWeb root: ${BASE}/api)`);
});
