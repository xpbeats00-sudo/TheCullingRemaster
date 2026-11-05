// Custom camos are a one-time purchase: buying one weapon's skin unlocks that
// camo on every weapon, is charged once, and owning any weapon's skin of a camo
// (profiles from before this rule) counts as owning the camo.
// Runs a throwaway server on its own port and data folder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const ioClient = require('socket.io-client');

const PORT = 8124;
const USER = 'steam:test-camo-buyer';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'culling-test-'));
fs.copyFileSync(path.join(__dirname, '..', 'data', 'catalog.json'), path.join(dir, 'catalog.json'));
const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
const skins = catalog.filter((i) => i.source === 'xp-camos');
const camo = (name) => skins.filter((i) => i.asset.endsWith('_XP_' + name));

function waitUp() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, () => resolve())
      .on('error', () => (++n > 100 ? reject(new Error('server did not start')) : setTimeout(tick, 100)));
    tick();
  });
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function next(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function owned(socket) {
  const reply = next(socket, 'entitlements-response');
  socket.emit('get-entitlements');
  return new Set((await reply).data.items.map((x) => x.i));
}

async function buy(socket, tid) {
  const reply = Promise.race([next(socket, 'purchase-success').then(() => 'ok'), next(socket, 'purchase-fail').then(() => 'fail')]);
  socket.emit('purchase-entitlement', { entitlementID: String(tid) });
  return reply;
}

function credits() {
  return JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'))[USER].cullCredits;
}

(async () => {
  // A profile from before the rule: owns Lava Storm on the Ice Axe only.
  const lava = camo('Lava_Storm');
  const iceLava = lava.find((i) => i.asset.includes('/IceAxe_XP_'));
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ [USER]: {
    userID: USER, cullCredits: 10000, premiumCurrency: 0, owned: [iceLava.tid], economy: 1, cardID: 0,
    stats: { xp: 0, level: 1, gamesPlayed: 0, kills: 0, wins: 0, totalDamage: 0, minutesAlive: 0, funcEarned: 0 } } }));

  const start = () => spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { CULLING_PORT: String(PORT), CULLING_DATA_DIR: dir, CULLING_SAVE_DELAY_MS: '0',
      CULLING_REQUIRE_ACCOUNT: '0' }), stdio: 'ignore' });
  const connect = async () => {
    const s = ioClient('http://127.0.0.1:' + PORT, { transports: ['websocket'], forceNew: true });
    await waitUp();
    await next(s, 'login_ready');
    const login = await request('POST', '/api/login', { userid: USER });
    s.emit('login', { token: login.token });
    await next(s, 'auth-response');
    return s;
  };
  let server = start();
  let socket = null;
  try {
    socket = await connect();

    let have = await owned(socket);
    assert.ok(lava.length > 30, 'Lava Storm exists on every weapon');
    assert.ok(lava.every((i) => have.has(i.tid)), 'one owned Lava Storm skin owns it on every weapon');
    console.log('ok    an old single-weapon purchase unlocks the camo everywhere (%d skins)', lava.length);

    const before = credits();
    assert.strictEqual(await buy(socket, lava[5].tid), 'ok');
    assert.strictEqual(credits(), before, 'an owned camo is not charged again');
    console.log('ok    buying an owned camo on another weapon is free');

    const acid = camo('Acid_Splash');
    assert.ok(acid.every((i) => !have.has(i.tid)), 'Acid Splash not owned yet');
    assert.strictEqual(await buy(socket, acid[0].tid), 'ok');
    assert.strictEqual(credits(), before - acid[0].purchaseCost, 'charged once, the camo price');
    have = await owned(socket);
    assert.ok(acid.every((i) => have.has(i.tid)), 'bought camo owned on every weapon');
    assert.strictEqual(await buy(socket, acid[7].tid), 'ok');
    assert.strictEqual(credits(), before - acid[0].purchaseCost, 'second weapon not charged');
    console.log('ok    a new camo is charged once (%d) and unlocks %d skins', acid[0].purchaseCost, acid.length);

    const other = camo('Amethyst');
    assert.ok(other.every((i) => !have.has(i.tid)), 'other camos stay locked');
    console.log('ok    other camos stay locked');

    // VFX camos (patch/make_vfx_camos.py) follow the same rule.
    const dark = catalog.filter((i) => i.source === 'xp-vfx-camos' && i.asset.endsWith('_XP_VFX_Dark_Matter'));
    assert.ok(dark.length >= 2, 'Dark Matter exists on several weapons');
    assert.ok(dark.every((i) => !have.has(i.tid)), 'Dark Matter not owned yet');
    const before2 = credits();
    assert.strictEqual(await buy(socket, dark[0].tid), 'ok');
    assert.strictEqual(credits(), before2 - dark[0].purchaseCost, 'VFX camo charged once');
    have = await owned(socket);
    assert.ok(dark.every((i) => have.has(i.tid)), 'VFX camo owned on every weapon that has it');
    const popper = catalog.filter((i) => i.source === 'xp-vfx-camos' && i.asset.endsWith('_XP_VFX_Dark_Matter_Popper'));
    assert.ok(popper.every((i) => !have.has(i.tid)), 'Dark Matter Popper is its own camo');
    console.log('ok    a VFX camo is charged once and unlocks %d skins', dark.length);

    // Persistence: a restarted server still has the purchase (profiles.json).
    const spent = credits();
    socket.close();
    server.kill();
    await new Promise((r) => server.once('exit', r));
    server = start();
    socket = await connect();
    have = await owned(socket);
    assert.ok(dark.every((i) => have.has(i.tid)), 'VFX camo still owned after a restart');
    assert.ok(acid.every((i) => have.has(i.tid)), 'camo still owned after a restart');
    assert.strictEqual(credits(), spent, 'balance kept after a restart');
    console.log('ok    purchases and balance survive a server restart');
    console.log('all camo purchase tests passed');
  } finally {
    if (socket) socket.close();
    server.kill();
  }
})().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; });
