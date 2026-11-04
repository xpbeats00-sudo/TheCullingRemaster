// Last Breath (Showdown/Showdown_mode.md): server-side rules core.
//
// Round-based team elimination with a closing toxic zone. This module holds
// the authoritative rules only: configuration, the zone timeline, gas damage
// per server tick, and round / match state. It is NOT wired into the game.
// The cooked game has no round loop, no team mode beyond pairs and no
// circular zone, so it needs new game-side Blueprints, which can't be authored
// for a cooked build (see GAME_MODE_INTEGRATION_REPORT.md).

const fs = require('fs');
const path = require('path');

const INI_FILE = path.join(__dirname, 'data', 'lastbreath.ini');

function parseIni(text, section) {
  const out = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { current = m[1]; continue; }
    if (current !== section) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function loadConfig(text = fs.readFileSync(INI_FILE, 'utf8')) {
  const v = parseIni(text, 'LastBreath');
  const num = (k) => {
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`LastBreath: ${k} must be a number >= 0, got ${v[k]}`);
    return n;
  };
  const cfg = {
    roundsToWin: num('RoundsToWin'),
    maxRounds: num('MaxRounds'),
    teamSizes: String(v.SupportedTeamSizes || '').split(',').map(Number).filter((n) => n > 0),
    respawns: v.RespawnsEnabled === 'true',
    healing: v.HealingEnabled !== 'false',
    tolerance: num('BoundaryToleranceUnits'),
    tick: num('DamageTickSeconds'),
    phases: [{ name: 'FullSafe', duration: num('FullSafeDurationSeconds'), dps: 0, endFraction: 1 }]
  };
  for (const name of ['Initial', 'Accelerated', 'Critical', 'Final']) {
    cfg.phases.push({
      name: name + 'Collapse',
      duration: num(name + 'CollapseDurationSeconds'),
      dps: num(name + 'GasDamagePerSecond'),
      endFraction: num(name + 'CollapseEndRadiusFraction')
    });
  }
  if (cfg.roundsToWin < 1 || cfg.maxRounds < 2 * cfg.roundsToWin - 1) {
    throw new Error('LastBreath: MaxRounds must allow RoundsToWin for one team');
  }
  return cfg;
}

// Zone state at round time t (seconds since the round went active). The
// radius interpolates linearly inside each phase; after the last phase the
// zone stays at its final radius and final damage.
function zoneAt(cfg, t, startRadius) {
  let begin = 0;
  let fromFraction = 1;
  for (let i = 0; i < cfg.phases.length; i++) {
    const ph = cfg.phases[i];
    if (t < begin + ph.duration || i === cfg.phases.length - 1) {
      const k = ph.duration > 0 ? Math.min(1, Math.max(0, (t - begin) / ph.duration)) : 1;
      const fraction = fromFraction + (ph.endFraction - fromFraction) * k;
      return { phase: ph.name, phaseIndex: i, phaseStart: begin, phaseDuration: ph.duration,
        radius: startRadius * fraction, dps: t < begin ? 0 : ph.dps };
    }
    begin += ph.duration;
    fromFraction = ph.endFraction;
  }
  return null;
}

// Gas damage for one server tick to a player `distance` from the zone centre.
// Inside radius + tolerance is safe; once the zone has closed completely the
// tolerance no longer applies, or it would leave a permanent safe dot.
function gasDamage(cfg, t, startRadius, distance) {
  const z = zoneAt(cfg, t, startRadius);
  if (z.radius <= 0) return z.dps * cfg.tick;
  return distance > z.radius + cfg.tolerance ? z.dps * cfg.tick : 0;
}

// ---------------------------------------------------------------- match state

function createMatch(cfg, teamSize, teamA, teamB) {
  if (!cfg.teamSizes.includes(teamSize)) throw new Error('unsupported team size ' + teamSize);
  if (teamA.length !== teamSize || teamB.length !== teamSize) throw new Error('teams must have ' + teamSize + ' players');
  const ids = teamA.concat(teamB);
  if (new Set(ids).size !== ids.length) throw new Error('a player is on both teams');
  return { cfg, teamSize, teams: { A: teamA.slice(), B: teamB.slice() }, score: { A: 0, B: 0 },
    rounds: [], round: null, state: 'MatchSetup', winner: null };
}

function startRound(m) {
  if (m.state !== 'MatchSetup' && m.state !== 'RoundReset') throw new Error('cannot start a round in ' + m.state);
  m.round = { number: m.rounds.length + 1, alive: { A: new Set(m.teams.A), B: new Set(m.teams.B) },
    eliminated: new Set(), winner: null };
  m.state = 'RoundActive';
  return m.round;
}

function teamOf(m, id) {
  return m.teams.A.includes(id) ? 'A' : m.teams.B.includes(id) ? 'B' : null;
}

// Eliminations arriving in one server update are applied together, so both
// teams dying in the same update is a drawn round rather than a win for
// whichever event was processed first. Repeated events for a player are
// ignored. Returns the round result once the round resolves, else null.
function applyEliminations(m, ids) {
  if (m.state !== 'RoundActive') return null;
  for (const id of ids) {
    const team = teamOf(m, id);
    if (!team || m.round.eliminated.has(id)) continue;
    m.round.eliminated.add(id);
    m.round.alive[team].delete(id);
  }
  const outA = m.round.alive.A.size === 0;
  const outB = m.round.alive.B.size === 0;
  if (!outA && !outB) return null;
  m.round.winner = outA && outB ? 'draw' : outA ? 'B' : 'A';
  if (m.round.winner !== 'draw') m.score[m.round.winner] += 1;
  m.rounds.push({ number: m.round.number, winner: m.round.winner });
  const decided = m.score.A >= m.cfg.roundsToWin || m.score.B >= m.cfg.roundsToWin;
  if (decided || m.rounds.length >= m.cfg.maxRounds) {
    m.state = 'MatchResolution';
    m.winner = m.score.A === m.score.B ? 'draw' : m.score.A > m.score.B ? 'A' : 'B';
  } else {
    m.state = 'RoundReset';
  }
  return { round: m.round.number, winner: m.round.winner, score: Object.assign({}, m.score), state: m.state };
}

// A disconnect counts as an elimination for the current round.
const disconnect = (m, id) => applyEliminations(m, [id]);

module.exports = { loadConfig, parseIni, zoneAt, gasDamage, createMatch, startRound, applyEliminations, disconnect };
