// Shared matches: a lobby's players sent to ONE match on ONE game server
// (docs/PARTY_MATCHMAKING_REWORK.md; spec: docs/REAL_MULTIPLAYER_ARCHITECTURE_AUDIT.md
// section 4).
//
// Off unless CULLING_SHARED_MATCHES=1, and then only for the playlists in
// CULLING_SHARED_PLAYLISTS (Showdown is never shared: paused until real
// dedicated servers work). Everything else plays exactly as before: each
// player's own local match against bots.
//
// The flow, for a lobby of an allowed playlist whose countdown ended:
// 1. Teams: every party is one team (never split); other teams are filled
//    from other parties and solos (first fit, largest group first); the rest
//    of the field is bots (16 contestants, one per pod; Trios 15).
// 2. Allocate: the allocator reserves a game server with the map, mode,
//    match id, team layout and bot count, and waits for its ready.
// 3. Tickets: each player gets a one-use connection ticket (connticket.js).
//    match-ready carries gameServer "<host>:<port>", nonce (the ticket),
//    serverNonce (the match's server nonce) and netplay: true, so the stock
//    menu branch calls ConnectToServer. The stock client opens
//    "<gameServer>?Nonce=<nonce>" (the game server reads the ticket from
//    ?Nonce= at PreLogin) and keeps serverNonce; the game server, started
//    with ?servernonce=<the assignment's serverNonce>, sends it back in
//    ClientCheckServerNonce and a client whose own differs quits (Victory.exe
//    0x1401dce90 and 0x140233b00). Everyone in the match gets the same address
//    and server nonce.
// 4. The game server checks each ticket at PreLogin (verify-ticket), runs the
//    match and posts one signed result for everyone; the backend pays and
//    rates every player from it (sharedresults.js). The client HUD's own
//    /api/matchresult for a shared match is ignored and logged.
// 5. Failure: no server, no capacity, no ready in time, a crash or silence
//    mid-match, a server aborting: the match is cancelled, every ticket is
//    revoked, ranked matches are voided (no rating lost), the players are told
//    (now, or at their next login) and re-queued when they are in the menu.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Allocator, sign, safeEqualHex, loadSecret, parsePool, parsePorts, parseCommand } = require("./allocator");
const { ConnectionTickets } = require("./connticket");
const { CoalescedJsonFile } = require("./store");

const int = (v, d) => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : d; };

// Every setting, from the environment (documented in PARTY_MATCHMAKING_REWORK.md).
function config(env = process.env) {
  const command = parseCommand(env.CULLING_GAMESERVER_COMMAND);
  return {
    enabled: env.CULLING_SHARED_MATCHES === "1",
    playlists: String(env.CULLING_SHARED_PLAYLISTS || "").split(",").map((s) => s.trim()).filter(Boolean),
    pool: parsePool(env.CULLING_GAMESERVER_POOL),
    launch: command ? { command, ports: parsePorts(env.CULLING_GAMESERVER_PORTS), host: env.CULLING_GAMESERVER_HOST || "127.0.0.1",
      publicHost: env.CULLING_GAMESERVER_PUBLIC_HOST || env.CULLING_GAMESERVER_HOST || "127.0.0.1",
      cwd: env.CULLING_GAMESERVER_CWD || null, logDir: env.CULLING_GAMESERVER_LOG_DIR || null } : null,
    maxMatches: int(env.CULLING_GAMESERVER_MAX, 0),
    readyTimeoutMs: int(env.CULLING_GAMESERVER_READY_TIMEOUT_MS, 60000),
    heartbeatMs: int(env.CULLING_GAMESERVER_HEARTBEAT_MS, 2000),
    heartbeatTimeoutMs: int(env.CULLING_GAMESERVER_HEARTBEAT_TIMEOUT_MS, 10000),
    maxMatchMs: int(env.CULLING_SHARED_MAX_MATCH_MS, 90 * 60 * 1000),
    ticketTtlMs: int(env.CULLING_TICKET_TTL_MS, 120000),
    requeueMax: int(env.CULLING_SHARED_REQUEUE_MAX, 2),
    requeueOnCancel: env.CULLING_SHARED_REQUEUE_ON_CANCEL !== "0",
    clockSkewMs: int(env.CULLING_GAMESERVER_CLOCK_SKEW_MS, 60000),
    gameServerSecret: env.CULLING_GAMESERVER_SECRET || null,
    ticketSecret: env.CULLING_TICKET_SECRET || null
  };
}

// Packs groups (a party, or a solo) into `teamsCount` teams of `teamSize`,
// largest group first, each into the first team with room. A group is never
// split; one that doesn't fit is in `overflow`. Teams are numbered from 1.
function packTeams(groups, teamSize, teamsCount) {
  const teams = [];
  for (let i = 0; i < teamsCount; i++) teams.push({ team: i + 1, players: [], groups: [] });
  const overflow = [];
  const order = groups.map((g, i) => ({ g, i })).sort((a, b) => b.g.ids.length - a.g.ids.length || a.i - b.i);
  for (const { g } of order) {
    if (g.ids.length > teamSize) { overflow.push(g); continue; }
    const t = teams.find((x) => x.players.length + g.ids.length <= teamSize);
    if (!t) { overflow.push(g); continue; }
    t.players.push(...g.ids);
    t.groups.push(g);
  }
  return { teams, overflow };
}

// Lobby members -> groups: a party's members together, a solo alone.
function groupsOf(members) {
  const byParty = new Map();
  const out = [];
  for (const m of members) {
    if (!m.party) { out.push({ ids: [m.id], party: null }); continue; }
    if (!byParty.has(m.party)) { const g = { ids: [], party: m.party }; byParty.set(m.party, g); out.push(g); }
    byParty.get(m.party).ids.push(m.id);
  }
  return out;
}

const MESSAGES = {
  "no-server": "No game server is set up for this mode right now.",
  "no-capacity": "Every game server is busy.",
  "launch-failed": "The game server could not be started.",
  "ready-timeout": "The game server did not start in time.",
  "heartbeat-timeout": "The game server stopped responding.",
  "process-exited": "The game server stopped.",
  "server-restarted": "The game server restarted.",
  "server-dropped-match": "The game server ended the match unexpectedly.",
  "match-timeout": "The match ran too long without a result.",
  "no-players": "Nobody was left to play.",
  "backend-restart": "The match was lost when the matchmaking server restarted."
};
const messageFor = (reason) => MESSAGES[reason] || (String(reason).startsWith("server-aborted") ? "The game server could not run the match." : "The match could not go on.");

class SharedMatches {
  // deps (server.js): liveSocket(id), usernameOf(id), setPresence(id, state, extra), partyLeader(partyId),
  //   launch(socket, playlistId, map, shared) -> { rankedId, rankedMode }, requeue(userID, playlistId) -> bool,
  //   fail(ids, reason, message, playlistId), voidRanked(userID, rankedMode, rankedId), pay(userID, ctx) -> summary,
  //   contestants(map), mapIndex(map), matchUrl(playlistId, map), backendUrl(), playlist(id), log(...).
  constructor({ cfg, deps, dataDir, now = Date.now, allocator = null }) {
    this.cfg = cfg;
    this.deps = deps;
    this.now = now;
    this.log = deps.log || (() => {});
    this.matches = new Map();      // matchId -> record (allocating, running)
    this.byUser = new Map();       // userID -> matchId (while allocating or running)
    this.finished = new Map();     // matchId -> { at, state } (results / cancels, for idempotency)
    this.requeues = new Map();     // userID -> times re-queued after a failed allocation
    this.notices = new Map();      // userID -> [notice] for their next login
    this.counters = { matches: 0, ready: 0, results: 0, cancelled: 0, allocationFailed: 0, requeued: 0, clientResultsIgnored: 0,
      ticketsAccepted: 0, ticketsRefused: 0 };
    this.seenSignatures = new Map();
    this.allowed = new Set();
    if (!cfg.enabled) { this.allocator = null; this.tickets = null; return; }
    for (const id of cfg.playlists) {
      const p = deps.playlist(id);
      if (!p || p.id !== id) this.log("shared matches: unknown playlist", id, "ignored");
      else if (p.kind === "showdown") this.log("shared matches: Showdown is never shared (paused):", id, "ignored");
      else if (!p.enabled) this.log("shared matches: playlist", id, "is disabled, ignored");
      else this.allowed.add(id);
    }
    const master = loadSecret(cfg.gameServerSecret, path.join(dataDir, "gameserver-secret.txt"));
    const ticketSecret = loadSecret(cfg.ticketSecret, path.join(dataDir, "ticket-secret.txt"));
    this.allocator = allocator || new Allocator({ pool: cfg.pool, launch: cfg.launch, maxMatches: cfg.maxMatches, master,
      readyTimeoutMs: cfg.readyTimeoutMs, heartbeatMs: cfg.heartbeatMs, heartbeatTimeoutMs: cfg.heartbeatTimeoutMs,
      maxMatchMs: cfg.maxMatchMs, backendUrl: deps.backendUrl, now,
      log: (o) => this.log("[gameserver]", JSON.stringify(o)) });
    this.tickets = new ConnectionTickets({ secret: ticketSecret, ttlMs: cfg.ticketTtlMs, now });
    this.allocator.on("ready", (matchId) => this.guard("ready", () => this.onReady(matchId)));
    this.allocator.on("lost", (matchId, reason) => this.guard("lost", () => this.onLost(matchId, reason)));
    if (!this.allocator.configured) this.log("shared matches: ON but no game server configured (CULLING_GAMESERVER_POOL or _COMMAND): every match stays local");
    this.log("shared matches: ON for", [...this.allowed].join(", ") || "no playlist", "| servers:", this.allocator.stats().mode,
      "max", this.allocator.maxMatches);
    // Running matches survive a backend restart (every deploy): their game
    // servers' next heartbeat takes them up again; any not heard from in time is cancelled.
    this.store = new CoalescedJsonFile(path.join(dataDir, "shared-matches.json"),
      () => JSON.stringify([...this.matches.values()].filter((r) => r.state === "running")), { delayMs: 0, now });
    this.restore(path.join(dataDir, "shared-matches.json"));
  }

  guard(what, fn) {
    try { return fn(); } catch (e) { this.log("shared match", what, "failed:", e && e.stack ? e.stack : e); return undefined; }
  }

  event(name, fields = {}) { this.log("[shared]", JSON.stringify(Object.assign({ event: "shared." + name }, fields))); }

  // ------------------------------------------------------------ settings

  // Whether a playlist's lobbies are played on a game server.
  applies(playlistId) { return !!this.allocator && this.allocator.configured && this.allowed.has(playlistId); }

  // A playlist's team size, number of teams and contestants on `map`.
  shape(playlistId, map) {
    const p = this.deps.playlist(playlistId);
    const teamSize = Math.max(1, p.teamSize || 1);
    const contestants = this.deps.contestants(map);
    const teamsCount = Math.floor(contestants / teamSize);
    return { teamSize, teamsCount, field: teamsCount * teamSize };
  }

  // The lobby options with shared playlists' sizes: a lobby holds what one
  // match holds (Trios 15), and a party joins only a lobby its team fits in.
  lobbyOptions(options) {
    if (!this.allowed.size || !this.applies([...this.allowed][0])) return options;
    const out = Object.assign({}, options);
    out.maxPlayers = Object.assign({}, typeof options.maxPlayers === "object" ? options.maxPlayers : { default: options.maxPlayers });
    const maps = options.maps && options.maps.length ? options.maps : [null];
    for (const id of this.allowed) out.maxPlayers[id] = Math.min(...maps.map((m) => this.shape(id, m).field));
    out.fits = (queue, existing, adding) => !this.applies(queue) || this.fits(queue, existing, adding);
    return out;
  }

  fits(queue, existing, adding) {
    const { teamSize, teamsCount } = this.shape(queue, null);
    const groups = groupsOf(existing).concat(groupsOf(adding));
    return packTeams(groups, teamSize, teamsCount).overflow.length === 0;
  }

  // A party bigger than the team can't share a match (it would be split).
  checkParty(playlist, size) {
    if (!this.applies(playlist.id) || size <= playlist.teamSize) return { ok: true };
    return { error: "party-too-large", message: playlist.teamSize === 1
      ? playlist.name + " is every player for themselves: a party can't be one team. Queue Duos, Trios or Quads together."
      : playlist.name + " teams are " + playlist.teamSize + ": your party of " + size + " would be split." };
  }

  // The shared match a player is waiting on (allocating), or null.
  busy(userID) {
    const id = this.byUser.get(userID);
    const r = id ? this.matches.get(id) : null;
    return r && r.state === "allocating" ? r : null;
  }

  // ------------------------------------------------------------ a lobby's match

  start(lobby) {
    const d = this.deps;
    const playlistId = lobby.queue;
    const map = lobby.map || "jungle";
    const { teamSize, teamsCount, field } = this.shape(playlistId, map);
    let groups = groupsOf([...lobby.members.values()]);
    // A party is all or nothing: one gone since the countdown sends none of it.
    groups = groups.filter((g) => {
      const gone = g.ids.filter((id) => !d.liveSocket(id));
      if (!gone.length) return true;
      if (g.party) {
        d.fail(g.ids.filter((id) => !gone.includes(id)), "allocation-failed",
          gone.map((id) => d.usernameOf(id) || "A party member").join(", ") + " left before the match started: your party was not sent in.", playlistId);
      }
      return false;
    });
    if (!groups.length) return;
    const { teams, overflow } = packTeams(groups, teamSize, teamsCount);
    for (const g of overflow) this.retry(g, playlistId, "no-room");
    const matchId = crypto.randomBytes(8).toString("hex");
    const rec = { matchId, lobbyId: lobby.id, playlist: playlistId, map, mapIndex: d.mapIndex(map), teamSize, teamsCount, field,
      ranked: !!(d.playlist(playlistId) || {}).ranked, state: "allocating", createdAt: this.now(), readyAt: null,
      serverId: null, address: null, teams: teams.map((t) => ({ team: t.team, players: t.players.slice() })),
      groups: teams.flatMap((t) => t.groups.map((g) => ({ ids: g.ids.slice(), party: g.party, team: t.team }))),
      players: {}, matchUrl: d.matchUrl(playlistId, map), serverNonce: crypto.randomBytes(16).toString("hex") };
    for (const g of rec.groups) for (const id of g.ids) {
      rec.players[id] = { team: g.team, party: g.party, state: "allocating", rankedId: null, rankedMode: null, ticketId: null, joined: false };
    }
    if (!Object.keys(rec.players).length) return;
    this.matches.set(matchId, rec);
    for (const id of Object.keys(rec.players)) {
      this.byUser.set(id, matchId);
      d.setPresence(id, "lobby", { mode: playlistId });
      const s = d.liveSocket(id);
      if (s) s.emit("remaster-shared-match", { state: "allocating", matchId, playlist: playlistId, team: rec.players[id].team });
    }
    this.counters.matches++;
    this.event("allocating", { matchId, lobbyId: lobby.id, playlist: playlistId, map, players: Object.keys(rec.players).length,
      bots: this.botCount(rec), teams: rec.teams.filter((t) => t.players.length).map((t) => [t.team, t.players.length]) });
    const got = this.allocator.reserve(this.assignment(rec));
    if (got.error) return this.allocationFailed(rec, got.error);
    rec.serverId = got.serverId;
    rec.address = got.host + ":" + got.port;
  }

  botCount(rec) { return rec.field - Object.values(rec.players).filter((p) => p.state !== "dropped").length; }

  // What the game server is told (its register / heartbeat answers): the
  // match, map, mode, team layout (who is on which team, and the bots each
  // team gets) and the bot count. Players dropped before the start are left
  // out (their slots are bots).
  assignment(rec) {
    const d = this.deps;
    const inMatch = (id) => rec.players[id] && rec.players[id].state !== "dropped";
    const teams = rec.teams.map((t) => {
      const players = t.players.filter(inMatch);
      return { team: t.team, players: players.map((id) => ({ userID: id, username: d.usernameOf(id) || null, party: rec.players[id].party || null })),
        bots: rec.teamSize - players.length };
    });
    return { matchId: rec.matchId, playlist: rec.playlist, map: rec.map, mapIndex: rec.mapIndex, matchUrl: rec.matchUrl,
      teamSize: rec.teamSize, teamsCount: rec.teamsCount, field: rec.field, ranked: rec.ranked,
      players: teams.reduce((n, t) => n + t.players.length, 0), bots: this.botCount(rec), teams,
      ticketTtlMs: this.cfg.ticketTtlMs, startsWithFists: true, serverNonce: rec.serverNonce };
  }

  // The server is ready: every player still here is sent in (same address,
  // their own ticket). A party with a member gone is not sent (all or nothing).
  onReady(matchId) {
    const rec = this.matches.get(matchId);
    if (!rec || rec.state !== "allocating") return;
    const d = this.deps;
    rec.state = "running";
    rec.readyAt = this.now();
    this.counters.ready++;
    for (const g of rec.groups) {
      const gone = g.ids.filter((id) => rec.players[id].state === "dropped" || !d.liveSocket(id));
      if (gone.length) {
        const left = g.ids.filter((id) => rec.players[id].state !== "dropped" && !gone.includes(id));
        for (const id of g.ids) { rec.players[id].state = "dropped"; this.byUser.delete(id); }
        if (left.length) d.fail(left, "allocation-failed", gone.map((id) => d.usernameOf(id) || "A party member").join(", ")
          + " left before the match started: your party was not sent in.", rec.playlist);
        continue;
      }
      for (const id of g.ids) {
        const pl = rec.players[id];
        const t = this.tickets.issue({ matchId, userID: id, team: pl.team, serverId: rec.serverId });
        pl.ticketId = t.id;
        pl.state = "sent";
        this.requeues.delete(id);
        let out;
        try {
          out = d.launch(d.liveSocket(id), rec.playlist, rec.map, { matchId, lobbyId: rec.lobbyId, partyId: g.party,
            gameServer: rec.address, nonce: t.token, serverNonce: rec.serverNonce, ticketId: t.id, team: pl.team,
            ticketExpiresInMs: t.expiresAt - this.now() }) || {};
        } catch (e) {
          // One player's match-ready failing never stops the others'.
          this.log("shared match", matchId, "sending", id, "failed:", e && e.stack ? e.stack : e);
          pl.state = "dropped";
          this.byUser.delete(id);
          d.fail([id], "allocation-failed", "The match could not be set up. Nobody was sent in: queue again.", rec.playlist);
          continue;
        }
        pl.rankedId = out.rankedId || null;
        pl.rankedMode = out.rankedMode || null;
      }
    }
    const sent = Object.keys(rec.players).filter((id) => rec.players[id].state === "sent");
    this.event("ready", { matchId, serverId: rec.serverId, address: rec.address, sent: sent.length, bots: this.botCount(rec) });
    if (!sent.length) return this.cancel(rec, "no-players");
    this.save();
  }

  onLost(matchId, reason) {
    const rec = this.matches.get(matchId);
    if (!rec) return;
    if (rec.state === "allocating") this.allocationFailed(rec, reason, true);
    else this.cancel(rec, reason, true);
  }

  // No server for the match: nobody was sent; every group is re-queued (up
  // to requeueMax times) or told.
  allocationFailed(rec, reason, released = false) {
    if (!released) this.allocator.release(rec.matchId, reason);
    this.matches.delete(rec.matchId);
    this.finished.set(rec.matchId, { at: this.now(), state: "allocation-failed" });
    this.counters.allocationFailed++;
    this.event("allocation-failed", { matchId: rec.matchId, reason });
    for (const g of rec.groups) {
      const ids = g.ids.filter((id) => rec.players[id].state !== "dropped");
      for (const id of ids) this.byUser.delete(id);
      if (ids.length) this.retry({ ids, party: g.party }, rec.playlist, reason);
    }
  }

  // A group back in the queue, if it may be (and everyone is still here); otherwise told.
  retry(g, playlistId, reason) {
    const d = this.deps;
    const n = Math.max(0, ...g.ids.map((id) => this.requeues.get(id) || 0));
    const message = messageFor(reason);
    for (const id of g.ids) d.setPresence(id, "menu");
    if (n < this.cfg.requeueMax && g.ids.every((id) => d.liveSocket(id))) {
      for (const id of g.ids) {
        this.requeues.set(id, n + 1);
        d.liveSocket(id).emit("remaster-shared-match", { state: "requeued", reason, message: message + " Searching again.", playlist: playlistId });
      }
      const leader = g.party ? d.partyLeader(g.party) : g.ids[0];
      const ok = d.requeue(g.ids.includes(leader) ? leader : g.ids[0], playlistId);
      this.counters.requeued++;
      this.event("requeued", { ids: g.ids.length, party: !!g.party, playlist: playlistId, reason, attempt: n + 1, ok });
      if (ok) return;
    }
    for (const id of g.ids) this.requeues.delete(id);
    d.fail(g.ids, "allocation-failed", message + " Nobody was sent in: queue again.", playlistId);
  }

  // A match that had started is over without a result: tickets revoked,
  // ranked voided, everyone told and (in the menu) re-queued.
  cancel(rec, reason, released = false) {
    const d = this.deps;
    if (!released) this.allocator.release(rec.matchId, reason);
    rec.state = "cancelled";
    this.matches.delete(rec.matchId);
    this.finished.set(rec.matchId, { at: this.now(), state: "cancelled" });
    this.tickets.revokeMatch(rec.matchId);
    this.counters.cancelled++;
    this.event("cancelled", { matchId: rec.matchId, serverId: rec.serverId, reason });
    const message = messageFor(reason);
    for (const g of rec.groups) {
      const ids = g.ids.filter((id) => rec.players[id].state === "sent");
      if (!ids.length) continue;
      for (const id of ids) {
        const pl = rec.players[id];
        if (pl.rankedId) d.voidRanked(id, pl.rankedMode, pl.rankedId);
        this.byUser.delete(id);
        d.setPresence(id, "menu");
      }
      const online = ids.every((id) => d.liveSocket(id));
      const requeue = this.cfg.requeueOnCancel && online && reason !== "no-players";
      const notice = { state: "cancelled", matchId: rec.matchId, reason, message: message + (requeue ? " Searching again." : " Nothing was counted: queue again."),
        playlist: rec.playlist, requeued: requeue };
      for (const id of ids) {
        const s = d.liveSocket(id);
        if (s) s.emit("remaster-shared-match", notice); else this.notify(id, notice);
      }
      if (requeue) {
        const leader = g.party ? d.partyLeader(g.party) : ids[0];
        d.requeue(ids.includes(leader) ? leader : ids[0], rec.playlist);
        this.counters.requeued++;
      }
    }
    this.save();
  }

  // A player cancels (leave-mm) or disconnects while their match is being set
  // up: their group (the whole party) is taken out; nobody else is affected.
  // Once sent in, a disconnect is expected (the client is joining the server).
  leave(userID, why) {
    const rec = this.busy(userID);
    if (!rec) return false;
    const d = this.deps;
    const g = rec.groups.find((x) => x.ids.includes(userID));
    const ids = g.ids.filter((id) => rec.players[id].state !== "dropped");
    for (const id of ids) { rec.players[id].state = "dropped"; this.byUser.delete(id); d.setPresence(id, "menu"); }
    const name = d.usernameOf(userID) || "A party member";
    for (const id of ids) {
      if (id === userID) continue;
      const s = d.liveSocket(id);
      if (s) s.emit("leave-mm-group", { reason: why === "disconnected" ? "party-member-disconnected" : "party-member-cancelled",
        message: name + (why === "disconnected" ? " disconnected" : " cancelled the search") + ": your party left the match." });
    }
    this.event("left", { matchId: rec.matchId, ids: ids.length, why });
    if (!Object.values(rec.players).some((p) => p.state !== "dropped")) {
      this.matches.delete(rec.matchId);
      this.finished.set(rec.matchId, { at: this.now(), state: "abandoned" });
      this.allocator.release(rec.matchId, "no-players");
    }
    return true;
  }

  notify(userID, notice) {
    const list = this.notices.get(userID) || [];
    list.push(Object.assign({ at: this.now() }, notice));
    while (list.length > 5) list.shift();
    this.notices.set(userID, list);
  }

  // At login: what happened to their shared matches while they were away.
  deliverNotices(socket) {
    const list = this.notices.get(socket.userID);
    if (!list) return;
    this.notices.delete(socket.userID);
    for (const n of list) socket.emit("remaster-shared-match", n);
  }

  // ------------------------------------------------------------ results

  // The game server's result for the whole match: every player paid and
  // rated from it. Returns { status, json }.
  result(serverId, body) {
    const matchId = typeof body.matchId === "string" ? body.matchId : "";
    if (this.finished.has(matchId) && this.finished.get(matchId).state === "finished") return { status: 409, json: { error: "already-reported" } };
    const rec = this.matches.get(matchId);
    if (!rec || rec.state !== "running" || rec.serverId !== serverId) return { status: 409, json: { error: "match-not-running" } };
    const v = this.validateResult(rec, body);
    if (v.error) { this.event("result-refused", { matchId, serverId, error: v.error }); return { status: 400, json: { error: v.error } }; }
    const d = this.deps;
    const elapsed = Math.max(0, (this.now() - rec.readyAt) / 1000);
    const paid = [], noShow = [];
    for (const [id, pl] of Object.entries(rec.players)) {
      if (pl.state !== "sent") continue;
      const r = v.byUser.get(id);
      const player = r ? Object.assign({ team: pl.team }, r, { teamPlacement: v.teamPlacement.get(pl.team) || rec.teamsCount, noShow: false })
        : { team: pl.team, placement: rec.field, teamPlacement: rec.teamsCount, kills: 0, damage: 0, timeAlive: 0, noShow: true };
      if (rec.teamSize === 1) player.teamPlacement = player.placement;
      if (r && r.joined === false) player.noShow = true;
      const summary = this.guard("pay " + id, () => d.pay(id, { matchId, playlist: rec.playlist, map: rec.map, teamSize: rec.teamSize,
        teamsCount: rec.teamsCount, field: rec.field, rankedId: pl.rankedId, rankedMode: pl.rankedMode, elapsed, player,
        teamOutcome: v.teamOutcome.get(pl.team) || null })) || { error: "pay-failed" };
      (player.noShow ? noShow : paid).push(id);
      this.byUser.delete(id);
      const msg = { state: "finished", matchId, playlist: rec.playlist, result: summary };
      const s = d.liveSocket(id);
      if (s) s.emit("remaster-shared-match", msg); else this.notify(id, msg);
    }
    rec.state = "finished";
    this.matches.delete(matchId);
    this.finished.set(matchId, { at: this.now(), state: "finished" });
    this.tickets.revokeMatch(matchId);
    this.allocator.release(matchId, "result");
    this.counters.results++;
    this.event("result", { matchId, serverId, paid: paid.length, noShow: noShow.length, ignored: v.ignored.length, seconds: Math.round(elapsed) });
    this.save();
    this.pruneFinished();
    return { status: 200, json: { ok: true, paid: paid.length, noShow, ignored: v.ignored } };
  }

  // Shape and sanity of a result. Unknown players are ignored (and listed);
  // a roster player missing is a no-show; placements outside the match are
  // refused; only one team (one player in Solo) can be first.
  validateResult(rec, body) {
    if (!Array.isArray(body.players) || body.players.length > 64) return { error: "invalid-players" };
    const byUser = new Map(), ignored = [];
    const n = (v, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(0, Number(v))) : 0);
    for (const x of body.players) {
      if (!x || typeof x.userID !== "string") return { error: "invalid-player" };
      const pl = rec.players[x.userID];
      if (!pl || pl.state !== "sent") { ignored.push(x.userID.slice(0, 64)); continue; }
      if (byUser.has(x.userID)) return { error: "duplicate-player" };
      const placement = parseInt(x.placement, 10);
      if (!Number.isInteger(placement) || placement < 1 || placement > rec.field) return { error: "invalid-placement" };
      if (x.team !== undefined && parseInt(x.team, 10) !== pl.team) this.event("team-mismatch", { matchId: rec.matchId, userID: x.userID, reported: x.team, assigned: pl.team });
      byUser.set(x.userID, { placement, kills: Math.floor(n(x.kills, rec.field - rec.teamSize)), damage: n(x.damage, 5000),
        timeAlive: n(x.timeAlive, 4 * 3600), joined: x.joined === undefined ? undefined : Boolean(x.joined) });
    }
    const teamPlacement = new Map(), teamOutcome = new Map();
    if (rec.teamSize > 1) {
      if (!Array.isArray(body.teams)) return { error: "invalid-teams" };
      for (const t of body.teams.slice(0, 64)) {
        const team = parseInt(t && t.team, 10), placement = parseInt(t && t.placement, 10);
        if (!Number.isInteger(team) || team < 1 || team > rec.teamsCount) return { error: "invalid-team" };
        if (!Number.isInteger(placement) || placement < 1 || placement > rec.teamsCount) return { error: "invalid-team-placement" };
        teamPlacement.set(team, placement);
        if (typeof t.outcome === "string" && /^(won|out|left)$/.test(t.outcome)) teamOutcome.set(team, t.outcome);
      }
      if ([...teamPlacement.values()].filter((p) => p === 1).length > 1) return { error: "two-winners" };
    } else if ([...byUser.values()].filter((r) => r.placement === 1).length > 1) {
      return { error: "two-winners" };
    }
    return { byUser, ignored, teamPlacement, teamOutcome };
  }

  // The HUD's /api/matchresult for a shared match: ignored (the game server's
  // result is the one that counts), logged.
  clientResult(claim) {
    this.counters.clientResultsIgnored++;
    this.event("client-result-ignored", { matchId: claim.ticket.matchId, userID: claim.ticket.userID });
    return { status: 202, json: { ignored: true, reason: "shared-match", matchId: claim.ticket.matchId,
      message: "This match's result comes from its game server." } };
  }

  pruneFinished() {
    const cutoff = this.now() - 3600 * 1000;
    for (const [id, f] of this.finished) if (f.at < cutoff) this.finished.delete(id);
    while (this.finished.size > 5000) this.finished.delete(this.finished.keys().next().value);
  }

  // ------------------------------------------------------------ game-server API

  // Signed request check: X-Culling-Server, X-Culling-Timestamp and
  // X-Culling-Signature = HMAC(secret, "<ts>.<action>.<raw body>"), the body
  // sent as text (not parsed as JSON before the check).
  authenticate(req, action) {
    const serverId = String(req.headers["x-culling-server"] || "");
    const ts = Number(req.headers["x-culling-timestamp"]);
    const sig = String(req.headers["x-culling-signature"] || "");
    if (!this.allocator.knows(serverId)) return { error: "unknown-server" };
    if (typeof req.body !== "string") return { error: "body-must-be-text" };
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > this.cfg.clockSkewMs) return { error: "stale-request" };
    if (!safeEqualHex(sig, sign(this.allocator.secretFor(serverId), ts, action, req.body))) return { error: "bad-signature" };
    if (this.seenSignatures.has(sig)) return { error: "replayed" };
    this.seenSignatures.set(sig, this.now());
    if (this.seenSignatures.size > 2000) {
      const cutoff = this.now() - 2 * this.cfg.clockSkewMs;
      for (const [s, at] of this.seenSignatures) { if (at >= cutoff) break; this.seenSignatures.delete(s); }
    }
    let body;
    try { body = JSON.parse(req.body || "{}"); } catch { return { error: "invalid-json" }; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid-json" };
    if (body.serverId !== undefined && body.serverId !== serverId) return { error: "server-mismatch" };
    return { serverId, body };
  }

  handle(action, serverId, body) {
    const a = this.allocator;
    const matchId = typeof body.matchId === "string" ? body.matchId : null;
    switch (action) {
      case "register": {
        const r = a.register(serverId, body);
        return r.error ? { status: 404, json: r } : { status: 200, json: this.current(r) };
      }
      case "heartbeat": {
        // A match persisted across a backend restart, still running on this server: taken up again.
        const rec = matchId ? this.matches.get(matchId) : null;
        if (rec && rec.state === "running" && rec.serverId === serverId && !a.owns(serverId, matchId)) {
          if (a.adopt(serverId, matchId, this.assignment(rec))) { rec.adopted = true; this.event("adopted", { matchId, serverId }); }
        }
        const r = a.heartbeat(serverId, body);
        return r.error ? { status: 404, json: r } : { status: 200, json: this.current(r) };
      }
      case "ready": {
        const r = a.ready(serverId, matchId);
        return r.error ? { status: 409, json: r } : { status: 200, json: r };
      }
      case "abort": {
        const r = a.abort(serverId, matchId, body.reason);
        return r.error ? { status: 409, json: r } : { status: 200, json: r };
      }
      case "verify-ticket": return this.verifyTicket(serverId, body);
      case "result": return this.result(serverId, body);
      default: return { status: 404, json: { error: "unknown-action" } };
    }
  }

  // An answer's assignment as it is now (players dropped since the
  // reservation are bots).
  current(r) {
    const rec = r.assignment ? this.matches.get(r.assignment.matchId) : null;
    if (rec) r.assignment = this.assignment(rec);
    return r;
  }

  // PreLogin: the game server asks whether a connection's ticket lets it in.
  verifyTicket(serverId, body) {
    const matchId = typeof body.matchId === "string" ? body.matchId : "";
    const rec = this.matches.get(matchId);
    const refuse = (error, extra = {}) => {
      this.counters.ticketsRefused++;
      this.event("ticket-refused", Object.assign({ matchId, serverId, error }, extra));
      return { status: 403, json: { ok: false, error } };
    };
    if (!rec || rec.state !== "running" || rec.serverId !== serverId) return refuse("match-not-running");
    const userID = typeof body.userID === "string" && body.userID ? body.userID : undefined;
    const v = this.tickets.verify(body.ticket, { matchId, serverId, userID });
    if (v.error) return refuse(v.error, { userID: v.claims ? v.claims.userID : userID });
    const pl = rec.players[v.claims.userID];
    if (!pl || pl.state !== "sent" || pl.ticketId !== v.claims.id) return refuse("not-in-match", { userID: v.claims.userID });
    pl.joined = true;
    this.counters.ticketsAccepted++;
    this.event("ticket-accepted", { matchId, serverId, userID: v.claims.userID, team: pl.team });
    return { status: 200, json: { ok: true, userID: v.claims.userID, username: this.deps.usernameOf(v.claims.userID) || null,
      team: pl.team, party: pl.party || null } };
  }

  // The routes: POST /api/gameserver/<action>, signed. Registered only when shared matches are on.
  routes(app) {
    if (!this.allocator) return;
    app.post("/api/gameserver/:action", (req, res) => {
      const action = String(req.params.action);
      if (!/^(register|heartbeat|ready|abort|verify-ticket|result)$/.test(action)) return res.status(404).json({ error: "unknown-action" });
      const auth = this.authenticate(req, action);
      if (auth.error) {
        this.event("request-refused", { action, serverId: String(req.headers["x-culling-server"] || "").slice(0, 40), error: auth.error });
        return res.status(401).json({ error: auth.error });
      }
      const out = this.guard(action, () => this.handle(action, auth.serverId, auth.body)) || { status: 500, json: { error: "failed" } };
      res.status(out.status).json(out.json);
    });
  }

  // ------------------------------------------------------------ persistence

  save() { if (this.store) this.store.markDirty(); }
  flushSync() { return this.store ? this.store.flushSync() : false; }

  restore(file) {
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    const cutoff = this.now() - this.cfg.maxMatchMs;
    for (const r of Array.isArray(saved) ? saved : []) {
      if (!r || typeof r.matchId !== "string" || r.state !== "running" || !r.players || !(r.readyAt >= cutoff)) continue;
      r.adopted = false;
      this.matches.set(r.matchId, r);
      if (r.serverId && r.address) {
        const i = r.address.lastIndexOf(":");
        this.allocator.expect(r.serverId, r.address.slice(0, i), parseInt(r.address.slice(i + 1), 10));
      }
      for (const [id, p] of Object.entries(r.players)) if (p.state === "sent") this.byUser.set(id, r.matchId);
    }
    if (!this.matches.size) return;
    this.event("restored", { matches: this.matches.size });
    // Not heard from by then: lost with the restart.
    const t = setTimeout(() => this.guard("restore", () => {
      for (const r of [...this.matches.values()]) {
        if (r.state !== "running" || r.adopted) continue;
        this.cancel(r, "backend-restart", true);
        this.allocator.forget(r.serverId);
      }
    }), this.cfg.heartbeatTimeoutMs * 2);
    if (t.unref) t.unref();
  }

  stats() {
    if (!this.allocator) return { enabled: false };
    let allocating = 0, running = 0;
    for (const r of this.matches.values()) { if (r.state === "allocating") allocating++; else if (r.state === "running") running++; }
    return { enabled: true, playlists: [...this.allowed], allocating, running, counters: Object.assign({}, this.counters),
      tickets: this.tickets.stats(), servers: this.allocator.stats() };
  }

  stop() { if (this.allocator) this.allocator.stop(); }
}

module.exports = { SharedMatches, config, packTeams, groupsOf, MESSAGES };
