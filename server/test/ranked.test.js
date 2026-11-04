// Ranked rating tests (design doc section 14). Run: node test/ranked.test.js
const assert = require('assert');
const R = require('../ranked');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ', name); } catch (e) { failures++; console.log('FAIL ', name, '\n     ', e.message); }
}
const profile = () => ({});

test('tiers follow the ELO ranges', () => {
  assert.strictEqual(R.tierFor(0).name, 'Scrapper');
  assert.strictEqual(R.tierFor(799).name, 'Scrapper');
  assert.strictEqual(R.tierFor(800).name, 'Contender');
  assert.strictEqual(R.tierFor(1000).name, 'Blooded');
  assert.strictEqual(R.tierFor(1399).name, 'Hunter');
  assert.strictEqual(R.tierFor(2199).name, 'Apex');
  assert.strictEqual(R.tierFor(2200).name, 'Legend');
  assert.strictEqual(R.tierFor(5000).next, null);
});

test('expected score is symmetric', () => {
  assert.ok(Math.abs(R.expected(1000, 1000) - 0.5) < 1e-9);
  assert.ok(Math.abs(R.expected(1200, 1000) + R.expected(1000, 1200) - 1) < 1e-9);
});

test('a new player completes five placements at K 48', () => {
  const p = profile();
  for (let i = 0; i < 5; i++) {
    R.startMatch(p);
    const { entry } = R.finishMatch(p, { placement: 20 });
    assert.strictEqual(entry.k, 48);
  }
  R.startMatch(p);
  assert.strictEqual(R.finishMatch(p, { placement: 20 }).entry.k, 32);
  assert.strictEqual(R.summary(p).placement, null);
});

test('winning raises the rating, last place lowers it', () => {
  const a = profile(); R.startMatch(a);
  assert.ok(R.finishMatch(a, { placement: 1 }).entry.delta > 0);
  const b = profile(); R.startMatch(b);
  assert.ok(R.finishMatch(b, { placement: 51 }).entry.delta < 0);
});

test('better placement never gives less rating', () => {
  const order = R.opponentsFor('fixed', 1000);
  let last = Infinity;
  for (let place = 1; place <= 51; place++) {
    const d = R.ratingChange(1000, place, order, 32);
    assert.ok(d <= last + 1e-9, 'placement ' + place);
    last = d;
  }
});

test('one match moves at most K', () => {
  const order = R.opponentsFor('m', 1000);
  assert.ok(Math.abs(R.ratingChange(1000, 1, order, 32)) <= 32);
  assert.ok(Math.abs(R.ratingChange(1000, 51, order, 32)) <= 32);
});

test('beating stronger opponents is worth more', () => {
  const weak = R.opponentsFor('x', 800), strong = R.opponentsFor('x', 1400);
  assert.ok(R.ratingChange(1000, 1, strong, 32) > R.ratingChange(1000, 1, weak, 32));
  // Losing to weaker opponents costs more.
  assert.ok(R.ratingChange(1000, 51, weak, 32) < R.ratingChange(1000, 51, strong, 32));
});

test('a match result cannot be processed twice', () => {
  const p = profile();
  const { match } = R.startMatch(p);
  const first = R.finishMatch(p, { matchId: match.id, placement: 3 });
  const rating = p.ranked.rating;
  const again = R.finishMatch(p, { matchId: match.id, placement: 1 });
  assert.ok(again.duplicate);
  assert.strictEqual(again.entry, first.entry);
  assert.strictEqual(p.ranked.rating, rating);
  assert.strictEqual(R.finishMatch(p, { placement: 1 }).error, 'no-ranked-match');
});

test('invalid match data is rejected safely', () => {
  const p = profile(); R.startMatch(p);
  const before = JSON.stringify(p.ranked);
  for (const placement of [0, -1, 52, 2.5, 'abc', null]) {
    assert.strictEqual(R.finishMatch(p, { placement }).error, 'invalid-placement');
  }
  assert.strictEqual(R.finishMatch(p, { matchId: 'rk-other', placement: 1 }).error, 'unknown-match');
  assert.strictEqual(JSON.stringify(p.ranked), before);
});

test('an abandoned match counts as last place', () => {
  const p = profile();
  R.startMatch(p);
  const { abandoned } = R.startMatch(p);
  assert.ok(abandoned && abandoned.abandoned);
  assert.strictEqual(abandoned.placement, 51);
  assert.ok(abandoned.delta < 0);
});

test('results are reproducible from the match ID', () => {
  assert.deepStrictEqual(R.opponentsFor('rk-1', 1000), R.opponentsFor('rk-1', 1000));
});

test('promotion, demotion and one-time rewards', () => {
  const p = profile(); const granted = [];
  const grant = (tier) => { granted.push(tier); return [tier]; };
  for (let i = 0; i < 40; i++) { R.startMatch(p, Date.now(), grant); R.finishMatch(p, { placement: 1 }, Date.now(), grant); }
  const high = p.ranked.rating;
  assert.ok(R.tierFor(high).index >= 3, 'climbs past Hunter, at ' + high);
  for (let i = 0; i < 40; i++) { R.startMatch(p, Date.now(), grant); R.finishMatch(p, { placement: 51 }, Date.now(), grant); }
  assert.ok(p.ranked.rating < high, 'demotes');
  assert.strictEqual(new Set(granted).size, granted.length, 'each reward once');
  assert.strictEqual(p.ranked.peakRating, high);
});

test('history matches the displayed rating', () => {
  const p = profile();
  for (let i = 0; i < 8; i++) { R.startMatch(p); R.finishMatch(p, { placement: 1 + (i * 7) % 51 }); }
  const h = p.ranked.history;
  assert.strictEqual(h[0].ratingAfter, p.ranked.rating);
  for (let i = 0; i < h.length - 1; i++) assert.strictEqual(h[i].ratingBefore, h[i + 1].ratingAfter);
});

test('simulation: skill levels separate', () => {
  // Players who consistently place in the top 3 / mid / bottom drift apart.
  const run = (place) => { const p = profile(); for (let i = 0; i < 60; i++) { R.startMatch(p); R.finishMatch(p, { placement: place }); } return p.ranked.rating; };
  const top = run(2), mid = run(26), bottom = run(48);
  console.log('      simulated ratings after 60 matches: top', top, 'mid', mid, 'bottom', bottom);
  assert.ok(top > mid && mid > bottom);
});

if (failures) { console.log(failures + ' failing'); process.exit(1); }
console.log('all ranked tests passed');
