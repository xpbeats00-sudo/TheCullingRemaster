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
        ("Learn the basics of The Culling", "Learn the basics of The Culling Remaster"),
    ]
    for old, new in replacements:
        assert old in html, old
        html = html.replace(old, new)
    html = add_ranked(html)
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
              <p>Climb nine ranks on placement, against bots.</p>
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
    make_logos()
    install_font()
    rebrand_html(args[1])
    if len(args) > 2:
        make_loading_screens(args[2])
    if "--skip-intro" not in sys.argv:
        make_intro(args[0])
