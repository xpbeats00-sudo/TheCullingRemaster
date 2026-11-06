"""Generators read the stock game, never the Remaster's own patch pak: a
Paks folder with stock pakchunk paks and *_P.pak patch paks (throwaway paks
made with make_pak.py), and catalog.json refuses an item ID used twice.

usage: python test_stock_paks.py
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_catalog  # noqa: E402
import make_pak  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402


def pak(paks, name, files):
    src = tempfile.mkdtemp(dir=os.path.dirname(paks))
    for rel, data in files.items():
        path = os.path.join(src, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
    with contextlib.redirect_stdout(io.StringIO()):
        make_pak.main(src, os.path.join(paks, name))


tmp = tempfile.mkdtemp(prefix="stock-paks-test-")
try:
    paks = os.path.join(tmp, "Paks")
    os.makedirs(paks)
    A = "Victory/Content/Blueprints/GameMode/VictoryGameMode.uasset"
    ONLY_PATCH = "Victory/Content/Cosmetics/WeaponSkins/IceAxe_XP_Frost_Plasma.uasset"
    pak(paks, "pakchunk0-WindowsClient.pak", {A: b"stock game mode"})
    pak(paks, "pakchunk11-WindowsClient.pak", {"Victory/Content/Other.uasset": b"other"})
    pak(paks, "LocalServer-WindowsClient_P.pak", {A: b"the Remaster's patched game mode", ONLY_PATCH: b"generated skin"})
    pak(paks, "pakchunk99-WindowsClient_P.pak", {A: b"Func's"})
    open(os.path.join(paks, "notes.txt"), "w").close()

    names = [os.path.basename(p) for p in build_catalog.stock_paks(paks)]
    assert names == ["pakchunk0-WindowsClient.pak", "pakchunk11-WindowsClient.pak"], names
    assert len(build_catalog.stock_paks(paks, patches=True)) == 4
    print("ok    stock_paks: only pakchunk<N>-WindowsClient.pak; *_P.pak only when asked")

    assert find_in_paks(paks, {A})[A] == b"stock game mode", "read the patch pak's copy"
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            find_in_paks(paks, {ONLY_PATCH})
        raise AssertionError("an asset only in the patch pak was found")
    except SystemExit as e:
        assert "not found in paks" in str(e), e
    assert find_in_paks(paks, {ONLY_PATCH}, patches=True)[ONLY_PATCH] == b"generated skin"
    print("ok    find_in_paks (patch_assets, asset_registry.build): the stock copy, never the patch pak's")

    out = os.path.join(tmp, "catalog.json")
    good = [{"tid": 1, "asset": "/Game/A"}, {"tid": 2, "asset": "/Game/B"}]
    build_catalog.write_catalog(out, good)
    assert json.load(open(out)) == good
    try:
        build_catalog.write_catalog(out, good + [{"tid": 2, "asset": "/Game/C"}])
        raise AssertionError("a duplicate item ID was written")
    except ValueError as e:
        assert "item ID 2 is used twice" in str(e), e
    assert json.load(open(out)) == good, "the refused catalog was written"
    print("ok    write_catalog refuses an item ID used twice and leaves catalog.json as it was")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("all stock pak tests passed")
