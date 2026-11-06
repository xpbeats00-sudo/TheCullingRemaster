// Playlists: every queue the menus can ask for, what it is, and whether it
// can be played (docs/SHOWDOWN_MODE_DESIGN.md).
//
// Matches run on each player's own PC with AI contestants: there is no
// dedicated game server and no netplay. A party queues together into one
// lobby and gets one shared match record (lobby id, match id) on every
// member's ticket, but each member plays their own local match; the game's
// Duo, Trios and Quads (casual or ranked) put AI teammates beside each of them. So `teamSize` is what the game
// mode is built for, and `maxParty` is how many friends may queue it together
// (never more than the team, so a party is never split across teams).
//
// A playlist the game can't run yet is listed, disabled, with the reason the
// menu shows. Ranked results are only ever scored from the ticket the server
// issued for that ranked match (server.js /api/matchresult).
"use strict";

const LIST = [
  // Survival (Battle Royale).
  { id: "ffa", name: "Solo", kind: "survival", teamSize: 1, maxParty: 4, ranked: false, enabled: true },
  { id: "lightning", name: "Lightning", kind: "survival", teamSize: 1, maxParty: 4, ranked: false, enabled: true },
  { id: "coop2", name: "Duos", kind: "survival", teamSize: 2, maxParty: 2, ranked: false, enabled: true },
  // Trios and Quads: the pairs mode with teams of 3 and 4 (patch_exe.py fix 9,
  // ?TeamSize= in the native module; docs/TEAM_SIZES_TRIOS_QUADS.md).
  { id: "coop3", name: "Trios", kind: "survival", teamSize: 3, maxParty: 3, ranked: false, enabled: true },
  { id: "coop4", name: "Quads", kind: "survival", teamSize: 4, maxParty: 4, ranked: false, enabled: true },
  // Ranked Survival: rated from server-issued tickets only. Ranked Duos,
  // Trios and Quads are the casual team matches (same URLs, AI teammates)
  // rated on the team's placement, each with its own rating (server/ranked.js,
  // docs/RANKED_TEAMS.md); a party queues them as one, up to the team size.
  { id: "ranked_ffa", name: "Ranked Solo", kind: "survival", teamSize: 1, maxParty: 4, ranked: true, enabled: true },
  { id: "ranked_coop2", name: "Ranked Duos", kind: "survival", teamSize: 2, maxParty: 2, ranked: true, enabled: true },
  { id: "ranked_coop3", name: "Ranked Trios", kind: "survival", teamSize: 3, maxParty: 3, ranked: true, enabled: true },
  { id: "ranked_coop4", name: "Ranked Quads", kind: "survival", teamSize: 4, maxParty: 4, ranked: true, enabled: true },
  // Showdown (patch/make_showdown.py, patch/showdown_rounds.c): you against
  // one AI rival in the Jungle arena, first to 4 rounds, all in one match.
  { id: "showdown", name: "Showdown Solo", kind: "showdown", format: "1v1", teamSize: 1, maxParty: 1, ranked: false, enabled: true },
  // Team Showdown: you and N - 1 AI teammates against N AI rivals (the match
  // URL's ?TeamSize=N; the patched exe teams them and puts each team on its
  // side of the arena). A party of up to N shares one lobby and match record;
  // each member plays their own local match.
  { id: "showdown_duo", name: "Showdown Duos", kind: "showdown", format: "2v2", teamSize: 2, maxParty: 2, ranked: false, enabled: true },
  { id: "showdown_trio", name: "Showdown Trios", kind: "showdown", format: "3v3", teamSize: 3, maxParty: 3, ranked: false, enabled: true },
  { id: "showdown_quad", name: "Showdown Quads", kind: "showdown", format: "4v4", teamSize: 4, maxParty: 4, ranked: false, enabled: true },
  { id: "ranked_showdown", name: "Ranked Showdown", kind: "showdown", format: "1v1", teamSize: 1, maxParty: 1, ranked: true, enabled: false,
    reason: "mode-not-supported", message: "Ranked Showdown isn't available yet: Showdown series aren't rated." }
];

const PLAYLISTS = Object.freeze(Object.fromEntries(LIST.map((p) => [p.id, Object.freeze(p)])));

// Queue names are short identifiers; anything else is Solo.
function queueName(raw) {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? raw : "ffa";
}

// The menus' queue names carry a playlist and sometimes a map
// ("ffa_jungle", "ffa_prison_coop2", "ranked_ffa_jungle", "showdown"): the
// playlist, and the map as the player's first vote. An unknown name is Solo
// (as the stock server treated it), never a lobby of its own.
function resolve(raw) {
  const q = queueName(raw);
  const s = q.toLowerCase();
  const map = /prison/.test(s) ? "prison" : /jungle/.test(s) ? "jungle" : null;
  const ranked = s.startsWith("ranked");
  const team = /coop4|quad|4v4/.test(s) ? 4 : /coop3|trio|3v3/.test(s) ? 3 : /coop2|duo|2v2/.test(s) ? 2 : 1;
  let id;
  if (/showdown/.test(s)) id = ranked ? "ranked_showdown" : ["showdown", "showdown_duo", "showdown_trio", "showdown_quad"][team - 1];
  else if (ranked) id = team === 1 ? "ranked_ffa" : "ranked_coop" + team;
  else if (s.startsWith("lightning")) id = "lightning";
  else id = team === 1 ? "ffa" : "coop" + team;
  return { queue: q, playlist: PLAYLISTS[id], map };
}

// Can a party of `size` (1: on your own) queue this playlist?
function checkParty(playlist, size) {
  if (!playlist.enabled) return { error: playlist.reason, message: playlist.message };
  if (size > playlist.maxParty) {
    return { error: "party-too-large", message: playlist.maxParty === 1
      ? playlist.name + " is played alone: leave your party to play it."
      : playlist.name + " takes parties of up to " + playlist.maxParty + ": yours has " + size + "." };
  }
  return { ok: true };
}

// What the menus may show of every playlist.
function list() {
  return LIST.map((p) => ({ id: p.id, name: p.name, kind: p.kind, format: p.format || null, teamSize: p.teamSize,
    maxParty: p.maxParty, ranked: p.ranked, enabled: p.enabled, reason: p.enabled ? null : p.reason,
    message: p.enabled ? null : p.message }));
}

module.exports = { PLAYLISTS, queueName, resolve, checkParty, list };
