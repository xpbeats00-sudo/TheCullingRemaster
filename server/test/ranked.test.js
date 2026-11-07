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
    const { entry } = R.finishMatch(p, { placement: 10 });
    assert.strictEqual(entry.k, 48);
  }
  R.startMatch(p);
  assert.strictEqual(R.finishMatch(p, { placement: 10 }).entry.k, 32);
  assert.strictEqual(R.summary(p).placement, null);
});

test('winning raises the rating, last place lowers it', () => {
  const a = profile(); R.startMatch(a);
  assert.ok(R.finishMatch(a, { placement: 1 }).entry.delta > 0);
  const b = profile(); R.startMatch(b);
  assert.ok(R.finishMatch(b, { placement: 16 }).entry.delta < 0);
});

test('better placement never gives less rating', () => {
  const order = R.opponentsFor('fixed', 1000);
  let last = Infinity;
  for (let place = 1; place <= 16; place++) {
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
  assert.strictEqual(abandoned.placement, 16);
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
  const top = run(2), mid = run(8), bottom = run(15);
  console.log('      simulated ratings after 60 matches: top', top, 'mid', mid, 'bottom', bottom);
  assert.ok(top > mid && mid > bottom);
});

test("bots are never rated above T4 (Hunter): the season just started", () => {
  for (const mmr of [500, 1000, 1300, 1800, 2400]) {
    const bots = R.opponentsFor("m-cap-" + mmr, mmr);
    assert.ok(bots.every((r) => r <= 1399), "mmr " + mmr + ": max bot " + Math.max(...bots));
  }
  assert.ok(Math.max(...R.opponentsFor("m-cap-low", 1000)) > 1000, "below the cap the spread is unchanged");
});

test('a match is scored as the real 16 contestants: finishing last never climbs', () => {
  assert.strictEqual(R.CONFIG.field, 16);
  const p = profile();
  for (let i = 0; i < 120; i++) { R.startMatch(p); R.finishMatch(p, { placement: 16 }); }
  assert.ok(p.ranked.rating < R.CONFIG.startRating, 'always last: ' + p.ranked.rating);
  R.startMatch(p);
  assert.strictEqual(R.finishMatch(p, { placement: 17 }).error, 'invalid-placement', 'no 17th place in a 16-player match');
});

test('season cap: players stay at or below 1399 and no tier above Hunter is reached', () => {
  const p = profile();
  const rewards = [];
  for (let i = 0; i < 300; i++) { R.startMatch(p, Date.now(), (tier) => { rewards.push(tier); return []; }); R.finishMatch(p, { placement: 1 }, Date.now(), (tier) => { rewards.push(tier); return []; }); }
  assert.ok(p.ranked.rating <= 1399 && p.ranked.mmr <= 1399 && p.ranked.peakRating <= 1399, 'rating ' + p.ranked.rating);
  assert.strictEqual(R.tierFor(p.ranked.rating).name, 'Hunter');
  assert.ok(!['Executioner', 'Reaper', 'Warlord', 'Apex', 'Legend'].some((t) => p.ranked.tiersReached[t] || rewards.includes(t)), 'tiers: ' + Object.keys(p.ranked.tiersReached));
});

test('profiles from before the cap are brought within it', () => {
  const p = profile();
  R.ensure(p);
  Object.assign(p.ranked, { rating: 1900, mmr: 2100, peakRating: 2050, peakTier: 'Apex' });
  R.ensure(p);
  assert.deepStrictEqual([p.ranked.rating, p.ranked.mmr, p.ranked.peakRating, p.ranked.peakTier], [1399, 1399, 1399, 'Hunter']);
});

test('cancelMatch drops the pending match unscored: no last place, nothing counted', () => {
  const p = profile();
  const { match } = R.startMatch(p);
  assert.strictEqual(R.cancelMatch(p, 'solo', 'rk-other'), false, 'only the named match');
  assert.strictEqual(R.cancelMatch(p, 'solo', match.id), true);
  assert.deepStrictEqual([p.ranked.pending, p.ranked.matches, p.ranked.rating, p.ranked.history.length], [null, 0, 1000, 0]);
  const next = R.startMatch(p);
  assert.strictEqual(next.abandoned, null, 'the next match has nothing to abandon');
  assert.strictEqual(R.cancelMatch(p, 'duo', next.match.id), false, 'another mode is left alone');
});

test('the entry\'s delta is the change applied, after the 1399 cap and the floor of 0', () => {
  const p = profile();
  R.ensure(p);
  Object.assign(p.ranked, { rating: 1399, mmr: 1000, matches: 10 });
  const { match } = R.startMatch(p);
  const top = R.finishMatch(p, { matchId: match.id, placement: 1 }).entry;
  assert.deepStrictEqual([top.ratingBefore, top.ratingAfter, top.delta], [1399, 1399, 0], 'a win at the cap: +0');
  Object.assign(p.ranked, { rating: 3, mmr: 100 });      // bots around 100: last place would cost ~11
  const low = R.startMatch(p).match;
  const bottom = R.finishMatch(p, { matchId: low.id, placement: 16 }).entry;
  assert.deepStrictEqual([bottom.ratingAfter, bottom.delta], [0, -3], 'last place near 0: -3, not the full loss');
});

// A ranked match running when the season ends (Season 1 ends 2027-02-01).
const AFTER_S1 = Date.parse('2027-02-01T00:10:00Z');
function pendingAtRollover() {
  const p = profile();
  const start = Date.parse('2027-01-31T23:55:00Z');
  R.ensure(p, start);
  Object.assign(p.ranked, { rating: 1100, mmr: 1100, matches: 8, wins: 2, peakRating: 1100 });
  const { match } = R.startMatch(p, start);
  assert.strictEqual(p.ranked.season, 'S1');
  return { p, match };
}

test('a match pending at the season rollover is scored into the old season as last place, not dropped', () => {
  const { p } = pendingAtRollover();
  R.summary(p, AFTER_S1);
  const old = p.ranked.past[0];
  assert.strictEqual(p.ranked.season, 'S2');
  assert.strictEqual(p.ranked.pending, null);
  assert.strictEqual(old.season, 'S1');
  assert.strictEqual(old.matches, 9, 'the abandoned match counted');
  assert.ok(old.rating < 1100, 'as last place: ' + old.rating);
});

test('a result for a match pending at the rollover is scored into the old season with its placement', () => {
  const { p, match } = pendingAtRollover();
  const out = R.finishMatch(p, { matchId: match.id, placement: 1, field: 16 }, AFTER_S1);
  assert.ok(out.entry && !out.error, JSON.stringify(out));
  assert.strictEqual(out.entry.placement, 1);
  const old = p.ranked.past[0];
  assert.deepStrictEqual([old.season, old.matches, old.wins], ['S1', 9, 3]);
  assert.ok(old.rating > 1100, 'the win counted: ' + old.rating);
  assert.deepStrictEqual([p.ranked.season, p.ranked.matches, p.ranked.pending], ['S2', 0, null], 'the new season starts fresh');
});

// Performance review P5: every profile is serialized whole on each save; a
// ranked veteran's record (50 history entries and 100 match IDs per mode) was
// most of it.
test('history keeps the last 20 matches and the match IDs are one bounded list', () => {
  const p = profile();
  let lastId = null;
  for (let i = 0; i < 45; i++) {
    const { match } = R.startMatch(p, 1000 + i);
    R.finishMatch(p, { matchId: match.id, placement: 9 }, 1000 + i);
    lastId = match.id;
  }
  assert.strictEqual(p.ranked.history.length, 20);
  assert.ok(Array.isArray(p.ranked.processed), 'a list');
  assert.strictEqual(p.ranked.processed.length, 20);
  assert.strictEqual(R.finishMatch(p, { matchId: lastId, placement: 1 }).duplicate, true, 'the last result still counts once');
});

test('a record saved with processed as an object is converted, its recent IDs kept', () => {
  const p = profile();
  R.ensure(p);
  p.ranked.processed = {};
  for (let i = 0; i < 30; i++) p.ranked.processed['rk-' + i] = 1000 + i;
  R.ensure(p);
  assert.ok(Array.isArray(p.ranked.processed));
  assert.deepStrictEqual([p.ranked.processed.length, p.ranked.processed[19]], [20, 'rk-29']);
  p.ranked.processed.push('x');
  p.ranked.pending = null;
  assert.strictEqual(R.finishMatch(p, { matchId: 'rk-29', placement: 1 }).duplicate, true);
});

if (failures) { console.log(failures + ' failing'); process.exit(1); }
console.log('all ranked tests passed');
