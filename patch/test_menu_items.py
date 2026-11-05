"""The main menu's FRIENDS and LEADERBOARD items (make_branding.add_friends,
add_leaderboard) on a stand-in page: added once, in order, with their scripts
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

if failures:
    for f in failures:
        print("FAIL", f)
    sys.exit(1)
print("ok    FRIENDS and LEADERBOARD menu items, once, in order%s"
      % ("" if os.path.exists(generated) else " (no generated FrontEnd.html: page check skipped)"))
