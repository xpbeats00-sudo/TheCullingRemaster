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
  // A match's contestants: the player and 15 bots. Victory.exe caps players
  // plus bots at 16 whatever BotsToSpawn says, and the HUD reports placements
  // 1-16; scoring a bigger field made even last place gain rating.
  field: 16,
  // Builds with patch_exe.py place up to 24; the result says how many the
  // match had (server.js matchField), never more than this.
  maxField: 24,
  botSpread: 150,          // bot ratings: player MMR +- this (normal sd)
  // The season just opened: no bot is rated above the top of T4 (Hunter,
  // 1200-1399); a bot at Executioner or higher would be implausible.
  botMaxRating: 1399,
  // Season start: no player is rated above the top of T4 (Hunter) either, so
  // no tier above Hunter can be reached or rewarded yet. Raise as the season
  // matures (and botMaxRating with it).
  maxRating: 1399,
  historyLength: 50,
  processedLength: 100,    // match IDs remembered against duplicate results
  // Season 1; the seasons after it follow back to back with the same length
  // (seasonAt). CONFIG.season is always the current one.
  firstSeason: { id: 'S1', name: 'Season 1', start: '2026-11-01T00:00:00Z', end: '2027-02-01T00:00:00Z' },
  pastSeasonsKept: 12
};

// The season running at `now`: Season 1, then Season 2, 3, ... each as long
// as Season 1, starting when the one before ends.
function seasonAt(now = Date.now()) {
  const first = CONFIG.firstSeason;
  const start = Date.parse(first.start), end = Date.parse(first.end), length = end - start;
  const n = now < end ? 0 : Math.floor((now - end) / length) + 1;
  if (n === 0) return first;
  const s = end + (n - 1) * length;
  return { id: 'S' + (n + 1), name: 'Season ' + (n + 1), start: new Date(s).toISOString(), end: new Date(s + length).toISOString() };
}
Object.defineProperty(CONFIG, 'season', { get: () => seasonAt(Date.now()), enumerable: true });

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
    const rating = Math.round(Math.min(CONFIG.botMaxRating, Math.max(100, mmr + CONFIG.botSpread * normal(rand))));
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

// A new season: last season's record is kept in r.past, rating and MMR are
// softly reset toward the start (MMR keeps half its distance, so matchmaking
// still knows roughly how good the player is), and the tiers start over.
// Rewards already earned stay owned (they live in the profile's owned list).
function rollover(r, season) {
  if (r.matches > 0) {
    r.past = [{ season: r.season, rating: r.rating, peakRating: r.peakRating, peakTier: r.peakTier,
      matches: r.matches, wins: r.wins }].concat(Array.isArray(r.past) ? r.past : []).slice(0, CONFIG.pastSeasonsKept);
  }
  const fresh = blank();
  fresh.season = season.id;
  fresh.mmr = Math.round(CONFIG.startRating + (Math.min(r.mmr || CONFIG.startRating, CONFIG.maxRating) - CONFIG.startRating) / 2);
  fresh.past = r.past;
  for (const k of Object.keys(r)) delete r[k];
  Object.assign(r, fresh);
}

function blank() {
  return {
    season: seasonAt().id,
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

function ensure(profile, now = Date.now()) {
  if (!profile.ranked) profile.ranked = blank();
  const r = profile.ranked;
  const season = seasonAt(now);
  if (r.season !== season.id) rollover(r, season);
  // Profiles from before the season caps (or imported): brought within them.
  if (r.rating > CONFIG.maxRating) r.rating = CONFIG.maxRating;
  if (r.mmr > CONFIG.maxRating) r.mmr = CONFIG.maxRating;
  if (r.peakRating > CONFIG.maxRating) { r.peakRating = CONFIG.maxRating; r.peakTier = tierFor(CONFIG.maxRating).name; }
  return r;
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
  r.rating = Math.min(CONFIG.maxRating, Math.max(0, before + delta));
  r.mmr = Math.min(CONFIG.maxRating, Math.max(0, r.mmr + mmrDelta));
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
  // Processed match IDs -> when. Only the ID matters (the entry itself is in
  // history); profiles from before stored a full copy of every entry here,
  // forever, which made a ranked veteran's profile ~75 KB and every save of
  // profiles.json slower. Only recent IDs need remembering: a result can only
  // be for the pending match.
  r.processed[match.id] = now;
  const ids = Object.keys(r.processed);
  for (let i = 0; i < ids.length; i++) {
    if (i < ids.length - CONFIG.processedLength) delete r.processed[ids[i]];
    else if (typeof r.processed[ids[i]] === 'object') r.processed[ids[i]] = r.processed[ids[i]].at || now;
  }
  r.history.unshift(entry);
  r.history.length = Math.min(r.history.length, CONFIG.historyLength);
  return entry;
}

// Starts a ranked match; an unfinished earlier one counts as last place.
function startMatch(profile, now = Date.now(), grant) {
  const r = ensure(profile, now);
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
  const r = ensure(profile, now);
  if (result.matchId && Object.prototype.hasOwnProperty.call(r.processed, result.matchId)) {
    const entry = r.history.find((h) => h.matchId === result.matchId) || { matchId: result.matchId };
    return { entry, duplicate: true };
  }
  if (!r.pending) return { error: 'no-ranked-match' };
  const match = r.pending;
  if (result.matchId && result.matchId !== match.id) return { error: 'unknown-match' };
  // The match's real field when the result knows it (more contestants on some maps).
  const field = Number.isInteger(result.field) && result.field >= 2 && result.field <= CONFIG.maxField ? result.field : match.field;
  const placement = Number(result.placement);
  if (!Number.isInteger(placement) || placement < 1 || placement > field) return { error: 'invalid-placement' };
  r.pending = null;
  return { entry: apply(r, Object.assign({}, match, { field }), Object.assign({}, result, { placement }), now, grant) };
}

function summary(profile, now = Date.now()) {
  const r = ensure(profile, now);
  const tier = tierFor(r.rating);
  const season = seasonAt(now);
  const end = Date.parse(season.end);
  return {
    localTestMode: true,
    season: { id: season.id, name: season.name, end: season.end,
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

module.exports = { CONFIG, TIERS, tierFor, expected, opponentsFor, ratingChange, ensure, startMatch, finishMatch, summary, seasonAt };
