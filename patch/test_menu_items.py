"""The main menu's FRIENDS and LEADERBOARD items (make_branding.add_friends,
add_leaderboard) and the Play screen's TRIO and QUAD tiles (add_team_tiles) on
stand-in pages: added once, in order, with their scripts
after the main menu's, in the page's own line endings; running again changes
nothing. With the generated FrontEnd.html present, it is checked too.

usage: python test_menu_items.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_branding as mb  # noqa: E402

PAGE = """<ul>
          <li tabindex="0" data-push-screen="Lootbox">
            <div class="vertical-list-menu-item">CULL CRATES</div>
          </li>
          <li tabindex="0" data-push-screen="Profile" data-require-online="true">
            <div class="vertical-list-menu-item">PROFILE</div>
          </li>
          <li tabindex="0" data-push-screen="Leaderboard" data-require-online="true">
            <div class="vertical-list-menu-item">LEADERBOARDS</div>
          </li>
</ul>
  <script src="js/ClientWeb.js"></script>
  <script src="js/Screens/MainMenu.js"></script>
  <script src="js/Screens/Leaderboard.js"></script>
"""

failures = []


def check(ok, msg):
    if not ok:
        failures.append(msg)


def menu(html):
    return mb.add_leaderboard(mb.add_friends(html))


for nl in ("\n", "\r\n"):
    page = PAGE.replace("\n", nl)
    once = menu(page)
    check(menu(once) == once, "running again changes the page (%r)" % nl)
    check(once.count('id="remaster-friends-item"') == 1 and once.count('id="remaster-leaderboard-item"') == 1,
          "each item once (%r)" % nl)
    friends, board, profile = (once.index(s) for s in ('id="remaster-friends-item"', 'id="remaster-leaderboard-item"',
                                                       'data-push-screen="Profile"'))
    check(friends < board < profile, "FRIENDS, LEADERBOARD, PROFILE in that order (%r)" % nl)
    check(">\n              LEADERBOARD\n".replace("\n", nl) in once, "the LEADERBOARD label (%r)" % nl)
    check('<script src="js/Friends.js"></script>' + nl + '  <script src="js/Leaderboard.js"></script>' in once,
          "Leaderboard.js right after Friends.js (%r)" % nl)
    check(once.index("js/Screens/MainMenu.js") < once.index("js/Leaderboard.js"), "after the main menu's script (%r)" % nl)
    check(nl == "\r\n" or "\r" not in once, "line endings kept (%r)" % nl)
    check('data-push-screen="Leaderboard"' in once, "the stock item is left for CustomMatchSettings.js to remove (%r)" % nl)

generated = os.path.join(mb.UI, "FrontEnd.html")
if os.path.exists(generated):
    html = open(generated, "rb").read().decode("utf-8")
    check('id="remaster-leaderboard-item"' in html and "js/Leaderboard.js" in html,
          "the generated FrontEnd.html has no LEADERBOARD item: run make_branding.py --menu-only")
    check(menu(html) == html, "the generated FrontEnd.html is not up to date: run make_branding.py --menu-only")

# The Play screen's TRIO and QUAD tiles (make_branding.add_team_tiles).
PLAY = """        <ul>
          <li tabindex="0" class="play-duo-bg" id="duo_play" data-push-screen="ffa_jungle_coop2">
            <div class="play-title">
              <h1>DUO PLAY</h1>
            </div>
          </li>
          <li tabindex="0" class="play-showdown-bg" id="showdown_play">
          </li>
        </ul>
  <script src="js/Screens/Play.js"></script>
  <script src="js/Showdown.js"></script>
"""
for nl in ("\n", "\r\n"):
    page = PLAY.replace("\n", nl)
    once = mb.add_team_tiles(page)
    check(mb.add_team_tiles(once) == once, "team tiles: running again changes the page (%r)" % nl)
    ids = [once.index('id="%s"' % i) for i in ("duo_play", "trio_play", "quad_play", "showdown_play")]
    check(ids == sorted(ids) and once.count('id="trio_play"') == 1 and once.count('id="quad_play"') == 1,
          "DUO, TRIO, QUAD, SHOWDOWN once each, in order (%r)" % nl)
    check("<h1>TRIO PLAY</h1>" in once and "<h1>QUAD PLAY</h1>" in once, "the tiles' titles (%r)" % nl)
    for tile in ("trio_play", "quad_play"):
        at = once.index('id="%s"' % tile)
        block = once[at:once.index("</li>", at)]
        check("data-push-screen" not in block, "%s pushes no screen (Teams.js queues it)" % tile)
        check('class="play-duo-bg"' in once[at - 40:at], "%s uses the Duo art" % tile)
    check('<script src="js/Screens/Play.js"></script>' + nl + '  <script src="js/Teams.js"></script>' in once,
          "Teams.js right after the Play screen's script (%r)" % nl)
    check(nl == "\r\n" or "\r" not in once, "team tiles: line endings kept (%r)" % nl)
    check(nl == "\n" or once.count("\n") == once.count("\r\n"), "team tiles: CRLF kept (%r)" % nl)
teams_js = open(os.path.join(mb.UI, "js", "Teams.js"), encoding="utf-8").read()
for tile, queue in (("trio_play", "ffa_jungle_coop3"), ("quad_play", "ffa_jungle_coop4")):
    check('%s: "%s"' % (tile, queue) in teams_js, "Teams.js queues %s for %s" % (queue, tile))
if os.path.exists(generated):
    html = open(generated, "rb").read().decode("utf-8")
    check(mb.add_team_tiles(html) == html,
          "the generated FrontEnd.html has no TRIO/QUAD tiles: run make_branding.py --menu-only")

if failures:
    for f in failures:
        print("FAIL", f)
    sys.exit(1)
print("ok    TRIO and QUAD tiles after DUO, queued by Teams.js, once, in the page's line endings")
print("ok    FRIENDS and LEADERBOARD menu items, once, in order%s"
      % ("" if os.path.exists(generated) else " (no generated FrontEnd.html: page check skipped)"))
