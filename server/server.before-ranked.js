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
const BASE = `http://${HOST}:${PORT}`;
const DATA_DIR = path.join(__dirname, 'data');
const PROFILE_FILE = path.join(DATA_DIR, 'profiles.json');

// Queue name -> offline map index understood by the game's StartOfflineMatch
// (0 = Jungle / "The Island", 1 = Prison).
const QUEUE_MAPS = { ffa: 0, coop2: 0, lightning: 0 };

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

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
const catalogByTid = new Map(catalog.map((i) => [i.tid, i]));

// Short keys are what the game's native parser reads for each type.
function inventoryTypes() {
  return catalog.map((i) => ({
    tid: i.tid,
    tn: i.displayName,
    pc: Math.round(i.purchaseCost),
    ais: isCustom(i),
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

function ownedItems(p) {
  const bought = new Set(p.owned || []);
  return catalog.filter((i) => !NOT_OWNABLE.has(i.class) && (!isCustom(i) || bought.has(i.tid)))
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
let profiles = {};
try { profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')); } catch (e) { profiles = {}; }

function saveProfiles() {
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profiles, null, 2));
}

function getProfile(userID) {
  if (!profiles[userID]) {
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

// token -> userID
const tokens = new Map();
// Most recent login; local bot-match results are credited to this player.
let lastUserID = null;

function userFromRequest(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && tokens.has(m[1])) return tokens.get(m[1]);
  return null;
}

function normalizeUserID(raw) {
  let id = String(raw || '').trim();
  if (!id) id = 'steam:76561198000000000';
  if (!id.includes(':')) id = 'steam:' + id;
  return id;
}

// ---------------------------------------------------------------- HTTP

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.text({ type: '*/*', limit: '1mb' }));

app.use((req, res, next) => {
  log('HTTP', req.method, req.originalUrl);
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
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, userID);
  lastUserID = userID;
  getProfile(userID);
  log('login', userID, 'authType=' + body.authType, 'appid=' + body.appid, 'build=' + body.build);
  res.json({ token, redirect: `${BASE}/api`, userID, build: body.build || '0' });
});

app.post('/api/matchqueue', (req, res) => {
  const body = bodyObject(req);
  const userID = normalizeUserID(body.userid);
  const queue = body.queuename || 'ffa';
  log('matchqueue', userID, queue);
  res.json({ status: 'ok', queueName: queue });
  const socket = socketsByUser.get(userID);
  if (socket) startLocalMatch(socket, queue);
  else log('  no socket for', userID, '- known:', [...socketsByUser.keys()].join(', '));
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

// Posted by the in-match HUD (patched hud.js) when you die or win.
app.post('/api/matchresult', (req, res) => {
  const body = bodyObject(req);
  const userID = lastUserID || normalizeUserID();
  const p = getProfile(userID);
  const r = {
    victory: body.victory === true || body.victory === 'true',
    kills: Math.max(0, parseInt(body.kills, 10) || 0),
    damage: Math.max(0, Number(body.damage) || 0),
    timeAlive: Math.max(0, Number(body.timeAlive) || 0),
    func: Math.max(0, parseInt(body.func, 10) || 0)
  };
  const startXP = p.stats.xp;
  const earned = matchXP(r);
  const credits = matchCredits(r);
  p.cullCredits += credits;
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
  res.json({ startXP, xpEarned: earned, stats: s });
});

// The HUD asks the game for the level matching the new XP and reports it back.
app.post('/api/setlevel', (req, res) => {
  const level = parseInt(bodyObject(req).level, 10);
  const userID = lastUserID || normalizeUserID();
  if (level > 0) {
    const p = getProfile(userID);
    if (level !== p.stats.level) log('level', userID, p.stats.level, '->', level);
    p.stats.level = level;
    saveProfiles();
  }
  res.json({ ok: true });
});

// The menu reports the game's XP curve (XP at the top of each level).
app.post('/api/levelcurve', (req, res) => {
  const high = (bodyObject(req).high || []).map(Number).filter((n) => Number.isFinite(n));
  // Keep the strictly increasing prefix; past the max level the game repeats or returns 0.
  const curve = [];
  for (const n of high) {
    if (n > 0 && (!curve.length || n > curve[curve.length - 1])) curve.push(n);
    else break;
  }
  if (curve.length && JSON.stringify(curve) !== JSON.stringify(levelXPHigh)) {
    levelXPHigh = curve;
    fs.writeFileSync(LEVELS_FILE, JSON.stringify(curve));
    log('level curve', curve.length, 'levels; level 2 at', curve[0] + 1, 'XP; max at', curve[curve.length - 1]);
    for (const p of Object.values(profiles)) p.stats.level = levelForXP(p.stats.xp) || p.stats.level;
    saveProfiles();
  }
  res.json({ ok: true, levels: curve.length });
});

app.get('/api/news', (req, res) => res.json({ news: [] }));

app.get('/health', (req, res) => res.json({ ok: true, users: socketsByUser.size }));

app.use((req, res) => {
  log('  (unhandled HTTP route)', req.method, req.originalUrl, JSON.stringify(bodyObject(req)).slice(0, 300));
  res.json({});
});

// ---------------------------------------------------------------- socket.io

const server = http.createServer(app);
const io = socketio(server, { pingInterval: 10000, pingTimeout: 30000, cookie: false });
const socketsByUser = new Map();

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

function startLocalMatch(socket, queue) {
  const mapIndex = QUEUE_MAPS[queue] !== undefined ? QUEUE_MAPS[queue] : 0;
  socket.emit('join-mm-ack');
  socket.emit('players-in-queue', { count: 1 });
  setTimeout(() => {
    log('match-ready ->', socket.userID, 'offline map', mapIndex);
    socket.emit('match-ready', {
      gameServer: 'offline:' + mapIndex,
      nonce: crypto.randomBytes(8).toString('hex'),
      serverNonce: crypto.randomBytes(8).toString('hex')
    });
  }, 1500);
}

io.on('connection', (socket) => {
  log('socket connected', socket.id);
  socket.emit('login_ready');

  socket.use((packet, next) => {
    const [name, payload] = packet;
    if (name !== 'login') log('  <-', name, payload === undefined ? '' : JSON.stringify(payload).slice(0, 300));
    next();
  });

  socket.on('login', (msg) => {
    let userID = null;
    if (msg && typeof msg === 'object') userID = msg.userID || tokens.get(msg.token);
    else if (typeof msg === 'string') userID = tokens.get(msg);
    userID = normalizeUserID(userID);
    socket.userID = userID;
    lastUserID = userID;
    socketsByUser.set(userID, socket);
    const p = getProfile(userID);
    log('socket login', userID);

    socket.emit('auth-response');
    sendPlayer(socket, p);
    socket.emit('update-premium-currency', String(p.premiumCurrency));
    socket.emit('player-online-response', { data: socketsByUser.size });
    socket.emit('player-counts', { online: socketsByUser.size, inQueue: 0 });
    socket.emit('update-queue-status', {
      ffa: { isActive: true }, coop2: { isActive: true }, lightning: { isActive: true }
    }, Date.now());
    socket.emit('update-average-queue-time', 2000);
    setTimeout(sendEntitlements, 2000);
  });

  socket.on('join-mm', (msg) => startLocalMatch(socket, (msg && msg.queueName) || 'ffa'));
  socket.on('leave-mm', () => socket.emit('leave-mm-ack'));
  socket.on('leave-group', () => socket.emit('left-group', 0));

  socket.on('set-card', (msg) => {
    if (!socket.userID) return;
    getProfile(socket.userID).cardID = (msg && msg.cardID) || 0;
    saveProfiles();
  });
  socket.on('get-cards', (msg) => {
    const users = (msg && msg.users) || [];
    socket.emit('get-cards-result', {
      cards: users.map((u) => {
        const p = profiles[u];
        return { userID: u, cardID: p ? p.cardID : 0, cardLevel: p ? p.stats.level : 1, cardRank: p ? p.stats.rank : 0 };
      })
    });
  });

  // Inventory / cosmetics: the item catalog and the player's owned items.
  // The game only asks for owned items now and then, so push them whenever
  // the catalog has (re)loaded as well.
  const sendEntitlements = () => socket.emit('entitlements-response',
    { data: { items: ownedItems(getProfile(socket.userID || normalizeUserID())) } });
  socket.on('get-entitlements', sendEntitlements);
  socket.on('get-inventory-types', (version) => {
    if (version === CATALOG_VERSION) {
      socket.emit('inventory-types-response', { data: { versionOK: true, currentVersion: CATALOG_VERSION } });
    } else {
      socket.emit('inventory-types-response', { data: { versionOK: false, currentVersion: CATALOG_VERSION, types: inventoryTypes() } });
    }
    setTimeout(sendEntitlements, 1000);
  });
  // Custom content costs cull credits; anything else is already owned.
  socket.on('purchase-entitlement', (msg) => {
    const typeId = parseInt(msg && msg.entitlementID, 10);
    const item = catalogByTid.get(typeId);
    const p = getProfile(socket.userID || normalizeUserID());
    if (item && isCustom(item) && !p.owned.includes(typeId)) {
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
  socket.on('get-premium-types', () => {
    socket.emit('premium-types-response', { data: { versionOK: false, currentVersion: 'local-1', types: [] } });
  });
  socket.on('check-dlc-items', () => socket.emit('check-dlc-items-success'));
  socket.on('redeem-tokens', () => {});
  socket.on('start-item-migration', () => socket.emit('item-migration', { data: {} }));
  socket.on('open-crate', () => socket.emit('open-crate-fail', { reason: 'no-crates' }));
  socket.on('premium-purchase', () => socket.emit('premium-purchase-fail', { message: 'The store is not available on the local server.' }));
  socket.on('purchase-item', () => socket.emit('purchase-item-fail', { message: 'The store is not available on the local server.' }));
  socket.on('purchase-item-authenticated', () => socket.emit('purchase-item-authenticated-fail', { message: 'The store is not available on the local server.' }));

  socket.on('player-leaderboard-request', () => {
    const p = getProfile(socket.userID || normalizeUserID());
    socket.emit('player-leaderboard-response', { data: emptyLeaderboard(p) });
  });
  socket.on('get-season-summary', (msg) => {
    const userID = (msg && msg.userID) || socket.userID;
    const p = getProfile(normalizeUserID(userID));
    socket.emit('season-summary-response', { userID, data: JSON.stringify(emptyLeaderboard(p).solo) });
  });
  socket.on('get-friends', () => socket.emit('get-friends-ack', []));
  socket.on('group-invite', () => socket.emit('group-invite-fail', { reason: 'target-offline' }));

  // Private ("custom") lobbies also go straight to a local bot match.
  socket.on('lobby-create', (msg) => {
    socket.lobby = {
      code: crypto.randomBytes(3).toString('hex'),
      owner: socket.userID,
      mapName: (msg && msg.mapName) || 'Jungle_P',
      members: [{ user: socket.userID, team: 0 }]
    };
    socket.emit('lobby-update', socket.lobby);
  });
  socket.on('lobby-join', () => socket.emit('lobby-join-fail', { reason: 'not-found' }));
  socket.on('lobby-set-map', (msg) => {
    if (!socket.lobby) return socket.emit('lobby-update-fail', {});
    socket.lobby.mapName = (msg && msg.mapName) || socket.lobby.mapName;
    socket.emit('lobby-update', socket.lobby);
  });
  socket.on('lobby-leave', () => { socket.lobby = null; socket.emit('lobby-leave-ack'); });
  socket.on('lobby-start-match', () => {
    const map = socket.lobby && /prison|jungle2/i.test(socket.lobby.mapName) ? 1 : 0;
    socket.emit('match-ready', { gameServer: 'offline:' + map, nonce: 'x', serverNonce: 'x' });
  });

  socket.on('disconnect', (reason) => {
    log('socket disconnected', socket.userID || socket.id, reason);
    if (socket.userID && socketsByUser.get(socket.userID) === socket) socketsByUser.delete(socket.userID);
  });
});

server.listen(PORT, HOST, () => {
  log(`The Culling local server listening on ${BASE}  (ClientWeb root: ${BASE}/api)`);
});
