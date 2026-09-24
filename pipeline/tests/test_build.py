import io
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from zephyr_pipeline.build import build
from zephyr_pipeline.cycles import Run
from zephyr_pipeline.decode import load_fields
from zephyr_pipeline.encode import dequantize

FIXTURE = Path(__file__).parent / "fixtures" / "gfs_1p00_subset.grib2"
RUN = Run(datetime(2026, 9, 23, 0, tzinfo=timezone.utc), 6)
GENERATED = datetime(2026, 9, 23, 5, 30, tzinfo=timezone.utc)


def pixels(path):
    return np.asarray(Image.open(io.BytesIO(path.read_bytes())))


def test_manifest_describes_run_grid_and_layers(tmp_path):
    m = build(tmp_path, FIXTURE, RUN, GENERATED)

    assert json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8")) == m
    assert m["run"] == {"cycle": "2026-09-23T00:00:00Z", "fhour": 6}
    assert m["validTime"] == "2026-09-23T06:00:00Z"
    assert m["generatedAt"] == "2026-09-23T05:30:00Z"
    assert m["grid"] == {"width": 360, "height": 181, "lon0": -180.0, "lat0": 90.0, "dlon": 1.0, "dlat": -1.0}
    assert set(m["layers"]) == {"wind", "temperature", "precipitation", "clouds"}
    for layer in m["layers"].values():
        assert (tmp_path / layer["file"]).exists()
        assert len(layer["min"]) == len(layer["max"])


def test_temperature_texture_decodes_back_to_source_at_known_points(tmp_path):
    m = build(tmp_path, FIXTURE, RUN, GENERATED)
    t = m["layers"]["temperature"]
    decoded = dequantize(pixels(tmp_path / t["file"]), t["min"][0], t["max"][0], t["encoding"])

    raw, _, _ = load_fields(FIXTURE)
    celsius = raw["temperature"] - 273.15
    tol = (t["max"][0] - t["min"][0]) / 255 / 2 + 1e-3
    # Source column 0 is lon 0; after rolling, lon 0 sits at column 180 of 360.
    assert abs(decoded[90, 180] - celsius[90, 0]) <= tol
    # Source column 180 is lon 180; after rolling it is column 0.
    assert abs(decoded[45, 0] - celsius[45, 180]) <= tol


def test_wind_texture_is_rgb_with_two_components(tmp_path):
    m = build(tmp_path, FIXTURE, RUN, GENERATED)
    px = pixels(tmp_path / m["layers"]["wind"]["file"])
    assert px.shape == (181, 360, 3) and (px[..., 2] == 0).all()
    assert len(m["layers"]["wind"]["min"]) == 2


def test_rebuild_prunes_stale_textures_but_nothing_else(tmp_path):
    (tmp_path / "wind.0123456789ab.png").write_bytes(b"old")
    (tmp_path / "notes.txt").write_text("keep me")
    build(tmp_path, FIXTURE, RUN, GENERATED)
    assert not (tmp_path / "wind.0123456789ab.png").exists()
    assert (tmp_path / "notes.txt").exists()
    assert not (tmp_path / "manifest.json.tmp").exists()
