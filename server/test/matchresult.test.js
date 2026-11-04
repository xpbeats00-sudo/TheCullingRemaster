// Match results can't corrupt a profile: a malformed report (Infinity, NaN,
// negative or absurd numbers) is bounded before credits and XP are awarded.
// Runs a throwaway server on its own port and data folder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 8123;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'culling-test-'));
fs.copyFileSync(path.join(__dirname, '..', 'data', 'catalog.json'), path.join(dir, 'catalog.json'));

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method,
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { await request('GET', '/health'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { CULLING_PORT: String(PORT), CULLING_DATA_DIR: dir }),
    stdio: 'ignore'
  });
  try {
    await waitUp();
    // Raw JSON: 1e999 parses to Infinity.
    await request('POST', '/api/matchresult',
      '{"victory":false,"kills":-5,"damage":1e999,"timeAlive":"NaN","func":99999999999,"placement":3}');
    const profiles = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
    const p = Object.values(profiles)[0];
    assert.ok(p, 'profile created');
    assert.ok(Number.isFinite(p.cullCredits), 'credits finite: ' + p.cullCredits);
    assert.ok(Number.isFinite(p.stats.xp), 'xp finite: ' + p.stats.xp);
    assert.strictEqual(p.stats.kills, 0, 'negative kills clamped to 0');
    assert.strictEqual(p.stats.totalDamage, 0, 'non-finite damage counts as none');
    assert.ok(p.stats.funcEarned <= 1e6, 'func capped');
    // 10000 start + 100 base: nothing else counts
    assert.strictEqual(p.cullCredits, 10000 + 100);
    console.log('ok    malformed match result is bounded');

    await request('POST', '/api/matchresult', '{"victory":true,"kills":3,"damage":400,"timeAlive":600,"func":20}');
    const q = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8')))[0];
    assert.strictEqual(q.cullCredits - p.cullCredits, 100 + 75 + 20 + 20 + 400);
    console.log('ok    normal match result pays the documented formula');
    console.log('all matchresult tests passed');
  } finally {
    server.kill();
  }
})().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; });
