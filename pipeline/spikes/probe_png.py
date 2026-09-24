import io
import sys

import cfgrib
import numpy as np
from PIL import Image


def quantize(a, lo, hi):
    return np.clip(np.rint((a - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8)


def png_kib(arr):
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG", optimize=True)
    return buf.tell() / 1024


def load(path):
    fields = {}
    for ds in cfgrib.open_datasets(path, backend_kwargs={"indexpath": ""}):
        try:
            fields.update({name: da.values for name, da in ds.data_vars.items()})
        finally:
            ds.close()
    return fields


for path in sys.argv[1:]:
    f = load(path)
    print(path)
    u = quantize(f["u10"], f["u10"].min(), f["u10"].max())
    v = quantize(f["v10"], f["v10"].min(), f["v10"].max())
    print(f"  wind (RGB)   {png_kib(np.dstack([u, v, np.zeros_like(u)])):7.1f} KiB  shape={u.shape}")
    for name in ("t2m", "prate", "tcc"):
        print(f"  {name:12} {png_kib(quantize(f[name], f[name].min(), f[name].max())):7.1f} KiB")

    mmh = f["prate"] * 3600
    rainy = mmh > 0.1
    lin = quantize(mmh, 0, mmh.max())
    sq = quantize(np.sqrt(mmh), 0, np.sqrt(mmh.max()))
    print(f"  precip max {mmh.max():.1f} mm/h; rainy cells (>0.1 mm/h): {rainy.mean():.1%}")
    print(f"  rainy cells lost to 0 -> linear: {(lin[rainy] == 0).mean():.1%}  sqrt: {(sq[rainy] == 0).mean():.1%}")
