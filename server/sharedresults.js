// Paying and rating one player of a shared match from the game server's
// authoritative result (sharedmatch.js result()). The economy is the local
// match's (server.js matchXP / matchCredits), so a shared match pays what the
// same performance pays today; only the source of the numbers changes: the
// game server, never the player's own HUD.
//
// Ranked: the player's pending ranked match of that mode (started when they
// were sent in) is finished with the server's placement - the team's
// placement among the match's teams in Duos / Trios / Quads, the player's own
// in Solo. A player the server reports as never having joined (or leaves out)
// is a no-show: no pay, and a ranked match counts as last place (as an
// abandoned local match does).
"use strict";

// d (server.js): getProfile, ranked, rankedGrant(p), matchXP(r), matchCredits(r), seasonXPCap(), levelForXP(xp),
//   maxLevel, saveProfiles(), log(...), liveSocket(id), sendPlayer(socket, p), entitlements(p), setPresence(id, state),
//   activityMatch(id).
// ctx: { matchId, playlist, teamSize, teamsCount, field, rankedId, rankedMode, elapsed, teamOutcome,
//   player: { placement, teamPlacement, kills, damage, timeAlive, noShow } }
function payPlayer(d, userID, ctx) {
  const p = d.getProfile(userID);
  const pr = ctx.player;
  const bounded = (v, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0);
  const victory = !pr.noShow && pr.teamPlacement === 1;
  const r = {
    victory,
    kills: bounded(Math.floor(Number(pr.kills)), ctx.field - ctx.teamSize),
    damage: bounded(Number(pr.damage), 5000),
    timeAlive: bounded(Number(pr.timeAlive), Math.min(4 * 3600, ctx.elapsed + 30)),
    func: 0
  };
  let rankedResult = null;
  if (ctx.rankedId && ctx.rankedMode) {
    const rec = d.ranked.record(p, ctx.rankedMode);
    if (rec && rec.pending && rec.pending.id === ctx.rankedId) {
      const team = ctx.teamSize > 1;
      const field = rec.pending.field;
      // Solo: the player's place among the match's contestants; teams: the
      // team's among its teams. A no-show is last.
      const placement = pr.noShow ? (team ? field : ctx.field) : Math.min(team ? field : ctx.field, team ? pr.teamPlacement : pr.placement);
      const out = d.ranked.finishMatch(p, { matchId: ctx.rankedId, placement, field: team ? undefined : ctx.field,
        kills: r.kills, damage: r.damage, timeAlive: r.timeAlive }, Date.now(), d.rankedGrant(p), ctx.rankedMode);
      if (out.error) d.log("shared ranked result rejected", userID, out.error);
      else {
        out.entry.shared = true;
        if (pr.noShow) out.entry.noShow = true;
        if (team && ctx.teamOutcome) out.entry.teamOutcome = ctx.teamOutcome;
        rankedResult = { entry: out.entry, summary: d.ranked.summary(p, Date.now(), ctx.rankedMode) };
        d.log("shared ranked result", ctx.rankedMode, out.entry.matchId, "place", out.entry.placement + "/" + out.entry.field,
          out.entry.ratingBefore, "->", out.entry.ratingAfter, out.entry.tierAfter, pr.noShow ? "(no-show)" : "");
      }
    } else {
      d.log("shared ranked result not scored:", userID, "the", ctx.rankedMode, "match", ctx.rankedId, "is not pending");
    }
  }
  d.setPresence(userID, "menu");
  if (pr.noShow) {
    d.saveProfiles();
    d.log("shared match no-show", userID, ctx.matchId);
    return { matchId: ctx.matchId, noShow: true, xpEarned: 0, credits: 0, ranked: rankedResult };
  }
  d.activityMatch(userID);
  const startXP = p.stats.xp;
  const earned = d.matchXP(r);
  const credits = d.matchCredits(r);
  p.cullCredits += credits;
  const s = p.stats;
  s.xp = Math.min(d.seasonXPCap(), s.xp + earned);
  const level = Math.min(d.maxLevel, d.levelForXP(s.xp) || s.level);
  const levelled = Boolean(level && level !== s.level);
  if (levelled) { d.log("level", userID, s.level, "->", level); s.level = level; }
  s.gamesPlayed += 1;
  s.kills += r.kills;
  s.wins += r.victory ? 1 : 0;
  s.totalDamage += Math.round(r.damage);
  s.minutesAlive += Math.round(r.timeAlive / 60);
  if (!p.modes || typeof p.modes !== "object") p.modes = {};
  const m = p.modes[ctx.playlist] || (p.modes[ctx.playlist] = { played: 0, wins: 0, kills: 0, damage: 0, minutesAlive: 0 });
  m.played += 1;
  m.wins += r.victory ? 1 : 0;
  m.kills += r.kills;
  m.damage += Math.round(r.damage);
  m.minutesAlive += Math.round(r.timeAlive / 60);
  p.lastMatch = Object.assign({ at: Date.now(), xpEarned: earned, shared: true, matchId: ctx.matchId, placement: pr.placement,
    teamPlacement: pr.teamPlacement }, r);
  d.saveProfiles();
  d.log("shared match result", userID, ctx.matchId, JSON.stringify(r), "place", pr.placement, "team place", pr.teamPlacement,
    `+${earned} XP (${startXP} -> ${s.xp}), +${credits} credits`);
  const socket = d.liveSocket(userID);
  if (socket) d.sendPlayer(socket, p);
  if (socket && levelled) socket.emit("entitlements-response", d.entitlements(p));
  return { matchId: ctx.matchId, placement: pr.placement, teamPlacement: pr.teamPlacement, victory: r.victory, kills: r.kills,
    damage: r.damage, timeAlive: r.timeAlive, startXP, xpEarned: earned, credits, ranked: rankedResult };
}

module.exports = { payPlayer };
