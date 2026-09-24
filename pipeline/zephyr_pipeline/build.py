import dataclasses
import hashlib
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from .cycles import Run
from .decode import load_fields
from .encode import encode_png, quantize
from .transform import convert_units, grid_from_coords, roll_longitude

LAYERS = {
    "wind": (["u", "v"], "m/s", "linear"),
    "temperature": (["temperature"], "°C", "linear"),
    "precipitation": (["precipitation"], "mm/h", "sqrt"),
    "clouds": (["clouds"], "%", "linear"),
}
_TEXTURE_NAME = re.compile(r"^[a-z]+\.[0-9a-f]{12}\.png$")


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build(out_dir: Path, grib_path: Path, run: Run, generated_at: datetime) -> dict:
    raw, lats, lons = load_fields(grib_path)
    fields = {}
    for name, arr in convert_units(raw).items():
        fields[name], rolled_lons = roll_longitude(arr, lons)
    grid = grid_from_coords(lats, rolled_lons)

    out_dir.mkdir(parents=True, exist_ok=True)
    layers = {}
    for layer, (names, units, encoding) in LAYERS.items():
        arrays = [fields[n] for n in names]
        mins = [math.floor(float(a.min()) * 1000) / 1000 for a in arrays]
        maxs = [math.ceil(float(a.max()) * 1000) / 1000 for a in arrays]
        png = encode_png([quantize(a, lo, hi, encoding) for a, lo, hi in zip(arrays, mins, maxs)])
        file = f"{layer}.{hashlib.sha256(png).hexdigest()[:12]}.png"
        (out_dir / file).write_bytes(png)
        layers[layer] = {"file": file, "units": units, "encoding": encoding, "min": mins, "max": maxs}

    manifest = {
        "version": 1,
        "run": {"cycle": _iso(run.cycle_time), "fhour": run.fhour},
        "validTime": _iso(run.valid_time),
        "generatedAt": _iso(generated_at),
        "grid": dataclasses.asdict(grid),
        "layers": layers,
    }
    # Written after every texture exists, and swapped in atomically, so a reader
    # never sees a manifest that points at a missing file.
    tmp = out_dir / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, out_dir / "manifest.json")

    keep = {layer["file"] for layer in layers.values()}
    for path in out_dir.glob("*.png"):
        if _TEXTURE_NAME.match(path.name) and path.name not in keep:
            path.unlink()
    return manifest
