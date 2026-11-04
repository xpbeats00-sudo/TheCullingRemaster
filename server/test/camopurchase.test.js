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

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { CULLING_PORT: String(PORT), CULLING_DATA_DIR: dir }), stdio: 'ignore' });
  const socket = ioClient('http://127.0.0.1:' + PORT, { transports: ['websocket'], forceNew: true });
  try {
    await waitUp();
    await next(socket, 'login_ready');
    socket.emit('login', { userID: USER });
    await next(socket, 'auth-response');

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
    console.log('all camo purchase tests passed');
  } finally {
    socket.close();
    server.kill();
  }
})().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; });
