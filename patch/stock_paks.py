"""Reading the game's own (stock) assets out of its paks.

A patch pak (*_P.pak, such as LocalServer-WindowsClient_P.pak) can sit in the
same Paks folder and holds this project's patched copies of the same assets.
A generator that rewrites values from the stock ones must never read those,
or running it twice would apply its change twice (an airdrop price cut twice
is 56% off, not 25%). So these read only the base paks.

Which paks are stock is decided in one place, build_catalog.stock_paks (the
pakchunk<N>-WindowsClient.pak files); this module adds the Paks-folder default
and a reader for the generators that take a set or a regex of paths.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries, read_entry, stock_paks  # noqa: E402,F401  (stock_paks re-exported)

DEFAULT_PAKS = os.path.join(HERE, "..", "TheCulling", "Victory", "Content", "Paks")


def paks_dir(argv_value=None):
    """The Paks folder: the argument, else $CULLING_PAKS, else ../TheCulling's."""
    return argv_value or os.environ.get("CULLING_PAKS") or DEFAULT_PAKS


def read_stock(paks, match):
    """{path relative to the mount point ("Victory/Content/..."): bytes} of the
    stock entries whose path is in `match` (a set) or matches it (a regex)."""
    found = {}
    for pak in stock_paks(paks):
        for f, name, off, usize, method, blocks in pak_entries(pak):
            rel = name.replace("../../../", "")
            if (rel in match) if isinstance(match, (set, frozenset, dict)) else match.search(rel):
                found[rel] = read_entry(f, off, usize, method, blocks)
    return found
