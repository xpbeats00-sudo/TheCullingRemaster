// The Culling Remaster - Ranked Solo, Duo, Trio and Quads (LOCAL TEST MODE).
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
//
// Ranked Duo, Trio and Quads (docs/RANKED_TEAMS.md) are the same ladder with
// a rating of their own per mode (same tiers, seasons, K, placements and
// caps), kept beside Solo's: profile.ranked is Solo (unchanged), and
// profile.rankedTeams.{duo,trio,quad} the team modes, created when first
// used. A team match is rated on the TEAM's placement among the teams
// (field = contestants / team size: 12 duos, 8 trios or 6 quads on Jungle),
// against bot teams rated around the player's MMR for that mode.

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

// The ranked modes: Solo is profile.ranked; the others profile.rankedTeams[id].
const MODES = Object.freeze({
  solo: Object.freeze({ id: 'solo', playlist: 'ranked_ffa', name: 'Ranked Solo', teamSize: 1 }),
  duo: Object.freeze({ id: 'duo', playlist: 'ranked_coop2', name: 'Ranked Duos', teamSize: 2 }),
  trio: Object.freeze({ id: 'trio', playlist: 'ranked_coop3', name: 'Ranked Trios', teamSize: 3 }),
  quad: Object.freeze({ id: 'quad', playlist: 'ranked_coop4', name: 'Ranked Quads', teamSize: 4 })
});
const MODE_IDS = Object.keys(MODES);
const TEAM_MODE_IDS = MODE_IDS.filter((m) => m !== 'solo');

// A mode id ('solo', 'duo', 'trio', 'quad'); anything else is Solo.
function modeId(mode) {
  return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(MODES, mode) ? mode : 'solo';
}

// The ranked mode a playlist id scores ('ranked_coop2' -> 'duo'), or null.
function modeForPlaylist(playlist) {
  for (const id of MODE_IDS) if (MODES[id].playlist === playlist) return id;
  return null;
}

// How many teams a team match has: the contestants the map places, divided
// by the team size (16 on Jungle and Prison: 8 duos, 5 trios, 4 quads).
function teamField(mode, contestants = CONFIG.maxField) {
  const size = MODES[modeId(mode)].teamSize;
  const n = Number.isInteger(contestants) && contestants >= 2 ? Math.min(contestants, CONFIG.maxField) : CONFIG.maxField;
  return Math.max(2, Math.floor(n / size));
}

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

const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// The stored record of a mode, or null if there is none yet (never creates one).
function record(profile, mode = 'solo') {
  const id = modeId(mode);
  if (!profile) return null;
  if (id === 'solo') return isRecord(profile.ranked) ? profile.ranked : null;
  const teams = profile.rankedTeams;
  return isRecord(teams) && isRecord(teams[id]) ? teams[id] : null;
}

// A mode's record, created (or repaired) if needed and brought to the current
// season. Profiles from before the team modes have no rankedTeams: it is
// added, with only the modes played, when a team mode is first used; Solo's
// record (profile.ranked) is never touched by another mode.
function ensure(profile, now = Date.now(), mode = 'solo') {
  const id = modeId(mode);
  let r;
  if (id === 'solo') {
    if (!isRecord(profile.ranked)) profile.ranked = blank();
    r = profile.ranked;
  } else {
    if (!isRecord(profile.rankedTeams)) profile.rankedTeams = {};
    if (!isRecord(profile.rankedTeams[id])) profile.rankedTeams[id] = blank();
    r = profile.rankedTeams[id];
  }
  // Fields a hand-edited or imported record may lack.
  if (!isRecord(r.processed)) r.processed = {};
  if (!isRecord(r.tiersReached)) r.tiersReached = {};
  if (!Array.isArray(r.history)) r.history = [];
  if (!Number.isFinite(r.rating)) r.rating = CONFIG.startRating;
  if (!Number.isFinite(r.mmr)) r.mmr = r.rating;
  if (!Number.isInteger(r.matches) || r.matches < 0) r.matches = 0;
  if (!Number.isInteger(r.wins) || r.wins < 0) r.wins = 0;
  if (!Number.isFinite(r.peakRating)) { r.peakRating = r.rating; r.peakTier = tierFor(r.rating).name; }
  if (r.pending !== null && !isRecord(r.pending)) r.pending = null;
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
function apply(r, match, result, now, grant, mode = 'solo') {
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
    mode,
    teamSize: MODES[mode].teamSize,
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

// Starts a ranked match of `opts.mode` (Solo by default); an unfinished
// earlier one OF THE SAME MODE counts as last place (another mode's pending
// match is left alone). opts.field: a team match's number of teams
// (teamField); Solo starts at the stock 16 and the result may say more.
function startMatch(profile, now = Date.now(), grant, opts = {}) {
  const mode = modeId(opts.mode);
  const r = ensure(profile, now, mode);
  let abandoned = null;
  if (r.pending) {
    abandoned = apply(r, r.pending, { placement: r.pending.field, abandoned: true }, now, grant, mode);
  }
  const field = mode === 'solo' ? CONFIG.field
    : Number.isInteger(opts.field) && opts.field >= 2 && opts.field <= teamField(mode) ? opts.field : teamField(mode);
  r.pending = {
    id: (mode === 'solo' ? 'rk-' : 'rk' + mode[0] + '-') + crypto.randomBytes(8).toString('hex'),
    mode,
    startedAt: now,
    ratingBefore: r.rating,
    mmr: Math.round(r.mmr),
    field
  };
  return { match: r.pending, abandoned };
}

// Applies the result of the pending match of `mode`. Same match ID twice: the
// first result stands. Invalid results are rejected without changing anything.
// A team match's placement is the team's, 1..its number of teams; its field is
// the one it started with (a result can't change it).
function finishMatch(profile, result, now = Date.now(), grant, mode = 'solo') {
  mode = modeId(mode);
  const r = ensure(profile, now, mode);
  if (result.matchId && Object.prototype.hasOwnProperty.call(r.processed, result.matchId)) {
    const entry = r.history.find((h) => h.matchId === result.matchId) || { matchId: result.matchId };
    return { entry, duplicate: true };
  }
  if (!r.pending) return { error: 'no-ranked-match' };
  const match = r.pending;
  if (result.matchId && result.matchId !== match.id) return { error: 'unknown-match' };
  // Solo: the match's real field when the result knows it (more contestants on some maps).
  const field = mode === 'solo' && Number.isInteger(result.field) && result.field >= 2 && result.field <= CONFIG.maxField
    ? result.field : match.field;
  const placement = Number(result.placement);
  if (!Number.isInteger(placement) || placement < 1 || placement > field) return { error: 'invalid-placement' };
  r.pending = null;
  return { entry: apply(r, Object.assign({}, match, { field }), Object.assign({}, result, { placement }), now, grant, mode) };
}

// A team match's placement from the HUD's report: 1 for the team's win (the
// HUD posts a victory when your team wins, even after your own death); a loss
// is the team-sized slice of the field the reported position falls in
// (positions 1-2 of 24 in Duo are team place 1, 3-4 place 2, ... 23-24 place
// 12), never first without the win and never past the number of teams; a
// missing or malformed position is last. `reported`: the contestant position
// the HUD sent, `teams`: the match's number of teams.
function teamPlacement(mode, reported, victory, teams) {
  if (victory) return 1;
  const size = MODES[modeId(mode)].teamSize;
  const n = typeof reported === 'number' ? reported : Number(reported);
  if (!Number.isInteger(n) || n < 1) return teams;
  return Math.min(teams, Math.max(2, Math.ceil(n / size)));
}

function summary(profile, now = Date.now(), mode = 'solo') {
  mode = modeId(mode);
  const r = ensure(profile, now, mode);
  const tier = tierFor(r.rating);
  const season = seasonAt(now);
  const end = Date.parse(season.end);
  return {
    localTestMode: true,
    mode,
    name: MODES[mode].name,
    playlist: MODES[mode].playlist,
    teamSize: MODES[mode].teamSize,
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

// Every mode's summary, for the Ranked screen's tabs. A team mode never
// played shows a blank record's summary, and nothing is written for it.
function summaries(profile, now = Date.now()) {
  const out = {};
  for (const id of MODE_IDS) {
    out[id] = id === 'solo' || record(profile, id) ? summary(profile, now, id) : summary({}, now, id);
  }
  return out;
}

module.exports = { CONFIG, TIERS, MODES, MODE_IDS, TEAM_MODE_IDS, modeId, modeForPlaylist, teamField, teamPlacement, record,
  tierFor, expected, opponentsFor, ratingChange, ensure, startMatch, finishMatch, summary, summaries, seasonAt };
