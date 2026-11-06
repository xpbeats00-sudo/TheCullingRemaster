"""The autotest's scenarios (what run.py starts) and their checks.

A scenario is a playlist the stand-in menu queues (menu.js), the native
module's scenario (?RemasterAutoTest=<name>, autotest.c) and the checks run on
what the match wrote (results.jsonl), what the HUD showed (the probe's
"ui-trace AT|..." lines) and what the server logged.

Each check returns (name, ok, evidence); evidence is a short string of the
values the verdict rests on.
"""
import json
import math
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))


class Run:
    """What one scenario's match left behind."""

    def __init__(self, events, server_lines, crashes, exit_info):
        self.events = events                    # results.jsonl, parsed
        self.server = server_lines              # the server log lines of this run
        self.crashes = crashes                  # new crash report folders
        self.exit = exit_info                   # {"quit": bool, "killed": bool, "code": int|None, "seconds": float}
        self.probe = probe_messages(server_lines)

    def ev(self, name):
        return [e for e in self.events if e.get("ev") == name]

    def hud(self, prefix):
        return [e["msg"] for e in self.ev("hud") if e.get("msg", "").startswith(prefix)]

    def probe_of(self, tag):
        return [p for t, p in self.probe if t == tag]

    def lines(self, pattern):
        return [ln for ln in self.server if re.search(pattern, ln)]


def probe_messages(lines):
    """[(tag, text)] from the probe's "ui-trace AT|<tag>|<id>|<i>/<n>|<part>" lines, parts joined."""
    parts, order = {}, []
    for ln in lines:
        m = re.search(r"ui-trace AT\|([a-z]+)\|(\d+)\|(\d+)/(\d+)\|(.*)$", ln)
        if not m:
            continue
        tag, mid, i, n, text = m.group(1), m.group(2), int(m.group(3)), int(m.group(4)), m.group(5)
        key = (tag, mid)
        if key not in parts:
            parts[key] = [None] * n
            order.append(key)
        if i < len(parts[key]):
            parts[key][i] = text
    return [(k[0], "".join(p or "" for p in parts[k])) for k in order]


def ok(name, cond, evidence):
    return (name, bool(cond), evidence)


def first(lst, default=None):
    return lst[0] if lst else default


def jsons(texts):
    out = []
    for t in texts:
        try:
            out.append(json.loads(t))
        except ValueError:
            pass
    return out


# ---------------------------------------------------------------- shared checks

def ran(r, name):
    """The match started with the scenario, ended by the scenario's own quit, no crash."""
    start = first(r.ev("start"))
    quit_ = first(r.ev("quit"))
    return [ok(name + ": scenario ran in game", start is not None,
               "start %s, url %s" % (start and start.get("scenario"), start and start.get("url", "")[:140])),
            ok(name + ": quit through the console command, no crash", quit_ is not None and not r.crashes and not r.exit["killed"],
               "quit %r after %.0f s, exit code %s, crash reports %d, killed %s"
               % (quit_ and quit_.get("why"), r.exit["seconds"], r.exit["code"], len(r.crashes), r.exit["killed"]))]


def teams_check(r, name, size, nteams):
    t = first(r.ev("teams"))
    if not t:
        return [ok(name + ": teams by TeamNumber", False, "no teams snapshot")]
    byteam = {int(k): v[0] for k, v in t["byteam"].items()}
    sizes = sorted(byteam.values())
    good = len(byteam) == nteams and all(v == size for v in sizes) and min(byteam) >= 1 and t["mates"] == size - 1
    return [ok(name + ": %d teams of %d by TeamNumber, %d mates" % (nteams, size, size - 1), good,
               "%d fighters, teams %s, my team %s, my mates %d" % (t["fighters"], dict(sorted(byteam.items())),
                                                                    t["myteam"], t["mates"]))]


def pods_check(r, name, want):
    """release-next 452b07e: one contestant a start, bots with only their fists, as the pods open."""
    # The last look while the pods are closed (everyone in their pod), and the opening.
    closed = [e for e in r.ev("pods") if e["contestants"] == max(x["contestants"] for x in r.ev("pods"))] if r.ev("pods") else []
    pods = closed[-1] if closed else {}
    ev = first(r.ev("pods_open")) or pods
    if not ev:
        return [ok(name + ": pods: one contestant each, %d contestants, bots with fists only" % want, False, "no pods event")]
    return [ok(name + ": %d contestants (BotsToSpawn capped at the mode's free starts)" % want, ev["contestants"] == want,
               "%d contestants at InProgress second %s; the mode's starts %s, BotsToSpawn %s"
               % (ev["contestants"], ev.get("el"), ev.get("starts"), ev.get("bots_to_spawn"))),
            ok(name + ": in the pods no two contestants are within 150 units",
               pods.get("contestants") == want and pods.get("closest", -1) >= 150,
               "pods closed: %s contestants, closest %s apart (%s team %s at %s, %s team %s at %s); 1 s after opening: closest %s (%s, %s)"
               % (pods.get("contestants"), pods.get("closest"), pods.get("a_name"), pods.get("a_team"), pods.get("a_at"),
                  pods.get("b_name"), pods.get("b_team"), pods.get("b_at"), ev.get("closest"), ev.get("a_name"), ev.get("b_name"))),
            ok(name + ": the start chooser was given team 0 in a team mode (fix 12), the stock team otherwise",
               spawn_ok(r), spawn_summary(r)),
            ok(name + ": no bot has a weapon besides its fists", ev["bots_armed"] == 0,
               "%d bots armed%s" % (ev["bots_armed"], (": " + ", ".join(ev["armed"])) if ev["armed"] else ""))]


def spawn_summary(r):
    sp = r.ev("spawn_team")
    if not sp:
        return "no spawn_team events"
    f = sp[0]
    teams = ",".join("%s:%d->%d" % (e["name"][:10], e["team"], e["given"]) for e in sp[:20])
    return ("%d chooser calls; flags bPairTeams %s, bSpawnPairTogether %s, bSpawnPairBalanced %s; team map entries %s; "
            "name:team at spawn->given %s" % (len(sp), f["pair_teams"], f["pair_together"], f["pair_balanced"],
                                               sorted({e["team_starts"] for e in sp}), teams))


def spawn_ok(r):
    sp = r.ev("spawn_team")
    start = first(r.ev("start"), {})
    if not sp:
        return False
    if start.get("mode") == 2:
        return all(e["given"] == 0 for e in sp) and all(e["team_starts"] == 0 for e in sp)
    return all(e["given"] == e["team"] for e in sp)


def board_check(r, name, want=16):
    st = r.ev("state") + r.ev("teams")
    boards = [(e["board"], e["sorted"]) for e in st if e.get("el", 0) >= 5]
    full = [b for b in boards if b[0] == want and b[1] == want]
    return [ok(name + ": scoreboard has all %d entries (RoundScoreboardData and the sorted board)" % want, full,
               "board/sorted counts seen: %s" % sorted(set(boards))[:6])]


def tms_check(r, name, mates):
    if mates < 2:
        msgs = r.hud("TMS|")
        return [ok(name + ": no TMS| line (Duo: the game's own panel shows the one teammate)", not msgs,
                   "%d TMS lines" % len(msgs))]
    msgs = r.hud("TMS|")
    want = "TMS|%d|" % (mates - 1)
    got = [m for m in msgs if m.startswith(want)]
    probe = [p for p in r.probe_of("msg") if p.startswith("TMS|")]
    pages = jsons(r.probe_of("page"))
    stacked = max([p.get("extraShown", 0) for p in pages] or [0])
    return [ok(name + ": TMS| line for the %d teammates beyond the game's panel" % (mates - 1), got,
               "%d TMS lines, first %r" % (len(msgs), first(msgs, "")[:90])),
            ok(name + ": HUD got TMS| and stacked %d extra panels" % (mates - 1), probe and stacked == mates - 1,
               "probe TMS messages %d, extra panels shown at most %d" % (len(probe), stacked))]


def win_check(r, name, ranked_mode=None, field=None):
    end = first(r.ev("end"))
    results = jsons(r.probe_of("result"))
    res = first(results, {})
    body = res.get("body", {})
    posted = r.lines(r"match result \S+ \{")
    out = [ok(name + ": the match ended with the team's win", end is not None and res.get("victory") is True,
              "end at el %s; HUD result victory=%s rawRank=%s placement=%s" % (end and end.get("el"), res.get("victory"),
                                                                             res.get("rawRank"), body.get("placement"))),
           ok(name + ": victory posted, placement 1", posted and '"victory":true' in posted[-1] and body.get("placement") == 1,
              (posted[-1][-160:] if posted else "no 'match result' line") + "; posted placement %s" % body.get("placement"))]
    if ranked_mode:
        rr = r.lines(r"ranked result %s " % ranked_mode)
        m = re.search(r"place (\d+)/(\d+)", rr[-1]) if rr else None
        out.append(ok(name + ": ranked %s scored place 1 of %s" % (ranked_mode, field),
                      m and m.group(1) == "1" and int(m.group(2)) == field,
                      rr[-1][-140:] if rr else "no 'ranked result %s' line (%s)" % (ranked_mode, "; ".join(r.lines("ranked")[-2:]))))
    return out


def no_teamkill_check(r, name):
    deaths = r.ev("death")
    mates = [d for d in deaths if d.get("mate") and not d.get("pc")]
    return [ok(name + ": no teammate died to the wipe", not mates, "%d deaths, %d of them teammates" % (len(deaths), len(mates)))]


# ---------------------------------------------------------------- scenarios

def check_teamwin(r, name, size, nteams, ranked_mode=None):
    contestants = size * nteams if size > 1 else 16
    c = ran(r, name) + board_check(r, name, contestants) + pods_check(r, name, contestants)
    if size > 1:
        c += teams_check(r, name, size, nteams) + tms_check(r, name, size - 1)
    c += win_check(r, name, ranked_mode, nteams if size > 1 else 16)
    return c


def check_teamout(r, name, size, nteams, ranked_mode):
    """Your death first, then your teammates': the HUD holds your result until the team is out."""
    c = ran(r, name) + teams_check(r, name, size, nteams)
    before = first(r.ev("before_my_death"), {})
    deaths = jsons(r.probe_of("death"))
    results = jsons(r.probe_of("result"))
    res = first(results, {})
    raw = res.get("rawRank")
    alive = before.get("alive")
    teams_alive = sum(1 for k, v in before.get("byteam", {}).items() if v[1] > 0) if before else None
    rr = r.lines(r"ranked result %s " % ranked_mode)
    m = re.search(r"place (\d+)/(\d+)", rr[-1]) if rr else None
    personal = isinstance(raw, int) and alive is not None and raw == alive
    team_place = isinstance(raw, int) and teams_alive is not None and raw == teams_alive
    kind = "personal (contestants alive at your death)" if personal else "team place" if team_place else "neither"
    c.append(ok(name + ": result held until the team was out, posted once as 'out'",
                res and res.get("body", {}).get("teamOutcome") == "out" and len(results) == 1,
                "HUD results %d, teamOutcome %s" % (len(results), res.get("body", {}).get("teamOutcome"))))
    c.append(ok(name + ": the game's Rank at your death is %s" % kind, personal or team_place,
                "raw Rank %s; contestants alive just before %s, teams alive %s; death screen Rank %s"
                % (raw, alive, teams_alive, [d.get("Rank") for d in deaths])))
    want = None
    if isinstance(raw, int) and raw >= 1:
        want = min(nteams, max(2, math.ceil(raw / size))) if personal else min(nteams, max(2, raw))
    c.append(ok(name + ": ranked %s scored team place %s of %d" % (ranked_mode, want, nteams),
                m and want is not None and int(m.group(1)) == want and int(m.group(2)) == nteams,
                rr[-1][-140:] if rr else "no 'ranked result %s' line (%s)" % (ranked_mode, "; ".join(r.lines("ranked|match result")[-2:]))))
    return c


def check_solodeath(r, name):
    c = ran(r, name)
    before = first(r.ev("before_my_death"), {})
    res = first(jsons(r.probe_of("result")), {})
    raw = res.get("rawRank")
    alive = before.get("alive")
    rr = r.lines(r"ranked result solo ")
    m = re.search(r"place (\d+)/(\d+)", rr[-1]) if rr else None
    c.append(ok(name + ": Solo death Rank is your position (contestants alive at your death)", raw == alive,
                "raw Rank %s, alive just before your death %s" % (raw, alive)))
    c.append(ok(name + ": ranked solo scored that position", m and raw and int(m.group(1)) == min(16, max(2, raw)),
                rr[-1][-140:] if rr else "no ranked result line"))
    return c


def check_sd(r, name, size):
    c = ran(r, name)
    starts = r.hud("SDR|S|")
    ends = r.hud("SDR|E|")
    over = r.hud("SDR|O|")
    kits = {}
    for m in starts:
        f = m.split("|")
        kits[int(f[2])] = int(f[5])
    c.append(ok(name + ": SDR| round messages, first to 4 (W L W W W: 4-1)", over and over[-1].split("|")[3:6] == ["4", "1", "W"],
                "S %d, E %d, O %s; results %s" % (len(starts), len(ends), over[-1:] if over else None,
                                                  [m.split("|")[5] for m in ends + over])))
    pairs = all(kits.get(a) == kits.get(b) for a, b in ((1, 2), (3, 4)) if a in kits and b in kits)
    rot = all(kits.get(a) != kits.get(b) for a, b in ((2, 3), (4, 5)) if a in kits and b in kits)
    c.append(ok(name + ": kit changes every 2 rounds", len(kits) >= 5 and pairs and rot, "kit by round %s" % kits))
    same = True
    detail = []
    for k in r.ev("kit"):
        detail.append((k["round"], k["pc"], k["team"], tuple(sorted(k["items"]))))
    by_round = {}
    for rnd, pc, team, items in detail:
        by_round.setdefault(rnd, set()).add(items)
    for rnd, sets in by_round.items():
        if len(sets) != 1:
            same = False
    weapons = {rnd: sorted(next(iter(s))) for rnd, s in by_round.items() if len(s) == 1}
    c.append(ok(name + ": every fighter has the same kit in a round", by_round and same,
                "; ".join("r%d %s" % (k, ",".join(w for w in v if "Fists" not in w)[:80]) for k, v in sorted(weapons.items()))
                if same else "differs: %s" % {k: [list(x) for x in v] for k, v in by_round.items() if len(v) != 1}))
    # Sides: team 1 (or you) west at x -1800, the others east, side by side, nobody stacked.
    bad, seen = [], 0
    for s in r.ev("sides"):
        f = s["f"]
        seen += 1
        pts = [(x, y) for _t, _pc, x, y, _z in f]
        for team, pc, x, y, z in f:
            west = (team == 1) if size > 1 else bool(pc)
            if abs(x - (-1800 if west else 1800)) > 60:
                bad.append("round %d team %d pc %d at (%.0f, %.0f)" % (s["round"], team, pc, x, y))
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                if math.dist(pts[i], pts[j]) < 100:
                    bad.append("round %d: two fighters %.0f apart" % (s["round"], math.dist(pts[i], pts[j])))
        if len(f) != 2 * size:
            bad.append("round %d: %d fighters" % (s["round"], len(f)))
    c.append(ok(name + ": sides west/east every round, %d a side, no stacking" % size, seen >= 4 and not bad,
                "%d rounds placed; %s" % (seen, "; ".join(bad[:4]) or "all within 60 of x=+-1800, 160 apart")))
    paid = r.lines(r"showdown series paid")
    rounds = r.lines(r"showdown round ")
    c.append(ok(name + ": server recorded the rounds and paid the series once", len(paid) == 1,
                "%d 'showdown round' lines, paid: %s" % (len(rounds), paid[-1][-120:] if paid else "none")))
    if size > 1:
        pages = jsons(r.probe_of("page"))
        down = [p for p in pages if "YOU ARE DOWN" in p.get("banner", "")]
        # Before the series is over (the victory or defeat at its end shows the screen, as it should).
        before_end = []
        for tag, text in r.probe:
            if tag == "victory" or (tag == "msg" and text.startswith("SDR|O|")):
                break
            if tag == "page":
                before_end += jsons([text])
        early_screen = [p for p in before_end if p.get("deathScreen")]
        mid = [e for e in r.ev("before_my_death")]
        c.append(ok(name + ": your death mid-round: no death screen, 'YOU ARE DOWN'", down and not early_screen,
                    "my death with %s alive; banners %s; death screen shown %s"
                    % ([m.get("byteam") for m in mid][:1], sorted({p.get("banner", "")[:40] for p in pages if p.get("banner")})[:3],
                       bool(early_screen))))
        # A team wipe ends the round, one down doesn't: round 2's end came only after the last mate died.
        e2 = [e for e in r.ev("hud") if e.get("msg", "").startswith("SDR|E|2|")]
        kills2 = [k for k in r.ev("kill") if k.get("why") in ("me", "mate")]
        c.append(ok(name + ": round 2 ended only at the team wipe",
                    e2 and len(kills2) == size and e2[0]["ms"] >= kills2[-1]["ms"] and e2[0]["ms"] > kills2[0]["ms"],
                    "my/mate kills at %s ms, SDR|E|2 at %s ms" % ([k["ms"] for k in kills2], e2 and e2[0]["ms"])))
    return c


def check_choke(r, name):
    c = ran(r, name)
    ch = first(r.ev("chokening"), {})
    deaths = r.ev("death")
    victims = {v["slot"]: v.get("name") for v in r.ev("victim")}
    me = first([x for x in first(r.ev("teams"), {}).get("roster", []) if x[2] == 1], [None])[0]
    rivals = [d for d in deaths if d["name"] in [victims.get(i) for i in range(3)]]
    mate = [d for d in deaths if d["name"] == victims.get(3)]
    gas = r.ev("gas")
    c.append(ok(name + ": pylons started the Chokening's way and recorded", ch.get("started", 0) > 0 and ch.get("recorded", 0) >= ch.get("started", 1),
                "pylons %s, started %s, recorded by the module %s" % (ch.get("pylons"), ch.get("started"), ch.get("recorded"))))
    credited = [d for d in rivals if d.get("killer") == me]
    c.append(ok(name + ": gas kills of rivals credited to the activator (KillerName, kill count)",
                rivals and len(credited) == len(rivals) and (rivals[-1]["my_kills"] - ch.get("my_kills", 0)) >= len(credited),
                "me %r; rival deaths %s; my kills %s -> %s" % (me, [(d["name"], d["killer"]) for d in rivals],
                                                              ch.get("my_kills"), rivals[-1]["my_kills"] if rivals else None)))
    c.append(ok(name + ": the teammate's gas death not credited to the activator",
                mate and mate[0].get("killer") != me,
                "teammate %r: %s; gas answers %s" % (victims.get(3), [(d["killer"], d["my_kills"]) for d in mate],
                                                    sorted({g["answer"] for g in gas}))))
    return c


def check_unstick(r, name):
    c = ran(r, name)
    for t in (0, 1):
        place = first([p for p in r.ev("place") if p["try"] == t], {})
        un = first([u for u in r.ev("unstuck") if u["try"] == t])
        stuck = [s for s in r.ev("stuck") if s["try"] == t]
        modes = sorted({s["mode"] for s in stuck})
        c.append(ok(name + ": pawn put in the elm fork (try %d, z %s) is moved to a free spot within 3 s" % (t + 1, place.get("at", [0, 0, 0])[2]),
                    un is not None and un["dt"] <= 3500,
                    "placed %s -> %s (ok %s); unstuck after %s ms at %s; movement modes while stuck %s, accel %s"
                    % (place.get("from"), place.get("at"), place.get("ok"), un and un["dt"], un and un["at"], modes,
                       sorted({round(s["accel"]) for s in stuck})[:3])))
    return c


def check_night(r, name):
    c = ran(r, name)
    last = max([e.get("el", 0) for e in r.events] or [0])
    w = r.ev("weather")
    c.append(ok(name + ": night map ran 10+ minutes InProgress without a crash", last >= 600 and not r.crashes,
                "last InProgress second %d, weather samples %d (rain levels %s), crash reports %d"
                % (last, len(w), sorted({x["rain"] for x in w}), len(r.crashes))))
    return c


def check_bots(r, name):
    import make_bot_ai
    tier = make_bot_ai.TIERS[make_bot_ai.DEFAULT_TIER]
    c = ran(r, name)
    ws = r.ev("ws")
    names = {e["s"]: e.get("debug", "") for e in r.ev("state_name")}
    label = {}
    for s, d in names.items():
        m = re.search(r"EWeaponState::(\w+)|State[:=\s]+(\w+)", d)
        label[s] = (m.group(1) or m.group(2)) if m else str(s)
    weapon = {}
    spans = []                       # (bot, state, held ms, weapon, start pos, end pos)
    prev_pos = {}
    for e in ws:
        b = e["bot"]
        if "weapon" in e:
            weapon[b] = e["weapon"]
        if e["prev"] >= 0 and b in prev_pos:
            spans.append((b, e["prev"], e["held"], weapon.get(b, ""), prev_pos[b], e["at"]))
        prev_pos[b] = e["at"]

    def named(word):
        return [s for s, n in label.items() if word.lower() in n.lower()]
    block = named("block")
    charge = named("charg")
    held_block = [s[2] for s in spans if s[1] in block]
    melee_charge = [s[2] for s in spans if s[1] in charge and "bow" not in s[3].lower()]
    bow = [s for s in spans if s[1] in charge and "bow" in s[3].lower()]
    moved = [math.dist(s[4][:2], s[5][:2]) for s in bow]
    gaps = [s[2] for s in spans if s[2] > 0]
    c.append(ok(name + ": weapon states sampled every frame (%d bots, %d changes)" % (len({e["bot"] for e in ws}), len(ws)),
                len(ws) > 50, "state names: %s" % {k: v for k, v in sorted(label.items())}))
    hold = tier.get("block_hold") or tier.get("block") or None
    c.append(ok(name + ": block held about the tier's time", held_block and (hold is None or abs(statistics.median(held_block) / 1000 - float(hold if not isinstance(hold, (list, tuple)) else hold[0])) <= 0.6),
                "%d blocks, median %.2f s (tier %s: %s)" % (len(held_block), statistics.median(held_block) / 1000 if held_block else 0,
                                                            make_bot_ai.DEFAULT_TIER, hold)))
    c.append(ok(name + ": no state held under the tier's minimum decision interval",
                gaps and statistics.median(gaps) >= 100,
                "%d state spans, median %.0f ms, shortest 5 %s" % (len(gaps), statistics.median(gaps) if gaps else 0, sorted(gaps)[:5])))
    c.append(ok(name + ": melee charge held within the tier's range", melee_charge,
                "%d melee charges, median %.2f s" % (len(melee_charge), statistics.median(melee_charge) / 1000 if melee_charge else 0)))
    c.append(ok(name + ": archers hold position while drawing", bow and statistics.median(moved) < 100,
                "%d bow draws, moved median %.0f, max %.0f units during the draw" % (len(bow), statistics.median(moved) if moved else 0,
                                                                                   max(moved) if moved else 0)))
    return c


# name, queue the menu sends, the module's scenario, timeout (s), check
SCENARIOS = [
    # The pods only (InProgress seconds 0-2), then quit.
    ("pods_solo", "ffa_jungle", "pods", 240, lambda r: ran(r, "Solo pods") + pods_check(r, "Solo pods", 16)),
    ("pods_prison", "ffa_prison", "pods", 240, lambda r: ran(r, "Prison pods") + pods_check(r, "Prison pods", 16)),
    ("pods_duo", "coop2_jungle", "pods", 240, lambda r: ran(r, "Duo pods") + pods_check(r, "Duo pods", 16)),
    ("pods_trio", "coop3_jungle", "pods", 240, lambda r: ran(r, "Trios pods") + pods_check(r, "Trios pods", 15)),
    ("pods_quad", "coop4_jungle", "pods", 240, lambda r: ran(r, "Quads pods") + pods_check(r, "Quads pods", 16)),
    # Jungle and Prison have 16 starts (SpawnsDecentral): 16 contestants, 15 in Trios (5 whole trios).
    ("quads_win", "coop4_jungle", "teamwin", 420, lambda r: check_teamwin(r, "Quads", 4, 4) + no_teamkill_check(r, "Quads")),
    ("trios_win", "coop3_jungle", "teamwin", 420, lambda r: check_teamwin(r, "Trios", 3, 5) + no_teamkill_check(r, "Trios")),
    ("duo_win", "coop2_jungle", "teamwin", 420, lambda r: check_teamwin(r, "Duo", 2, 8) + no_teamkill_check(r, "Duo")),
    ("sd_1v1", "showdown", "sd", 420, lambda r: check_sd(r, "Showdown 1v1", 1)),
    ("sd_2v2", "showdown_duo", "sd", 420, lambda r: check_sd(r, "Showdown 2v2", 2)),
    ("sd_3v3", "showdown_trio", "sd", 420, lambda r: check_sd(r, "Showdown 3v3", 3)),
    ("sd_4v4", "showdown_quad", "sd", 420, lambda r: check_sd(r, "Showdown 4v4", 4)),
    ("ranked_solo_win", "ranked_ffa_jungle", "teamwin", 420, lambda r: check_teamwin(r, "Ranked Solo", 1, 16, "solo")),
    ("ranked_solo_death", "ranked_ffa_jungle", "solodeath", 420,
     lambda r: check_solodeath(r, "Ranked Solo death") + pods_check(r, "Ranked Solo death", 16)),
    ("ranked_duo_out", "ranked_coop2_jungle", "teamout", 420, lambda r: check_teamout(r, "Ranked Duo", 2, 8, "duo")),
    ("ranked_trio_win", "ranked_coop3_jungle", "teamwin", 420, lambda r: check_teamwin(r, "Ranked Trio", 3, 5, "trio")),
    ("ranked_quad_out", "ranked_coop4_jungle", "teamout", 420, lambda r: check_teamout(r, "Ranked Quads", 4, 4, "quad")),
    ("chokening", "coop2_jungle", "choke", 420, lambda r: check_choke(r, "Chokening")),
    ("unstick", "ffa_prison", "unstick", 300, lambda r: check_unstick(r, "Unstick") + pods_check(r, "Prison Solo", 16)),
    ("bots", "ffa_jungle", "bots", 400, lambda r: check_bots(r, "Smarter opponents")),
    ("night", "ffa_jungle_night", "night", 1080, lambda r: check_night(r, "Night weather")),
]
