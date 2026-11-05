"""The Culling Remaster branding.

- Menu logos: patch/branding/remaster_logo_source.png (on black) keyed to a
  transparent background at the game's two logo sizes, into src/ for the pak.
- FrontEnd.html: "The Culling" -> "The Culling Remaster" in visible text.
- Menu font: Creepster (SIL OFL, Google Fonts; a drippy horror face in the
  spirit of Massacre) for the main menu items and screen titles, shipped in
  uiresources/fonts next to the game's own fonts; body text keeps Sucrose.
- Startup movie: the Xaviant logo (5.5-8.9 s of LoadingScreen.mp4) replaced
  by patch/branding/xp_mask_source.png fading in and out; the Unreal Engine
  logo, middleware credits and audio are kept. The original movie is saved
  once as patch/branding/originals/LoadingScreen.mp4.

usage: python make_branding.py <game root (TheCulling)> <extracted uiresources FrontEnd.html>
       python make_branding.py --menu-only [generated FrontEnd.html]
"""
import os
import shutil
import subprocess
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.join(HERE, "branding")
UI = os.path.join(HERE, "src", "Victory", "Content", "uiresources", "FrontEnd")
FONTS = os.path.join(HERE, "src", "Victory", "Content", "uiresources", "fonts")
HORROR_FONT = os.path.join(BRAND, "download_creepster", "Creepster-Regular.ttf")
REMASTER_CSS = """/* The Culling Remaster: horror display font for menu items and titles. */
@font-face { font-family: Creepster; src: url('../../fonts/Creepster-Regular.ttf'); }

#main-menu-options .vertical-list-menu-item {
  font: 2.5vw Creepster;
  letter-spacing: 0.15vw;
  color: rgba(204, 0, 0, 1);
}
/* The stock hover rule (#main-menu-options.vertical-list-menu li:hover ...)
   outranks a plain id selector and forces red; match it and insist. */
#main-menu-options.vertical-list-menu li:focus .vertical-list-menu-item,
#main-menu-options.vertical-list-menu li:hover .vertical-list-menu-item {
  font: 2.9vw Creepster !important;
  color: rgba(245, 245, 245, 1) !important;
}
/* Main menu: no build-version label; the Remaster logo larger and lower
   (the full-size image, so it stays sharp). */
.build-version { display: none; }
.culling-logo { width: 22%; margin-top: 2.2vw; }
/* Customization: no boxed panel behind the buttons; small rounded buttons.
   (The game's own sheet is injected after this one, hence !important.) */
#cust-purchase-equip-container {
  background-color: transparent !important;
  outline: none !important;
}
#cust-purchase-button, #cust-equip-button, #cust-purchase-bundle-button, #cust-purchase-need-currency {
  width: 12vw !important;
  height: 5vh !important;
  margin-bottom: 1.2vw !important;
  font-size: 1.3vw !important;
  outline: none !important;
  border: 2px solid rgba(170, 170, 170, 0.9);
  border-radius: 2.5vh;
  background-color: rgba(10, 10, 10, 0.55) !important;
}
#cust-purchase-button:hover, #cust-equip-button:hover, #cust-purchase-bundle-button:hover, #cust-purchase-need-currency:hover {
  outline: none !important;
  border-color: rgba(204, 0, 0, 1);
  background: rgba(120, 0, 0, 0.35) !important;
  box-shadow: 0 0 18px rgba(204, 0, 0, 0.9) !important;
}
/* Rounded corners everywhere (the game draws square boxes). Art sits in
   backgrounds, so a modest radius only trims corner pixels, never content.
   Square outlines can't follow a radius in Coherent: they become rings drawn
   with box-shadow. */
.tiled-menu-options-container ul li,
.play-tiled-menu-options-container ul li {
  border-radius: 1.2vw;
}
.tiled-menu-options-container li .play-title,
.play-tiled-menu-options-container li .play-title {
  border-radius: 0 0 1.2vw 1.2vw;
}
#perks-root-menu-options li,
.perks-list-content li,
#airdrop-preview-container li,
.perks-root-perkpreview,
.local-culling-card-container,
.culling-card-container,
.player-premium-container,
.player-cullcredits-container {
  border-radius: 0.9vw;
}
.vertical-list-menu-item,
.active-preview-item {
  border-radius: 0.6vw;
}
#controls-footer .button-tooltip.clickable {
  outline: none !important;
  border-radius: 0.6vw;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 1);
}
#controls-footer .button-tooltip.clickable:hover,
#controls-footer .button-tooltip.clickable:focus,
#controls-footer .button-tooltip.clickable:active {
  outline: none !important;
  box-shadow: 0 0 0 2px rgba(204, 0, 0, 1);
}
.player-premium-container:hover {
  outline: none !important;
}
/* No news strip at the bottom of the menus (the dark bar and its text);
   the online indicator stays. */
#status-bar-container, .status-bar-text-container {
  background: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
}
#news-text { display: none !important; }
/* Ranked Solo (RankedUI.js, make_ranked.py art). */
#play-menu .play-ranked-bg { background-image: url("../images/RankedPlay.png"); background-repeat: no-repeat; background-size: 100% 100%; }
.play-tiled-menu-options-container ul li.play-ranked-bg:focus,
.play-tiled-menu-options-container ul li.play-ranked-bg:hover { background-image: url("../images/RankedPlay_sel.png") !important; }
#ranked-menu-options li.ranked-teams-bg { display: none; }
/* Player card: level, rank emblem, name. */
#player-card .culling-card .card-rank-emblem { width: 2.6vw; height: 2.6vw; margin: 0 0.6vw 0 0; align-self: center;
  flex: 0 0 auto; pointer-events: all; }
#player-card .culling-card .left-column { width: 16%; }
#player-card .culling-card .right-column { width: auto; flex: 1 1 auto; }
#player-card .culling-card .player-name { width: auto; }
/* One panel: the card, with your credits in a slim strip under it; party
   members' cards follow (Friends.js). The token currency isn't used. */
#player-card, #player-card .player-card-container { height: auto; justify-content: flex-start; }
#player-card .player-card-container { border-radius: 0.9vw; background: rgba(10, 8, 10, 0.82);
  box-shadow: 0 0 0 0.12vw rgba(255, 255, 255, 0.12), 0 0.8vh 2vh rgba(0, 0, 0, 0.5); }
#player-card .local-culling-card-container { border-radius: 0.9vw 0.9vw 0 0; }
#player-card .player-premium-container { display: none; }
#player-card .culling-cash-container, #player-card .culling-cash { width: 24.06vw; height: 2.2vw; margin-top: 0; }
#player-card .culling-cash { justify-content: flex-end; }
#player-card .player-cullcredits-container { width: auto; height: 2.2vw; margin: 0; padding: 0 0.9vw;
  background: transparent; border-radius: 0; }
#player-card .culling-cash .player-currency-icon { width: 1.3vw; height: 1.3vw; margin-right: 0.35vw; }
#player-card .culling-cash .player-cash { height: 1.3vw; font-size: 1.3vw; line-height: 1.3vw; padding-top: 0; }
.rb-bar { width: 8vw; height: 0.45vh; margin-top: 0.4vh; border-radius: 0.3vh; background: rgba(255, 255, 255, 0.18); overflow: hidden; }
.rb-bar div { height: 100%; background: rgba(204, 0, 0, 1); }
#ranked-panel { position: absolute; left: 6vw; right: 6vw; bottom: 9vh; padding: 1.6vh 1.6vw; border-radius: 1.4vh;
  background: rgba(6, 6, 10, 0.78); color: white; font-family: Sucrose-Regular; }
#ranked-panel .rp-head { display: flex; align-items: center; }
#ranked-panel .rp-head img { width: 8vw; height: 8vw; margin-right: 1.4vw; }
#ranked-panel .rp-season { font: 0.85vw Sucrose-Bold; opacity: 0.75; letter-spacing: 0.08vw; }
#ranked-panel .rp-tier { font: 3vw Creepster; letter-spacing: 0.15vw; color: rgba(230, 230, 230, 1); }
#ranked-panel .rp-elo { font: 1.4vw Sucrose-Bold; }
#ranked-panel .rp-elo small { font: 0.85vw Sucrose-Regular; opacity: 0.7; margin-left: 0.6vw; }
#ranked-panel .rb-bar { width: 22vw; height: 0.7vh; }
#ranked-panel .rp-stats { font-size: 0.85vw; opacity: 0.75; margin-top: 0.6vh; }
#ranked-panel .rp-cols { display: flex; margin-top: 1.2vh; }
#ranked-panel .rp-cols > div { flex: 1; margin-right: 2vw; }
#ranked-panel h3 { font: 0.95vw Sucrose-Bold; margin: 0 0 0.5vh 0; color: rgba(204, 0, 0, 1); }
#ranked-panel ul { list-style: none; margin: 0; padding: 0; }
#ranked-panel .rp-recent li { display: flex; justify-content: space-between; width: 14vw; font-size: 0.9vw; }
#ranked-panel .rp-tiers { display: flex; flex-wrap: wrap; }
#ranked-panel .rp-tiers li { display: flex; align-items: center; width: 33%; font-size: 0.75vw; opacity: 0.55; margin-bottom: 0.4vh; }
#ranked-panel .rp-tiers li.reached { opacity: 1; }
#ranked-panel .rp-tiers img { width: 1.8vw; height: 1.8vw; margin-right: 0.4vw; }
#ranked-panel .rp-tiers em { font-style: normal; opacity: 0.7; margin-left: 0.4vw; }
#ranked-panel .rp-note { font-size: 0.75vw; opacity: 0.6; margin: 1vh 0 0 0; }
.menu-content > h1 {
  font: 4.6vw Creepster;
  letter-spacing: 0.25vw;
  line-height: 1;
  color: rgba(240, 240, 240, 1);
}
/* Play screen: five tiles (Solo, Ranked, Duo, Showdown, Custom) in the stock
   19:25 shape, titles in the Remaster face; Showdown art from
   make_showdown_tile.py. */
.play-tiled-menu-options-container ul li { width: 16vw; height: 21vw; }
.play-tiled-menu-options-container ul:first-child li { margin-left: 0.6vw; margin-right: 0.6vw; }
#play-menu .play-title h1 { font: 2.3vw Creepster; letter-spacing: 0.15vw; color: rgba(240, 240, 240, 1); }
#play-menu li:focus .play-title h1, #play-menu li:hover .play-title h1 { color: rgba(255, 70, 60, 1); }
#play-menu .play-showdown-bg { background-image: url("../images/ShowdownPlay.png"); background-repeat: no-repeat; background-size: 100% 100%; }
.play-tiled-menu-options-container ul li.play-showdown-bg:focus,
.play-tiled-menu-options-container ul li.play-showdown-bg:hover { background-image: url("../images/ShowdownPlay_sel.png") !important; }
/* Airdrops that unlock by level (make_airdrop_unlocks.py): the level beside the
   lock, and on the preview. */
#airdrop-menu-options .airdrop-unlock-level { font: 1.1vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.08vw;
  color: rgba(200, 200, 200, 0.85); white-space: nowrap; align-self: center; margin-left: auto; padding-right: 0.4vw; }
#airdrop-preview-container .airdrop-unlock-note { font: 1.2vw Sucrose-Bold, Arial, sans-serif; letter-spacing: 0.1vw;
  color: rgba(255, 70, 60, 1); margin: -0.4vw 0 0.8vw 20px; }
"""
LOGO_SIZES = {"cullinglogo.png": (857, 290), "cullinglogo_sm.png": (343, 116)}
XAVIANT = (5.5, 8.9)           # seconds of the Xaviant logo in LoadingScreen.mp4
MASK_HEIGHT = 560


def key_black(im):
    """Black background -> transparent, keeping anti-aliased edges clean."""
    im = im.convert("RGB")
    out = Image.new("RGBA", im.size)
    src, dst = im.load(), out.load()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            r, g, b = src[x, y]
            m = max(r, g, b)
            a = max(0, min(255, (m - 12) * 3))
            if a == 0:
                dst[x, y] = (0, 0, 0, 0)
            else:
                k = 255.0 / m
                dst[x, y] = (min(255, int(r * k)), min(255, int(g * k)), min(255, int(b * k)), a)
    return out


def make_logos():
    os.makedirs(os.path.join(UI, "images"), exist_ok=True)
    logo = key_black(Image.open(os.path.join(BRAND, "remaster_logo_source.png")))
    for name, size in LOGO_SIZES.items():
        logo.resize(size, Image.LANCZOS).save(os.path.join(UI, "images", name))
        print("logo", name, size)


def rebrand_html(src_html):
    html = open(src_html, "rb").read().decode("utf-8")
    link = '<link rel="stylesheet" type="text/css" href="css/Remaster.css">'
    if link not in html:
        assert "</head>" in html
        html = html.replace("</head>", "  " + link + "\n</head>", 1)
    replacements = [
        ("<h2>The Culling</h2>", "<h2>The Culling Remaster</h2>"),
        ('<img src="images/cullinglogo_sm.png" class="culling-logo"/>', '<img src="images/cullinglogo.png" class="culling-logo"/>'),
        # animated calling cards (make_calling_cards.py)
        ('<script src="js/Formatters.js"></script>',
         '<script src="js/Formatters.js"></script>\n  <script src="js/AnimatedCards.js"></script>'
         '\n  <script src="js/UiTrace.js"></script>'),   # menu-freeze breadcrumbs
        ('<script src="js/FrontEnd.js"></script>',      # card art fallback (make_card_image_map.py)
         '<script src="js/FrontEnd.js"></script>\n  <script src="js/CardImageMap.js"></script>'
         '\n  <script src="js/CardImages.js"></script>'),
        ("The Culling's weapons and items.", "The Culling Remaster's weapons and items."),
        # Menus never say the other contestants are bots.
        ("Play a practice match against Bots of questionable skill.", "Play a practice match."),
        ("Play a practice match against Bots of questionable skill in the Jungle.", "Play a practice match in the Jungle."),
        ("Play a practice match against Bots of questionable skill in the Prison.", "Play a practice match in the Prison."),
        ("Learn the basics of The Culling", "Learn the basics of The Culling Remaster"),
    ]
    for old, new in replacements:
        assert old in html, old
        html = html.replace(old, new)
    html = add_ranked(html)
    html = add_play_screen(html)
    html = add_airdrop_unlocks(html)
    html = show_survival(html)
    html = add_friends(html)
    html = add_leaderboard(html)
    open(os.path.join(UI, "FrontEnd.html"), "wb").write(html.encode("utf-8"))
    print("FrontEnd.html rebranded")


def install_font():
    os.makedirs(FONTS, exist_ok=True)
    shutil.copy2(HORROR_FONT, os.path.join(FONTS, "Creepster-Regular.ttf"))
    shutil.copy2(os.path.join(os.path.dirname(HORROR_FONT), "OFL.txt"), os.path.join(FONTS, "Creepster-OFL.txt"))
    os.makedirs(os.path.join(UI, "css"), exist_ok=True)
    open(os.path.join(UI, "css", "Remaster.css"), "w").write(REMASTER_CSS)
    print("font Creepster installed")


RANKED_TILE = """          <li tabindex="0" class="play-ranked-bg" id="ranked_play" data-push-screen="Ranked">
            <div class="tiledhighlighttopcontainer">
              <div class="tiledhighlighttop"></div>
            </div>
            <div class="tiled-menu-rollover">
              <p>Climb nine ranks on placement.</p>
            </div>
            <div class="play-title">
              <h1>RANKED</h1>
            </div>
            <div class="tiledhighlightbottomcontainer">
              <div class="tiledhighlightbottom"></div>
            </div>
          </li>
"""


def add_ranked(html):
    """Ranked Solo: a RANKED tile on the Play screen, the Ranked screen's
    free-for-all tile renamed (Teams is hidden by CSS: a future playlist),
    and the ranked UI script after the Ranked screen's."""
    duo = '<li tabindex="0" class="play-duo-bg" id="duo_play" data-push-screen="ffa_jungle_coop2">'
    assert html.count(duo) == 1
    html = html.replace(duo, RANKED_TILE.lstrip() + "          " + duo)
    start = html.index('<li tabindex="0" class="ranked-ffa-bg" data-queue="ffa">')
    end = html.index("</li>", start)
    block = (html[start:end].replace("<h1>FREE FOR ALL</h1>", "<h1>RANKED SOLO</h1>")
             .replace("<p>Solo queue for a Free For All match.</p>",
                      "<p>Solo free-for-all. Rating moves on placement, never kills.</p>"))
    html = html[:start] + block + html[end:]
    tag = '<script src="js/Screens/Ranked.js"></script>'
    assert html.count(tag) == 1
    # The matchmaking lobby panel (MatchLobby.js) loads here too: after ClientWeb.js.
    return html.replace(tag, tag + '\n  <script src="js/RankedUI.js"></script>'
                        '\n  <script src="js/MatchLobby.js"></script>')


SHOWDOWN_TILE = """          <li tabindex="0" class="play-showdown-bg" id="showdown_play">
            <div class="tiledhighlighttopcontainer">
              <div class="tiledhighlighttop"></div>
            </div>
            <div class="tiled-menu-rollover">
              <p>1v1 in the centre arena. Fight before the gas closes in.</p>
            </div>
            <div class="play-title">
              <h1>SHOWDOWN</h1>
            </div>
            <div class="tiledhighlightbottomcontainer">
              <div class="tiledhighlightbottom"></div>
            </div>
          </li>
"""
PLAY_TEXT = {
    "solo_play": "Free-for-all. Vote for Jungle or Prison in the lobby.",
    "duo_play": "Fight in pairs with a teammate. Vote for Jungle or Prison in the lobby.",
    "showdown_play": "1v1 in the centre arena. Fight before the gas closes in.",
}
# Queues the SHOWDOWN tile (the stock Play screen only queues Solo and Duo).
SHOWDOWN_SCRIPT = '<script src="js/Showdown.js"></script>'


def add_play_screen(html):
    """The Play screen: tile descriptions that say what each mode is, and a
    SHOWDOWN tile before CUSTOM, queued by js/Showdown.js (make_showdown.py).
    Safe to run on a page that already has it."""
    if 'id="showdown_play"' not in html:
        custom = '<li tabindex="0" data-push-screen="Custom" class="play-custom-bg"'
        assert html.count(custom) == 1
        html = html.replace(custom, SHOWDOWN_TILE.lstrip() + "          " + custom)
    if SHOWDOWN_SCRIPT not in html:
        play = '<script src="js/Screens/Play.js"></script>'
        assert html.count(play) == 1
        html = html.replace(play, play + "\n  " + SHOWDOWN_SCRIPT)
    for tile_id, text in PLAY_TEXT.items():
        start = html.index('id="%s"' % tile_id)
        end = html.index("</li>", start)
        block = html[start:end]
        old = block[block.index("<p>"):block.index("</p>") + 4]
        html = html[:start] + block.replace(old, "<p>%s</p>" % text) + html[end:]
    return html


AIRDROP_LOCK = '<div class="lock-icon" rv-hide="airdrop.bIsUnlocked"></div>'
AIRDROP_LEVEL = '<div class="airdrop-unlock-level" rv-hide="airdrop.bIsUnlocked">{airdrop.ItemID | airdropUnlockText}</div>'
AIRDROP_TITLE = '<h1>{screenData.PreviewAirdrop.DisplayName} <span>{screenData.PreviewAirdrop.Cost}</span></h1>'
AIRDROP_NOTE = ('<p class="airdrop-unlock-note" rv-hide="screenData.PreviewAirdrop.bIsUnlocked">'
                '{screenData.PreviewAirdrop.ItemID | airdropUnlockNote}</p>')


def add_airdrop_unlocks(html):
    """The Airdrop screen: the level that unlocks each locked airdrop beside its
    lock and under the preview's title (js/AirdropUnlocks.js, loaded before the
    screen binds). Safe to run on a page that already has it."""
    if "AirdropUnlocks.js" in html:
        return html
    for old, new in [(AIRDROP_LOCK, AIRDROP_LEVEL + "\n              " + AIRDROP_LOCK),
                     (AIRDROP_TITLE, AIRDROP_TITLE + "\n          " + AIRDROP_NOTE),
                     ('<script src="js/Screens/Airdrop.js"></script>',
                      '<script src="js/AirdropUnlocks.js"></script>\n  <script src="js/Screens/Airdrop.js"></script>')]:
        assert html.count(old) == 1, old
        html = html.replace(old, new)
    return html


SURVIVAL_ITEM = """          <li tabindex="0" rv-unless="Matchmaking.IsMatchmaking" data-push-screen="Training">
            <div class="vertical-list-menu-item" >
              SURVIVAL
            </div>
          </li>
"""


SURVIVAL_HIDDEN = "          <!-- SURVIVAL: Duo and Showdown use its match slots (make_duo.py)"


def show_survival(html):
    """The main menu's SURVIVAL item (Survival, Training Range, Offline Match,
    Basic Tutorial) is shown: Duo and Showdown open their own URLs
    (make_duo.py), so its match slots are free. Undoes the hiding an older
    build left in a generated page; safe to run again."""
    nl = "\r\n" if "\r\n" in html else "\n"
    item = SURVIVAL_ITEM.replace("\n", nl)
    hidden = SURVIVAL_HIDDEN + nl + item + "          -->" + nl
    if hidden in html:
        html = html.replace(hidden, item)
    assert html.count(item) == 1, "SURVIVAL menu item"
    return html


FRIENDS_ITEM = """          <li tabindex="0" id="remaster-friends-item">
            <div class="vertical-list-menu-item">
              FRIENDS
            </div>
          </li>
"""
FRIENDS_SCRIPT = '<script src="js/Friends.js"></script>'


def add_friends(html):
    """Friends, parties and player cards (js/Friends.js): a FRIENDS item on the
    main menu before PROFILE, the footer's Invite button labelled Friends (it
    opens the same panel), and the script after the main menu's. Safe to run on a
    page that already has it."""
    nl = "\r\n" if "\r\n" in html else "\n"
    if 'id="remaster-friends-item"' not in html:
        profile = '          <li tabindex="0" data-push-screen="Profile"'
        assert html.count(profile) == 1, "PROFILE menu item"
        html = html.replace(profile, FRIENDS_ITEM.replace("\n", nl) + profile)
    html = html.replace('<span class="control-text">Invite Player</span>', '<span class="control-text">Friends</span>')
    if FRIENDS_SCRIPT not in html:
        menu = '<script src="js/Screens/MainMenu.js"></script>'     # after ClientWeb.js and the menu screens
        assert html.count(menu) == 1, menu
        html = html.replace(menu, menu + nl + "  " + FRIENDS_SCRIPT)
    return html


LEADERBOARD_ITEM = """          <li tabindex="0" id="remaster-leaderboard-item">
            <div class="vertical-list-menu-item">
              LEADERBOARD
            </div>
          </li>
"""
LEADERBOARD_SCRIPT = '<script src="js/Leaderboard.js"></script>'


def add_leaderboard(html):
    """The global leaderboard (js/Leaderboard.js): a LEADERBOARD item on the
    main menu after FRIENDS, and the script after Friends.js (it opens player
    cards from it). The stock LEADERBOARDS item (data-push-screen="Leaderboard",
    only your own match history) stays hidden: CustomMatchSettings.js removes
    it. Safe to run on a page that already has it."""
    nl = "\r\n" if "\r\n" in html else "\n"
    if 'id="remaster-leaderboard-item"' not in html:
        friends = FRIENDS_ITEM.replace("\n", nl)
        assert html.count(friends) == 1, "FRIENDS menu item"
        html = html.replace(friends, friends + LEADERBOARD_ITEM.replace("\n", nl))
    if LEADERBOARD_SCRIPT not in html:
        assert html.count(FRIENDS_SCRIPT) == 1, FRIENDS_SCRIPT
        html = html.replace(FRIENDS_SCRIPT, FRIENDS_SCRIPT + nl + "  " + LEADERBOARD_SCRIPT)
    return html


def apply_menu_changes(path):
    """--menu-only: the friends menu, the leaderboard and the SURVIVAL item
    applied to an already generated FrontEnd.html in place (no logos, fonts or
    movies). Safe to repeat."""
    html = open(path, "rb").read().decode("utf-8")
    html = show_survival(html)
    html = add_friends(html)
    html = add_leaderboard(html)
    open(path, "wb").write(html.encode("utf-8"))
    print(path, "updated")


def make_intro(game_root):
    movie = os.path.join(game_root, "Victory", "Content", "Movies", "LoadingScreen.mp4")
    original = os.path.join(BRAND, "originals", "LoadingScreen.mp4")
    os.makedirs(os.path.dirname(original), exist_ok=True)
    if not os.path.exists(original):
        shutil.copy2(movie, original)
    start, end = XAVIANT
    length = end - start
    fade = 0.6
    graph = (
        "[1:v]scale=-1:%d,format=rgba,"
        "fade=t=in:st=0:d=%s:alpha=1,fade=t=out:st=%s:d=%s:alpha=1,"
        "setpts=PTS+%s/TB[mask];"
        "[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(t,%s,%s)'[bg];"
        "[bg][mask]overlay=(W-w)/2:(H-h)/2:eof_action=pass:enable='between(t,%s,%s)',format=yuv420p[v]"
    ) % (MASK_HEIGHT, fade, length - fade, fade, start, start - 0.05, end + 0.05, start, end)
    tmp = movie + ".new.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-i", original,
        "-loop", "1", "-t", str(length), "-i", os.path.join(BRAND, "xp_mask_source.png"),
        "-filter_complex", graph, "-map", "[v]", "-map", "0:a",
        "-c:v", "libx264", "-profile:v", "main", "-preset", "slow", "-crf", "18", "-r", "30",
        "-c:a", "copy", "-movflags", "+faststart", tmp,
    ], check=True)
    os.replace(tmp, movie)
    print("intro movie written:", movie)


LOADING_SCREENS = ("LS_FrontEnd", "LoadScreen")     # the two "THE CULLING" loading images
PRESENTER_FONT = "C:/Windows/Fonts/impact.ttf"


def make_loading_screens(paks_dir):
    """Rebuild the branded loading screens: original art darkened and blurred,
    the Remaster logo on top, 'PRESENTED BY' and the XP mask below."""
    from PIL import ImageDraw, ImageEnhance, ImageFilter, ImageFont
    sys.path.insert(0, HERE)
    from patch_assets import find_in_paks
    import ue_texture

    rel = {n: "Victory/Content/UI/LoadingScreens/%s.uasset" % n for n in LOADING_SCREENS}
    originals = find_in_paks(paks_dir, set(rel.values()))
    logo = key_black(Image.open(os.path.join(BRAND, "remaster_logo_source.png")))
    mask = key_black(Image.open(os.path.join(BRAND, "xp_mask_source.png")))
    font = ImageFont.truetype(PRESENTER_FONT, 46)

    for name, path in rel.items():
        data = originals[path]
        art = ue_texture.decode(data).filter(ImageFilter.GaussianBlur(7))
        art = ImageEnhance.Brightness(art).enhance(0.4).convert("RGBA")
        # Remaster logo where the old title sat (upper middle).
        lw = 1040
        lg = logo.resize((lw, int(lw * logo.size[1] / logo.size[0])), Image.LANCZOS)
        art.alpha_composite(lg, ((1920 - lw) // 2, 120))
        # "PRESENTED BY" + XP mask.
        draw = ImageDraw.Draw(art)
        text = "P R E S E N T E D   B Y"
        tw = draw.textlength(text, font=font)
        draw.text(((1920 - tw) / 2, 560), text, font=font, fill=(235, 235, 235, 255))
        mk = mask.resize((300, 300), Image.LANCZOS)
        art.alpha_composite(mk, ((1920 - 300) // 2, 630))
        art = art.convert("RGB")
        art.save(os.path.join(BRAND, "%s_preview.png" % name))
        out = os.path.join(HERE, "src", path)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, "wb").write(ue_texture.replace(data, art))
        print("loading screen", name)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--menu-only" in sys.argv:
        apply_menu_changes(args[0] if args else os.path.join(UI, "FrontEnd.html"))
        sys.exit(0)
    make_logos()
    install_font()
    rebrand_html(args[1])
    if len(args) > 2:
        make_loading_screens(args[2])
    if "--skip-intro" not in sys.argv:
        make_intro(args[0])
