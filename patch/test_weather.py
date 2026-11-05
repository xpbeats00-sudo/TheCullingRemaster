"""Checks the night / fog map variants (make_weather.py) against the stock paks.

Builds every variant into a temporary folder, then for each package:

- it parses and saves back byte-for-byte (ue_package.UPackage);
- it has the stock level's exports in the same order, and only the exports
  the weather edit is meant to touch differ (Lighting: sky material and sky
  actor, sun, sky light, fog, post-process volume, reflection captures;
  persistent level: the one Lighting streaming entry);
- each changed export's tagged properties walk cleanly to "None" and its
  native data after the tags (the reflection captures' cooked cubemaps,
  ~1 MB each) is the stock bytes;
- every import resolves: each /Game package it imports is in the paks (or is
  a generated variant) and holds an export of that name and class; /Script
  imports are ones the stock level already had;
- every streaming entry of the persistent level names a package that exists
  and a world inside it, and the Lighting entry names the variant's own
  Lighting level;
- the values read back as the preset says (sky, sun, sky light, fog
  visibility, exposure and grade with their bOverride_ flags, reflection
  brightness), and MAP_URLS opens the generated persistent levels.

With --pak <out.pak> it also writes the variants into a pak (make_pak.py)
and reads every file back out of it.

Not checked here (needs the game): that the maps load, how they look, the
frame rate.

usage: python test_weather.py <Paks dir> [--pak <out.pak>] [--override-pak <out.pak>]
"""
import math
import os
import re
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_pak  # noqa: E402
import make_weather as mw  # noqa: E402
from build_catalog import pak_entries, read_entry  # noqa: E402
from build_menu_arenas import iter_tags  # noqa: E402
from level_survey import export_props  # noqa: E402
from ue_package import UPackage  # noqa: E402
from uasset import Package  # noqa: E402

passed = 0
LIGHTING_CLASSES = {"MaterialInstanceDynamic", "BP_Victory_Sky_C", "BP_Victory_Sky2_C", "DirectionalLightComponent",
                    "SkyLightComponent", "ExponentialHeightFogComponent", "PostProcessVolume",
                    "BoxReflectionCaptureComponent", "SphereReflectionCaptureComponent"}


def ok(name):
    global passed
    passed += 1
    print("ok   " + name)


def check(cond, msg):
    if not cond:
        print("FAIL " + msg)
        sys.exit(1)


def close(a, b, tol=1e-4):
    return all(abs(x - y) <= tol * max(1.0, abs(y)) for x, y in zip(a, b))


# ---------------------------------------------------------------- the paks
class Paks:
    """Stock pak contents: the file list, and packages read on demand."""

    def __init__(self, paks_dir):
        self.where = {}
        for pak in sorted(os.listdir(paks_dir)):
            if not pak.endswith(".pak") or pak.startswith("LocalServer"):
                continue
            for f, name, off, usize, method, blocks in pak_entries(os.path.join(paks_dir, pak)):
                self.where[name.replace("../../../", "")] = (os.path.join(paks_dir, pak), off, usize, method, blocks)
        self.cache = {}

    def rel(self, game_path):
        """/Game/X/Y -> Victory/Content/X/Y.uasset or .umap present in the paks (or None)."""
        if game_path.startswith("/Game/"):
            base = "Victory/Content/" + game_path[len("/Game/"):]
        elif game_path.startswith("/Engine/"):
            base = "Engine/Content/" + game_path[len("/Engine/"):]
        else:
            return None
        for ext in (".uasset", ".umap"):
            if base + ext in self.where:
                return base + ext
        return None

    def read(self, rel):
        if rel not in self.cache:
            path, off, usize, method, blocks = self.where[rel]
            with open(path, "rb") as f:
                self.cache[rel] = read_entry(f, off, usize, method, blocks)
        return self.cache[rel]


def import_list(up):
    """(class package, class, outer index, object name) per import."""
    out = []
    for imp in up.imports:
        cpk, _, cls, _, outer, obj, num = struct.unpack("<iiiiiii", imp)
        name = up.names[obj][0] if num == 0 else "%s_%d" % (up.names[obj][0], num - 1)
        out.append((up.names[cpk][0], up.names[cls][0], outer, name))
    return out


def export_names(data):
    pkg = Package(data)
    return {(e["name"], str(pkg.ref(e["class"]))) for e in pkg.exports}


# ---------------------------------------------------------------- checks
def check_roundtrip(rel, data):
    up = UPackage(data)
    check(up.save() == data, rel + ": does not save back byte-for-byte")
    Package(data)
    return up


def check_exports(rel, new, stock, allowed):
    """Same exports as stock; only exports of `allowed` classes (or names) changed."""
    a, b = UPackage(new), UPackage(stock)
    check(len(a.exports) == len(b.exports), rel + ": export count changed")
    pkg = Package(new)
    changed = []
    for i, (x, y) in enumerate(zip(a.exports, b.exports), 1):
        check(x["fields"][:6] == y["fields"][:6], "%s: export %d header changed" % (rel, i))
        if x["data"] == y["data"]:
            continue
        cls = str(pkg.ref(pkg.exports[i - 1]["class"]))
        check(cls in allowed or pkg.exports[i - 1]["name"] in allowed,
              "%s: export %d (%s, %s) changed but should not" % (rel, i, pkg.exports[i - 1]["name"], cls))
        # Tags walk to None; the native data after them is stock.
        nt = tag_end(a, x["data"])
        st = tag_end(b, y["data"])
        check(nt is not None and st is not None, "%s: export %d tags do not end in None" % (rel, i))
        check(x["data"][nt:] == y["data"][st:], "%s: export %d native data changed" % (rel, i))
        changed.append(i)
    return changed


def tag_end(up, data):
    end = 0
    for name, ptype, start, voff, size in iter_tags(up, data):
        if voff + size > len(data):
            return None
        end = voff + size
    if data[end:end + 8] != up.fname("None"):
        return None
    return end + 8


def check_imports(rel, new, stock, paks, generated):
    """Every import resolves to an existing object."""
    up = UPackage(new)
    stock_imports = set(import_list(UPackage(stock)))
    imports = import_list(up)
    for k, (cpk, cls, outer, name) in enumerate(imports):
        if outer == 0:
            check(cls == "Package", "%s: top-level import %s is a %s" % (rel, name, cls))
            if name.startswith("/Script/"):
                check((cpk, cls, outer, name) in stock_imports, "%s: new native package %s" % (rel, name))
                continue
            check(name in generated or paks.rel(name), "%s: imports %s, which is not in the paks" % (rel, name))
            continue
        top = outer
        while imports[-top - 1][2] != 0:
            top = imports[-top - 1][2]
        package = imports[-top - 1][3]
        if package.startswith("/Script/"):
            check((cpk, cls, outer, name) in stock_imports, "%s: new native import %s" % (rel, name))
            continue
        if imports[-outer - 1][2] != 0:
            continue                    # a subobject of an imported asset: its outer is checked
        data = generated.get(package) or paks.read(paks.rel(package))
        check((name, cls) in export_names(data),
              "%s: imports %s.%s (%s), which %s does not export" % (rel, package, name, cls, package))
    check(len(up.imports) == len(stock_imports), rel + ": import count changed")
    return len(imports)


def check_streaming(rel, data, paks, generated, want_lighting):
    pkg = Package(data)
    seen = []
    for e in pkg.exports:
        if not str(pkg.ref(e["class"])).startswith("LevelStreaming"):
            continue
        m = re.search(rb"(/Game/[\x20-\x7e]+?)\.([\x20-\x7e]+?)\x00", data[e["offset"]:e["offset"] + e["size"]])
        check(m, "%s: %s has no world path" % (rel, e["name"]))
        package, world = m.group(1).decode(), m.group(2).decode()
        blob = generated.get(package) or (paks.read(paks.rel(package)) if paks.rel(package) else None)
        check(blob is not None, "%s: streams %s, which does not exist" % (rel, package))
        check((world, "World") in export_names(blob), "%s: %s has no world %s" % (rel, package, world))
        seen.append(package)
    check(want_lighting in seen, "%s: does not stream %s" % (rel, want_lighting))
    return seen


def mid_params(data, mid):
    """{name: value} of a MaterialInstanceDynamic's scalar and vector parameters."""
    pkg = Package(data)
    e = pkg.exports[mid - 1]
    blob = data[e["offset"]:e["offset"] + e["size"]]
    pn, pv = pkg.names.index("ParameterName"), pkg.names.index("ParameterValue")
    out, i = {}, 0
    while True:
        i = blob.find(struct.pack("<ii", pn, 0), i)
        if i < 0:
            return out
        name = pkg.names[struct.unpack_from("<i", blob, i + 25)[0]]
        j = blob.find(struct.pack("<ii", pv, 0), i)
        t = pkg.names[struct.unpack_from("<i", blob, j + 8)[0]]
        if t == "FloatProperty":
            out[name] = struct.unpack_from("<f", blob, j + 25)[0]
        elif t == "StructProperty":
            out[name] = struct.unpack_from("<4f", blob, j + 24 + 8 + 16 + 1)
        i += 8


def tag_value(data, up, index, prop, fmt):
    d = up.exports[index - 1]["data"]
    for name, ptype, start, voff, size in iter_tags(up, d):
        if name == prop:
            return struct.unpack_from(fmt, d, voff)
    return None


def check_values(rel, data, preset, fog_scale):
    pkg = Package(data)
    up = UPackage(data)
    sky = mw.sky_actor_index(pkg)
    mid = struct.unpack_from("<i", data, export_props(pkg, sky)["Sky material"][1])[0]
    params = mid_params(data, mid)
    for k, v in preset["sky"].items():
        check(abs(params[k] - v) < 1e-5, "%s: sky %s is %s, not %s" % (rel, k, params[k], v))
        actor = tag_value(data, up, sky, mw.SKY_ACTOR_NAMES.get(k, k), "<f")
        check(actor and abs(actor[0] - v) < 1e-5, "%s: sky actor %s is %s, not %s" % (rel, k, actor, v))
    check(close(params["Cloud color"], preset["cloud_color"]), rel + ": cloud color")
    sun = mw.first_of(pkg, "DirectionalLightComponent")
    for k, v in preset["sun"].items():
        check(abs(tag_value(data, up, sun, k, "<f")[0] - v) < 1e-5, "%s: sun %s" % (rel, k))
    if preset["moon"]:
        rot, direction = mw.moon_rotation(*preset["moon"])
        check(close(tag_value(data, up, sun, "RelativeRotation", "<3f"), rot), rel + ": moon rotation")
        check(close(params["Light direction"], direction), rel + ": sky light direction")
        # The sky's light direction is the light's forward vector, as in stock.
        check(abs(math.hypot(*direction[:3]) - 1.0) < 1e-6, rel + ": light direction not unit")
    sl = mw.first_of(pkg, "SkyLightComponent")
    check(abs(tag_value(data, up, sl, "Intensity", "<f")[0] - preset["sky_light"]["Intensity"]) < 1e-5,
          rel + ": sky light intensity")
    cubes = [i for i in import_list(up) if i[1] == "TextureCube"]
    check(len(cubes) == 1, "%s: %d TextureCube imports" % (rel, len(cubes)))
    if preset["cubemap"]:
        check(cubes[0][3] == preset["cubemap"], rel + ": sky light cubemap is " + cubes[0][3])
    fog = mw.first_of(pkg, "ExponentialHeightFogComponent")
    density = tag_value(data, up, fog, "FogDensity", "<f")[0]
    falloff = tag_value(data, up, fog, "FogHeightFalloff", "<f")[0]
    fog_z = tag_value(data, up, fog, "RelativeLocation", "<3f")[2]
    vis = mw.fog_visibility(density, fog_z, preset["fog"]["ground_z"], falloff)
    want = preset["fog"]["visibility_m"] / fog_scale
    check(abs(vis - want) < 0.01 * want, "%s: fog visibility %.1f m, want %.1f m" % (rel, vis, want))
    ppv = mw.first_of(pkg, "PostProcessVolume")
    inner = mw.struct_tags(up, ppv, "Settings")
    tags = {name: (ptype, voff, size) for name, ptype, _, voff, size in iter_tags(up, inner)}
    check(inner[tag_end(up, inner) - 8:tag_end(up, inner)] == up.fname("None"), rel + ": Settings tags")
    for k, v in preset["post"].items():
        check(("bOverride_" + k) in tags, "%s: no bOverride_%s" % (rel, k))
        ptype, voff, size = tags["bOverride_" + k]
        check(ptype == "BoolProperty", rel + ": bOverride type")
        fmt = "<4f" if isinstance(v, tuple) else "<f"
        got = struct.unpack_from(fmt, inner, tags[k][1])
        check(close(got, v if isinstance(v, tuple) else (v,)), "%s: post %s is %s" % (rel, k, got))
    return vis


def check_reflections(rel, new, stock, scale):
    a, b = Package(new), Package(stock)
    n = 0
    for i, e in enumerate(a.exports, 1):
        if not str(a.ref(e["class"])).endswith("ReflectionCaptureComponent"):
            continue
        pa, pb = export_props(a, i), export_props(b, i)
        got = struct.unpack_from("<f", new, pa["Brightness"][1])[0]
        was = struct.unpack_from("<f", stock, pb["Brightness"][1])[0] if "Brightness" in pb else 1.0
        check(abs(got - was * scale) < 1e-5, "%s: reflection capture %d brightness %s" % (rel, i, got))
        n += 1
    check(n > 0, rel + ": no reflection captures")
    return n


def check_pak(path, built):
    entries = {name.replace("../../../", ""): (f, off, usize, m, b) for f, name, off, usize, m, b in pak_entries(path)}
    check(set(entries) == set(built), "%s: holds %s, want %s" % (path, sorted(entries), sorted(built)))
    for rel, data in built.items():
        f, off, usize, m, b = entries[rel]
        check(read_entry(f, off, usize, m, b) == data, "%s: %s reads back different" % (path, rel))


def main(argv):
    args = list(argv)
    pak = override_pak = None
    if "--pak" in args:
        i = args.index("--pak"); pak = args[i + 1]; del args[i:i + 2]
    if "--override-pak" in args:
        i = args.index("--override-pak"); override_pak = args[i + 1]; del args[i:i + 2]
    if len(args) != 1:
        sys.exit(__doc__)
    paks_dir = args[0]
    paks = Paks(paks_dir)
    tmp = tempfile.mkdtemp(prefix="weather_")
    written = mw.build(paks_dir, tmp)
    built = {rel: open(os.path.join(tmp, rel), "rb").read() for rel in written}
    generated = {mw.game_path(rel): data for rel, data in built.items()}
    ok("built %d packages" % len(built))

    for name, (persistent, lighting, new_persistent, new_lighting, preset_name) in mw.VARIANTS.items():
        preset = mw.PRESETS[preset_name]
        stock_l, stock_p = paks.read(lighting), paks.read(persistent)
        patched = os.path.join(mw.SRC, persistent)
        base_p = open(patched, "rb").read() if os.path.exists(patched) else stock_p
        new_l, new_p = built[new_lighting], built[new_persistent]

        check_roundtrip(new_lighting, new_l)
        check_roundtrip(new_persistent, new_p)
        ok("%s: both packages save back byte-for-byte" % name)

        changed = check_exports(new_lighting, new_l, stock_l, LIGHTING_CLASSES)
        ok("%s: Lighting changes only sky, sun, sky light, fog, post process, reflections (%d exports)" % (
            name, len(changed)))
        changed = check_exports(new_persistent, new_p, base_p, {"LevelStreamingAlwaysLoaded"})
        check(len(changed) == 1, "%s: %d streaming entries changed" % (new_persistent, len(changed)))
        ok("%s: persistent level changes one streaming entry" % name)

        n = check_imports(new_lighting, new_l, stock_l, paks, generated)
        m = check_imports(new_persistent, new_p, base_p, paks, generated)
        ok("%s: all %d + %d imports resolve to existing objects" % (name, n, m))

        streamed = check_streaming(new_persistent, new_p, paks, generated, mw.game_path(new_lighting))
        check(mw.game_path(lighting) not in streamed, new_persistent + ": still streams the stock Lighting")
        ok("%s: %d streaming levels exist, Lighting -> %s" % (name, len(streamed), mw.game_path(new_lighting)))

        vis = check_values(new_lighting, new_l, preset, 1.0)
        refl = check_reflections(new_lighting, new_l, stock_l, preset["reflection_scale"])
        ok("%s: preset values read back (fog half-visibility %.0f m, %d reflection captures)" % (name, vis, refl))

        url = mw.MAP_URLS[name]
        check(url.split("?")[0] == mw.game_path(new_persistent), name + ": URL map")
        check("?game=" + mw.GAME_MODE in url, name + ": URL game mode")
        ok("%s: URL %s" % (name, url))

    # --fog scales visibility
    tmp2 = tempfile.mkdtemp(prefix="weather_fog_")
    mw.build(paks_dir, tmp2, fog_scale=2.0)
    for name, v in mw.VARIANTS.items():
        vis = check_values(v[3], open(os.path.join(tmp2, v[3]), "rb").read(), mw.PRESETS[v[4]], 2.0)
    ok("--fog 2 halves the visibility")

    if pak:
        make_pak.main(tmp, pak)
        check_pak(pak, built)
        ok("pak %s holds the %d packages" % (pak, len(built)))
    if override_pak:
        tmp3 = tempfile.mkdtemp(prefix="weather_override_")
        for name, v in mw.VARIANTS.items():
            dst = os.path.join(tmp3, v[1])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            open(dst, "wb").write(built[v[3]])
        make_pak.main(tmp3, override_pak)
        check_pak(override_pak, {v[1]: built[v[3]] for v in mw.VARIANTS.values()})
        ok("override pak %s puts the night Lighting levels on the stock paths" % override_pak)
    print("%d checks passed" % passed)


if __name__ == "__main__":
    main(sys.argv[1:])
