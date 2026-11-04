// Last Breath rules core: the logic-level acceptance criteria from
// Showdown/Showdown_mode.md section 16 (runtime/in-game criteria can't be
// tested here).
const assert = require('assert');
const LB = require('../lastbreath');

const cfg = LB.loadConfig();
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok    ' + name); }

test('config matches the spec defaults', () => {
  assert.strictEqual(cfg.roundsToWin, 4);
  assert.strictEqual(cfg.maxRounds, 7);
  assert.deepStrictEqual(cfg.teamSizes, [1, 2, 3, 4]);
  assert.deepStrictEqual(cfg.phases.map((p) => p.duration), [120, 30, 30, 30, 30]);
  assert.deepStrictEqual(cfg.phases.map((p) => p.dps), [0, 5, 10, 20, 35]);
  assert.strictEqual(cfg.respawns, false);
});

test('config rejects bad values', () => {
  assert.throws(() => LB.loadConfig('[LastBreath]\nRoundsToWin=x\n'));
});

test('gas inactive for the first 120 s', () => {
  for (let t = 0; t < 120; t += 0.5) {
    const z = LB.zoneAt(cfg, t, 5000);
    assert.strictEqual(z.radius, 5000);
    assert.strictEqual(LB.gasDamage(cfg, t, 5000, 99999), 0);
  }
});

test('zone shrinks smoothly and monotonically through the phases', () => {
  let last = Infinity;
  const names = [];
  for (let t = 0; t <= 260; t += 0.25) {
    const z = LB.zoneAt(cfg, t, 5000);
    assert.ok(z.radius <= last + 1e-9, 'radius grew at ' + t);
    assert.ok(last === Infinity || last - z.radius < 5000 * 0.3 * 0.25 / 30 + 1e-6, 'jump at ' + t);
    last = z.radius;
    if (names[names.length - 1] !== z.phase) names.push(z.phase);
  }
  assert.deepStrictEqual(names, ['FullSafe', 'InitialCollapse', 'AcceleratedCollapse', 'CriticalCollapse', 'FinalCollapse']);
  assert.strictEqual(LB.zoneAt(cfg, 240, 5000).radius, 0);
  assert.strictEqual(LB.zoneAt(cfg, 999, 5000).radius, 0);
});

test('damage per tick follows the phase curve and the boundary tolerance', () => {
  assert.strictEqual(LB.gasDamage(cfg, 130, 5000, 99999), 5 * cfg.tick);
  assert.strictEqual(LB.gasDamage(cfg, 160, 5000, 99999), 10 * cfg.tick);
  assert.strictEqual(LB.gasDamage(cfg, 190, 5000, 99999), 20 * cfg.tick);
  assert.strictEqual(LB.gasDamage(cfg, 300, 5000, 99999), 35 * cfg.tick);
  const r = LB.zoneAt(cfg, 135, 5000).radius;
  assert.strictEqual(LB.gasDamage(cfg, 135, 5000, r + cfg.tolerance), 0, 'on the tolerance edge is safe');
  assert.ok(LB.gasDamage(cfg, 135, 5000, r + cfg.tolerance + 1) > 0);
});

test('final gas kills a 100 hp player at the centre within 3 s', () => {
  // Healing isn't modelled here: in-game healing rates must be checked
  // against 35 hp/s (spec section 5).
  let hp = 100, t = 240;
  while (hp > 0 && t < 300) { hp -= LB.gasDamage(cfg, t, 5000, 1); t += cfg.tick; }
  assert.ok(hp <= 0 && t - 240 <= 3);
});

test('all four team sizes start; bad teams are refused', () => {
  for (const n of [1, 2, 3, 4]) {
    const a = Array.from({ length: n }, (_, i) => 'a' + i), b = Array.from({ length: n }, (_, i) => 'b' + i);
    const m = LB.createMatch(cfg, n, a, b);
    LB.startRound(m);
    assert.strictEqual(m.state, 'RoundActive');
  }
  assert.throws(() => LB.createMatch(cfg, 5, ['a'], ['b']));
  assert.throws(() => LB.createMatch(cfg, 2, ['a'], ['b', 'c']));
  assert.throws(() => LB.createMatch(cfg, 1, ['a'], ['a']));
});

test('eliminations and round wins count exactly once', () => {
  const m = LB.createMatch(cfg, 2, ['a1', 'a2'], ['b1', 'b2']);
  LB.startRound(m);
  assert.strictEqual(LB.applyEliminations(m, ['b1', 'b1']), null);
  assert.strictEqual(LB.applyEliminations(m, ['b1']), null);
  const r = LB.applyEliminations(m, ['b2', 'b2']);
  assert.strictEqual(r.winner, 'A');
  assert.deepStrictEqual(m.score, { A: 1, B: 0 });
  assert.strictEqual(LB.applyEliminations(m, ['b2', 'a1']), null, 'events after resolution are ignored');
  assert.deepStrictEqual(m.score, { A: 1, B: 0 });
});

test('both teams eliminated in one update is a drawn round', () => {
  const m = LB.createMatch(cfg, 1, ['a'], ['b']);
  LB.startRound(m);
  const r = LB.applyEliminations(m, ['a', 'b']);
  assert.strictEqual(r.winner, 'draw');
  assert.deepStrictEqual(m.score, { A: 0, B: 0 });
});

test('best of seven: first to four wins; seven rounds max', () => {
  const m = LB.createMatch(cfg, 1, ['a'], ['b']);
  const seq = ['a', 'b', 'a', 'b', 'a', 'b', 'b'];   // losers: A takes round 7 for 4-3
  for (const loser of seq) { LB.startRound(m); LB.applyEliminations(m, [loser]); }
  assert.strictEqual(m.state, 'MatchResolution');
  assert.strictEqual(m.winner, 'A');
  assert.deepStrictEqual(m.score, { A: 4, B: 3 });
  assert.throws(() => LB.startRound(m));

  const sweep = LB.createMatch(cfg, 1, ['a'], ['b']);
  for (let i = 0; i < 4; i++) { LB.startRound(sweep); LB.applyEliminations(sweep, ['b']); }
  assert.strictEqual(sweep.state, 'MatchResolution');
  assert.strictEqual(sweep.rounds.length, 4);

  const draws = LB.createMatch(cfg, 1, ['a'], ['b']);
  for (let i = 0; i < 7; i++) { LB.startRound(draws); LB.applyEliminations(draws, ['a', 'b']); }
  assert.strictEqual(draws.state, 'MatchResolution');
  assert.strictEqual(draws.winner, 'draw');
});

test('a disconnect counts as an elimination', () => {
  const m = LB.createMatch(cfg, 1, ['a'], ['b']);
  LB.startRound(m);
  assert.strictEqual(LB.disconnect(m, 'b').winner, 'A');
});

console.log('all %d lastbreath tests passed', passed);
