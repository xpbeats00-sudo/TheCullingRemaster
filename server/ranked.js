// The Culling Remaster - Ranked Solo (LOCAL TEST MODE).
//
// Implements the rating rules of Ranked/Markdown/The_Culling_Remaster_Ranked_Mode_Design.md
// for the local server. Every opponent is a bot and results come from the
// player's own game client, so this is a local/test ladder, not validated
// online competition (design doc section 13).
//
//  - Starting rating 1,000; 5 placement matches at K 48, then K 32.
//  - Rating moves on placement only: the player is compared with every
//    opponent (finished above: 1, below: 0) against the ELO expectation
//    1 / (1 + 10^((opp - player) / 400)); the match change is
//    K * sum(actual - expected) / (opponents), so one match moves at most K.
//  - Opponents are bots rated around the player's hidden MMR (which moves
//    more slowly than the visible rating); their finishing order is drawn
//    from their ratings, seeded by the match ID, so a result is reproducible.
//  - Every match has an ID; a result is applied once, and a match left
//    unfinished counts as last place when the next ranked match starts.
//  - Kills, damage and survival time are recorded but never rated.
//  - Tier rewards are granted once, on first reaching a tier, and kept.

const crypto = require('crypto');

const CONFIG = {
  startRating: 1000,
  placementMatches: 5,
  kProvisional: 48,
  kEstablished: 32,
  kMMR: 24,
  // The local bot match: the player and 50 bots (patch_assets.py BotsToSpawn).
  field: 51,
  botSpread: 150,          // bot ratings: player MMR +- this (normal sd)
  historyLength: 50,
  season: { id: 'S1', name: 'Season 1', start: '2026-11-01T00:00:00Z', end: '2027-02-01T00:00:00Z' }
};

const TIERS = [
  { name: 'Scrapper', min: 0, identity: 'Prove you belong.' },
  { name: 'Contender', min: 800, identity: 'Learning to survive.' },
  { name: 'Blooded', min: 1000, identity: 'Survived the first trials.' },
  { name: 'Hunter', min: 1200, identity: 'Track and eliminate.' },
  { name: 'Executioner', min: 1400, identity: 'A dangerous opponent.' },
  { name: 'Reaper', min: 1600, identity: 'Few escape you.' },
  { name: 'Warlord', min: 1800, identity: 'Control the arena.' },
  { name: 'Apex', min: 2000, identity: 'Among the strongest.' },
  { name: 'Legend', min: 2200, identity: 'The elite survivors.' }
];

function tierFor(rating) {
  let index = 0;
  for (let i = 0; i < TIERS.length; i++) if (rating >= TIERS[i].min) index = i;
  const tier = TIERS[index];
  const next = TIERS[index + 1];
  return {
    index,
    name: tier.name,
    identity: tier.identity,
    min: tier.min,
    next: next ? next.min : null,
    progress: next ? Math.max(0, Math.min(1, (rating - tier.min) / (next.min - tier.min))) : 1
  };
}

function expected(player, opponent) {
  return 1 / (1 + Math.pow(10, (opponent - player) / 400));
}

// Deterministic PRNG (mulberry32) seeded from a string.
function rng(seed) {
  let a = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// The opponents of a match: ratings around the MMR, in the order they finish
// (best first), drawn from their ratings.
function opponentsFor(matchId, mmr, field = CONFIG.field) {
  const rand = rng(matchId);
  const bots = [];
  for (let i = 0; i < field - 1; i++) {
    const rating = Math.round(Math.max(100, mmr + CONFIG.botSpread * normal(rand)));
    bots.push({ rating, performance: rating + 200 * normal(rand) });
  }
  bots.sort((a, b) => b.performance - a.performance);
  return bots.map((b) => b.rating);
}

// Rating change for finishing at `placement` (1 = winner) among the
// opponents finishing in `order` (best first). Ties share a placement.
function ratingChange(rating, placement, order, k) {
  let sum = 0;
  order.forEach((opp, i) => {
    // Opponent i finished at position i+1 if ahead of the player, else i+2.
    const oppPlacement = i + 1 < placement ? i + 1 : i + 2;
    const actual = oppPlacement > placement ? 1 : oppPlacement === placement ? 0.5 : 0;
    sum += actual - expected(rating, opp);
  });
  return k * sum / order.length;
}

function blank() {
  return {
    season: CONFIG.season.id,
    rating: CONFIG.startRating,
    mmr: CONFIG.startRating,
    matches: 0,
    wins: 0,
    peakRating: CONFIG.startRating,
    peakTier: tierFor(CONFIG.startRating).name,
    pending: null,
    processed: {},
    history: [],
    tiersReached: {}
  };
}

function ensure(profile) {
  if (!profile.ranked) profile.ranked = blank();
  return profile.ranked;
}

function isPlacement(r) {
  return r.matches < CONFIG.placementMatches;
}

// Applies a finished (or abandoned) match. Returns the history entry.
function apply(r, match, result, now, grant) {
  const order = opponentsFor(match.id, match.mmr, match.field);
  const k = isPlacement(r) ? CONFIG.kProvisional : CONFIG.kEstablished;
  const before = r.rating;
  const delta = Math.round(ratingChange(before, result.placement, order, k));
  const mmrDelta = ratingChange(r.mmr, result.placement, order, CONFIG.kMMR);
  const tierBefore = tierFor(before).name;
  r.rating = Math.max(0, before + delta);
  r.mmr = Math.max(0, r.mmr + mmrDelta);
  r.matches += 1;
  if (result.placement === 1) r.wins += 1;
  const tier = tierFor(r.rating);
  const placementsDone = !isPlacement(r);
  let rewards = [];
  if (placementsDone) {
    if (r.rating > r.peakRating) { r.peakRating = r.rating; r.peakTier = tier.name; }
    // Every tier up to the current one counts as reached (placements can land high).
    for (let i = 0; i <= tier.index; i++) {
      const name = TIERS[i].name;
      if (!r.tiersReached[name]) {
        r.tiersReached[name] = now;
        rewards = rewards.concat(grant ? grant(name) : []);
      }
    }
  }
  const entry = {
    matchId: match.id,
    at: now,
    abandoned: Boolean(result.abandoned),
    placement: result.placement,
    field: match.field,
    ratingBefore: before,
    ratingAfter: r.rating,
    delta,
    k,
    placement_match: !placementsDone || r.matches === CONFIG.placementMatches,
    tierBefore,
    tierAfter: tier.name,
    kills: result.kills || 0,
    damage: result.damage || 0,
    timeAlive: result.timeAlive || 0,
    rewards
  };
  r.processed[match.id] = entry;
  r.history.unshift(entry);
  r.history.length = Math.min(r.history.length, CONFIG.historyLength);
  return entry;
}

// Starts a ranked match; an unfinished earlier one counts as last place.
function startMatch(profile, now = Date.now(), grant) {
  const r = ensure(profile);
  let abandoned = null;
  if (r.pending) {
    abandoned = apply(r, r.pending, { placement: r.pending.field, abandoned: true }, now, grant);
  }
  r.pending = {
    id: 'rk-' + crypto.randomBytes(8).toString('hex'),
    startedAt: now,
    ratingBefore: r.rating,
    mmr: Math.round(r.mmr),
    field: CONFIG.field
  };
  return { match: r.pending, abandoned };
}

// Applies the result of the pending match. Same match ID twice: the first
// result stands. Invalid results are rejected without changing anything.
function finishMatch(profile, result, now = Date.now(), grant) {
  const r = ensure(profile);
  if (result.matchId && r.processed[result.matchId]) return { entry: r.processed[result.matchId], duplicate: true };
  if (!r.pending) return { error: 'no-ranked-match' };
  const match = r.pending;
  if (result.matchId && result.matchId !== match.id) return { error: 'unknown-match' };
  const placement = Number(result.placement);
  if (!Number.isInteger(placement) || placement < 1 || placement > match.field) return { error: 'invalid-placement' };
  r.pending = null;
  return { entry: apply(r, match, Object.assign({}, result, { placement }), now, grant) };
}

function summary(profile, now = Date.now()) {
  const r = ensure(profile);
  const tier = tierFor(r.rating);
  const end = Date.parse(CONFIG.season.end);
  return {
    localTestMode: true,
    season: { id: CONFIG.season.id, name: CONFIG.season.name, end: CONFIG.season.end,
      daysLeft: Math.max(0, Math.ceil((end - now) / 86400000)) },
    rating: r.rating,
    tier,
    placement: isPlacement(r) ? { played: r.matches, total: CONFIG.placementMatches } : null,
    matches: r.matches,
    wins: r.wins,
    peak: { rating: r.peakRating, tier: r.peakTier },
    recent: r.history.slice(0, 10),
    tiers: TIERS.map((t) => ({ name: t.name, min: t.min, reached: Boolean(r.tiersReached[t.name]) })),
    inMatch: Boolean(r.pending)
  };
}

module.exports = { CONFIG, TIERS, tierFor, expected, opponentsFor, ratingChange, ensure, startMatch, finishMatch, summary };
