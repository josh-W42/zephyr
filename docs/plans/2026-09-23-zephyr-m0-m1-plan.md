# zephyr M0–M1 Implementation Plan

> **For Claude:** Execute inline in this session (user preference — no subagents,
> no separate session). Follow superpowers:executing-plans checkpoint discipline:
> run every verification command, commit per task with the reasoning in the
> message, and surface any finding that contradicts this plan instead of quietly
> adapting.

**Goal:** Resolve the design's unverified assumptions (M0), then build a tested
Python pipeline that turns one GFS run into `manifest.json` + PNG textures (M1).

**Architecture:** Pick the newest GFS run whose `.idx` exists on the NOAA AWS
mirror → byte-range download 5 GRIB2 messages → decode with cfgrib → convert
units, roll longitudes to −180..180 → quantize to 8-bit PNGs (content-hashed
names) → write `manifest.json` atomically. Network code is isolated behind an
injectable `get` function so everything else is tested offline against a real
1° GRIB2 fixture.

**Tech stack:** Python 3.11, numpy, xarray, cfgrib + eccodes, Pillow, pytest.
Web spike: Vite, TypeScript, three.

**Scope:** M2–M6 (frontend, automation, polish) are planned in a separate
document *after* M0, because M0's results (UV alignment, texture sizes,
precipitation encoding) change their details.

**Verified before writing this plan (2026-09-23):**
- `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260923/00/atmos/gfs.t00z.pgrb2.0p25.f006.idx`
  exists and lists `UGRD/VGRD:10 m above ground`, `TMP:2 m above ground`,
  `PRATE:surface` (instant **and** `0-6 hour ave fcst`), `TCDC:entire atmosphere`
  (instant **and** average). f000 lists the same fields with step `anl`.
- Bucket listing works (so missing keys should return 404, confirmed in Task 2).
- Local: Python 3.14 (default) and **3.11** (`py -3.11`), Node 24, npm 11,
  Docker 24, WSL Ubuntu. Firebase CLI not installed (not needed until M5).

All paths below are relative to the repo root
`C:\Users\wilso\Documents\programming\claude\zephyr`. Commands are PowerShell.

---

## M0 — Spike

M0 scripts live in `pipeline/spikes/` and are throwaway, but they are committed
because their output is the evidence for later decisions.

### Task 1: Repo hygiene + Python environment

**Files:**
- Create: `.gitignore`
- Create: `pipeline/pyproject.toml`
- Create: `pipeline/zephyr_pipeline/__init__.py` (empty)

**Step 1: Write `.gitignore`**

```gitignore
# Python
pipeline/.venv/
__pycache__/
*.egg-info/
.pytest_cache/
*.idx
pipeline/spikes/out/

# Web
web/node_modules/
web/dist/
web/public/data/

# GRIB downloads (the committed test fixture is re-included)
*.grib2
!pipeline/tests/fixtures/*.grib2
```

**Step 2: Write `pipeline/pyproject.toml`**

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "zephyr-pipeline"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["numpy", "xarray", "cfgrib", "eccodes", "pillow"]

[project.optional-dependencies]
dev = ["pytest"]

[tool.setuptools]
packages = ["zephyr_pipeline"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`eccodes` is the Python binding; recent releases pull a bundled binary library
(`eccodeslib`) as a wheel. **Unverified on Windows** — that is what Step 4 tests.

**Step 3: Create the venv and install**

```powershell
py -3.11 -m venv pipeline\.venv
pipeline\.venv\Scripts\python -m pip install --upgrade pip
pipeline\.venv\Scripts\python -m pip install -e "pipeline[dev]"
```

Expected: installs without compiling anything. If `eccodes` fails to find a
Windows wheel, stop and record it — fallback is running the pipeline in WSL
Ubuntu (`wsl -d Ubuntu`), which also matches CI.

**Step 4: Self-check ecCodes on Windows**

```powershell
pipeline\.venv\Scripts\python -m cfgrib selfcheck
```

Expected: prints the ecCodes version and `Your system is ready.` Record the
output.

**Step 5: Self-check on Linux (mirrors the GitHub Actions runner)**

Docker Desktop must be running.

```powershell
docker run --rm python:3.11-slim sh -c "pip install -q eccodes cfgrib xarray numpy && python -m cfgrib selfcheck"
```

Expected: `Your system is ready.` Record the output.

**Step 6: Record installed versions**

```powershell
pipeline\.venv\Scripts\python -m pip freeze
```

Save the versions of numpy, xarray, cfgrib, eccodes, eccodeslib, pillow for the
M0 findings (Task 5). Then pin minimum versions in `pyproject.toml`
(`"cfgrib>=X.Y"` etc.) using those numbers.

**Step 7: Commit**

```powershell
git add .gitignore pipeline/pyproject.toml pipeline/zephyr_pipeline/__init__.py
git commit -m "Set up pipeline package on Python 3.11

3.11 rather than the system 3.14 because eccodes/cfgrib wheel support is
broadest there, and GitHub Actions will use the same version."
```

---

### Task 2: Download + decode probe (and the test fixture)

Answers: do Range requests on AWS return exact GRIB messages? What names,
units, level types and grid orientation does cfgrib give? Does a missing key
return 404? Do `0p50`/`1p00` files carry the same fields?

**Files:**
- Create: `pipeline/spikes/probe_download.py`
- Create (output, committed): `pipeline/tests/fixtures/gfs_1p00_subset.grib2`

**Step 1: Write the probe**

```python
import sys
import urllib.error
import urllib.request
from pathlib import Path

import cfgrib

BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
WANTED = {
    ("UGRD", "10 m above ground"),
    ("VGRD", "10 m above ground"),
    ("TMP", "2 m above ground"),
    ("PRATE", "surface"),
    ("TCDC", "entire atmosphere"),
}


def get(url, rng=None):
    req = urllib.request.Request(url, headers={"Range": rng} if rng else {})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status, resp.read()


def head_status(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def subset(date, cycle, fhour, res, out):
    base = f"{BUCKET}/gfs.{date}/{cycle:02d}/atmos/gfs.t{cycle:02d}z.pgrb2.{res}.f{fhour:03d}"
    _, idx = get(base + ".idx")
    parts = [line.split(":") for line in idx.decode("ascii").splitlines() if line]
    chunks = []
    for i, p in enumerate(parts):
        if (p[3], p[4]) in WANTED and "ave" not in p[5] and "acc" not in p[5]:
            start = int(p[1])
            end = str(int(parts[i + 1][1]) - 1) if i + 1 < len(parts) else ""
            status, data = get(base, f"bytes={start}-{end}")
            ok = data[:4] == b"GRIB" and data[-4:] == b"7777"
            print(f"  {p[3]:6} {p[4]:20} {p[5]:12} HTTP {status} {len(data):>8} B  framed={ok}")
            chunks.append(data)
    out.write_bytes(b"".join(chunks))
    print(f"  wrote {out} ({out.stat().st_size / 1024:.0f} KiB)")


def inspect(path):
    for ds in cfgrib.open_datasets(str(path), backend_kwargs={"indexpath": ""}):
        try:
            for name, da in ds.data_vars.items():
                v = da.values
                print(
                    f"  {name:6} level={da.attrs.get('GRIB_typeOfLevel')} "
                    f"step={da.attrs.get('GRIB_stepType')} units={da.attrs.get('units')!r} "
                    f"shape={v.shape} min={v.min():.4g} max={v.max():.4g}"
                )
            lat, lon = ds.latitude.values, ds.longitude.values
            print(f"  lat {lat[0]}..{lat[-1]} (n={lat.size})  lon {lon[0]}..{lon[-1]} (n={lon.size})")
        finally:
            ds.close()


if __name__ == "__main__":
    date, cycle, fhour = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    out_dir = Path(__file__).parent / "out"
    out_dir.mkdir(exist_ok=True)
    for res in ("0p25", "0p50", "1p00"):
        print(f"== {res}")
        path = out_dir / f"subset_{res}.grib2"
        subset(date, cycle, fhour, res, path)
        inspect(path)
    missing = f"{BUCKET}/gfs.{date}/{cycle:02d}/atmos/gfs.t{cycle:02d}z.pgrb2.0p25.f999.idx"
    print(f"== HEAD on missing key -> {head_status(missing)}")
```

**Step 2: Run it against a fixed, archived run**

```powershell
pipeline\.venv\Scripts\python pipeline\spikes\probe_download.py 20260923 0 6
```

Expected, for each resolution: 5 lines with `HTTP 206` and `framed=True`, then
5 decoded variables. **Record exactly:** variable names (expected `u10`, `v10`,
`t2m`, `prate`, `tcc`), their `units` strings (expected `m s**-1`, `K`,
`kg m**-2 s**-1`, `%`), step type (expected `instant`), latitude order
(expected 90 → −90), longitude range (expected 0 → 359.75), shapes
(expected 721×1440 / 361×720 / 181×360). Missing key HEAD expected `404`.

If any name/unit differs, M1 Task 5's `EXPECTED` table must use the observed
values.

**Step 3: Promote the 1° subset to the test fixture**

```powershell
New-Item -ItemType Directory -Force pipeline\tests\fixtures | Out-Null
Copy-Item pipeline\spikes\out\subset_1p00.grib2 pipeline\tests\fixtures\gfs_1p00_subset.grib2
(Get-Item pipeline\tests\fixtures\gfs_1p00_subset.grib2).Length / 1KB
```

Expected: a few hundred KiB. (If it is over ~1 MiB, record it; it is still
acceptable for one fixture.)

**Step 4: Commit**

```powershell
git add pipeline/spikes/probe_download.py pipeline/tests/fixtures/gfs_1p00_subset.grib2
git commit -m "Probe byte-range GFS download and cfgrib decoding

Records the variable names, units and grid orientation cfgrib produces so the
pipeline can validate against them. The 1-degree subset of the archived
2026-09-23 00z f006 run becomes the offline decode fixture."
```

---

### Task 3: Texture size + precipitation encoding probe

Answers: how big are 8-bit PNGs at 0.25° vs 0.5°? Does linear 8-bit encoding
erase light rain?

**Files:**
- Create: `pipeline/spikes/probe_png.py`

**Step 1: Write the probe**

```python
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
```

**Step 2: Run it**

```powershell
pipeline\.venv\Scripts\python pipeline\spikes\probe_png.py pipeline\spikes\out\subset_0p25.grib2 pipeline\spikes\out\subset_0p50.grib2
```

**Step 3: Decide and record**

- Resolution: keep `0p25` if the wind PNG is ≤ ~1.2 MiB and the four PNGs
  total ≤ ~3 MiB; otherwise use `0p50` (just a different file name — no
  downsampling code needed).
- Precipitation encoding: M1 implements `sqrt` for precipitation. If the
  linear column loses < 1% of rainy cells, switch precipitation to `linear` in
  M1 Task 8's `LAYERS` table instead (fewer moving parts for the shader).

**Step 4: Commit**

```powershell
git add pipeline/spikes/probe_png.py
git commit -m "Probe PNG texture sizes and precipitation quantization"
```

---

### Task 4: Web scaffold + sphere UV alignment probe

Answers: with Three's default `SphereGeometry` UVs and an equirectangular
texture whose column 0 is −180°, where does each longitude land, and does
`lonLatToVec3` agree? Is there a seam at the dateline? Which way up is the
texture?

Expected from Three's `SphereGeometry` source (to confirm, not assume):
u = 0 is at −X, u = 0.5 at +X, u = 0.75 at −Z, and v = 1 at the north pole
(+Y). So lon 0° → +X, lon 90°E → −Z, giving
`(cos φ cos λ, sin φ, −cos φ sin λ)`.

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/index.html`, `web/src/main.ts`
- Create: `web/uv-probe.html`, `web/src/spikes/uvProbe.ts`
- Create or modify: `C:\Users\wilso\Documents\programming\claude\.claude\launch.json`
  (the preview tool reads launch configs from the session's working directory)

**Step 1: Minimal Vite project by hand (avoids interactive `create-vite` prompts)**

`web/package.json`:

```json
{
  "name": "zephyr-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  }
}
```

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>zephyr</title>
  </head>
  <body>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`web/src/main.ts`:

```ts
document.body.textContent = "zephyr — globe arrives in M2";
```

```powershell
npm --prefix web install three
npm --prefix web install -D vite typescript @types/three
```

Expected: installs cleanly. Record the resolved `three` version (apsis uses r186).

**Step 2: UV probe page**

`web/uv-probe.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>UV probe</title>
    <style>html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }</style>
  </head>
  <body>
    <script type="module" src="/src/spikes/uvProbe.ts"></script>
  </body>
</html>
```

`web/src/spikes/uvProbe.ts`:

```ts
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

function lonLatToVec3(lonDeg: number, latDeg: number, r = 1): THREE.Vector3 {
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const lat = THREE.MathUtils.degToRad(latDeg);
  return new THREE.Vector3(
    r * Math.cos(lat) * Math.cos(lon),
    r * Math.sin(lat),
    -r * Math.cos(lat) * Math.sin(lon),
  );
}

// Equirectangular test texture: column 0 = lon -180, row 0 = lat +90.
const W = 2048;
const H = 1024;
const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext("2d")!;
const x = (lon: number) => ((lon + 180) / 360) * W;
const y = (lat: number) => ((90 - lat) / 180) * H;

ctx.fillStyle = "#223";
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = "#f0f";
ctx.fillRect(0, 0, W, y(80));
const meridians: [number, string][] = [[0, "#f00"], [90, "#0f0"], [-90, "#00f"]];
for (const [lon, color] of meridians) {
  ctx.fillStyle = color;
  ctx.fillRect(x(lon) - 3, 0, 6, H);
}
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, 3, H);
ctx.fillRect(W - 3, 0, 3, H);
ctx.fillStyle = "#ff0";
ctx.fillRect(0, y(0) - 3, W, 6);

const texture = new THREE.CanvasTexture(canvas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.wrapS = THREE.RepeatWrapping;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
const controls = new OrbitControls(camera, renderer.domElement);

scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), new THREE.MeshBasicMaterial({ map: texture })));

const markers: [number, number, number][] = [
  [0, 0, 0xffff00],
  [90, 0, 0x00ffff],
  [-90, 0, 0xff8800],
  [0, 85, 0xffffff],
  [180, 0, 0xff0000],
];
for (const [lon, lat, color] of markers) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.03), new THREE.MeshBasicMaterial({ color }));
  m.position.copy(lonLatToVec3(lon, lat, 1.01));
  scene.add(m);
}

function view(lon: number, lat: number) {
  camera.position.copy(lonLatToVec3(lon, lat, 3.5));
  controls.update();
}
(window as unknown as { view: typeof view }).view = view;
view(0, 20);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
```

**Step 3: Launch config for the preview tool**

In `C:\Users\wilso\Documents\programming\claude\.claude\launch.json` (create if
missing; if it exists, append to `configurations`):

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "zephyr-web",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["--prefix", "zephyr/web", "run", "dev"],
      "port": 5173
    }
  ]
}
```

**Step 4: Verify in the browser**

Start `zephyr-web` with `preview_start`, navigate to
`http://localhost:5173/uv-probe.html`, then for each view call
`view(lon, lat)` via `javascript_tool` and take a screenshot:

| View | Expected |
| --- | --- |
| `view(0, 20)` | Yellow marker on the red meridian ∩ yellow equator; white marker inside the magenta north cap on the red meridian |
| `view(90, 0)` | Cyan marker on the green meridian |
| `view(-90, 0)` | Orange marker on the blue meridian |
| `view(180, 0)` | Red marker on the white dateline stripes, no gap or smear at the seam |
| `view(0, 89)` | Magenta cap centred on the pole (texture is not upside down) |

Also run `read_console_messages` with `onlyErrors: true` → expect none.

If any row fails, the fix goes into `lonLatToVec3` (or a `texture.offset.x`),
and the corrected formula is recorded in the findings.

**Step 5: Commit**

```powershell
git add web/package.json web/package-lock.json web/tsconfig.json web/index.html web/src web/uv-probe.html
git commit -m "Scaffold web app and probe sphere UV alignment

Confirms which world axis each longitude maps to under Three's default
SphereGeometry UVs, so lonLatToVec3 and the data textures agree in M2."
```

(`.claude/launch.json` lives outside this repo; it is not committed here.)

---

### Task 5: Record M0 findings

**Files:**
- Modify: `docs/plans/2026-09-23-zephyr-design.md` (replace the
  "Open questions / unverified assumptions" section with "M0 findings")

**Step 1:** For each question, write the observed answer and evidence (command
+ key output line): ecCodes on Windows and Linux (versions), cfgrib
names/units/step types/grid orientation, 404 on missing key, PNG sizes and the
chosen resolution, precipitation encoding decision, three version, confirmed
`lonLatToVec3` formula and texture orientation.

**Step 2:** If anything contradicts M1 below (names, units, resolution,
encoding), edit the affected M1 task in this plan before starting M1, and note
the change in the commit message.

**Step 3: Commit**

```powershell
git add docs/plans
git commit -m "Record M0 findings"
```

**Checkpoint:** stop and review findings with the user before M1.

---

## M1 — Pipeline (runs locally)

All tests run with:

```powershell
pipeline\.venv\Scripts\python -m pytest pipeline -q
```

### Task 6: Run selection

**Files:**
- Create: `pipeline/zephyr_pipeline/cycles.py`
- Test: `pipeline/tests/test_cycles.py`

**Step 1: Write the failing tests**

```python
from datetime import datetime, timedelta, timezone

import pytest

from zephyr_pipeline.cycles import NoRunAvailable, Run, candidate_runs, pick_run

UTC = timezone.utc


def at(day, hour, minute=0):
    return datetime(2026, 9, day, hour, minute, tzinfo=UTC)


def test_candidates_start_at_latest_cycle_with_nearest_forecast_hour():
    runs = candidate_runs(at(23, 14, 20))
    assert runs[0] == Run(at(23, 12), 2)
    assert runs[1] == Run(at(23, 6), 8)


def test_forecast_hour_rounds_half_up_to_nearest_hour():
    assert candidate_runs(at(23, 14, 30))[0].fhour == 3
    assert candidate_runs(at(23, 14, 29))[0].fhour == 2


def test_candidates_cross_midnight():
    runs = candidate_runs(at(24, 1, 10), lookback=4)
    assert runs == [
        Run(at(24, 0), 1),
        Run(at(23, 18), 7),
        Run(at(23, 12), 13),
        Run(at(23, 6), 19),
    ]


def test_non_utc_input_is_normalised():
    eastern = timezone(timedelta(hours=-4))
    now = datetime(2026, 9, 23, 10, 20, tzinfo=eastern)  # 14:20Z
    assert candidate_runs(now)[0] == Run(at(23, 12), 2)


def test_naive_datetime_rejected():
    with pytest.raises(ValueError):
        candidate_runs(datetime(2026, 9, 23, 14, 0))


def test_pick_run_skips_runs_that_do_not_exist_yet():
    run = pick_run(at(23, 14, 20), exists=lambda r: r.cycle_time.hour != 12)
    assert run == Run(at(23, 6), 8)


def test_pick_run_raises_when_nothing_available():
    with pytest.raises(NoRunAvailable):
        pick_run(at(23, 14), exists=lambda r: False)


def test_valid_time():
    assert Run(at(23, 12), 5).valid_time == at(23, 17)
```

**Step 2: Run to verify failure**

```powershell
pipeline\.venv\Scripts\python -m pytest pipeline\tests\test_cycles.py -q
```

Expected: FAIL — `ModuleNotFoundError: No module named 'zephyr_pipeline.cycles'`.

**Step 3: Implement**

```python
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

CYCLE_SPACING = timedelta(hours=6)


@dataclass(frozen=True)
class Run:
    cycle_time: datetime
    fhour: int

    @property
    def valid_time(self) -> datetime:
        return self.cycle_time + timedelta(hours=self.fhour)


class NoRunAvailable(RuntimeError):
    pass


def candidate_runs(now: datetime, lookback: int = 4) -> list[Run]:
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(timezone.utc)
    cycle = now.replace(hour=now.hour - now.hour % 6, minute=0, second=0, microsecond=0)
    runs = []
    for _ in range(lookback):
        fhour = int((now - cycle) / timedelta(hours=1) + 0.5)
        runs.append(Run(cycle, fhour))
        cycle -= CYCLE_SPACING
    return runs


def pick_run(now: datetime, exists: Callable[[Run], bool], lookback: int = 4) -> Run:
    for run in candidate_runs(now, lookback):
        if exists(run):
            return run
    raise NoRunAvailable(f"no GFS run in the {lookback} cycles before {now.isoformat()}")
```

**Step 4: Run to verify pass**

Same command. Expected: `8 passed`.

**Step 5: Commit**

```powershell
git add pipeline/zephyr_pipeline/cycles.py pipeline/tests/test_cycles.py
git commit -m "Select the newest available GFS run nearest to now

Existence is injected so the selection rules are testable offline; the
forecast hour is chosen per cycle because 0p25 files are hourly."
```

---

### Task 7: `.idx` parsing and byte ranges

**Files:**
- Create: `pipeline/zephyr_pipeline/idx.py`
- Test: `pipeline/tests/test_idx.py`

**Step 1: Write the failing tests**

```python
import pytest

from zephyr_pipeline.idx import IdxEntry, byte_ranges, parse_idx

SAMPLE = """\
1:0:d=2026092300:PRMSL:mean sea level:6 hour fcst:
2:1000:d=2026092300:TMP:2 m above ground:6 hour fcst:
3:1500:d=2026092300:UGRD:10 m above ground:6 hour fcst:
4:2100:d=2026092300:VGRD:10 m above ground:6 hour fcst:
5:2700:d=2026092300:PRATE:surface:6 hour fcst:
6:3000:d=2026092300:PRATE:surface:0-6 hour ave fcst:
7:3400:d=2026092300:TCDC:entire atmosphere:6 hour fcst:
8:3900:d=2026092300:TCDC:entire atmosphere:0-6 hour ave fcst:
"""

WANTED = [
    ("UGRD", "10 m above ground"),
    ("VGRD", "10 m above ground"),
    ("TMP", "2 m above ground"),
    ("PRATE", "surface"),
    ("TCDC", "entire atmosphere"),
]


def test_parse_idx_reads_offset_var_level_step():
    entries = parse_idx(SAMPLE)
    assert len(entries) == 8
    assert entries[1] == IdxEntry(1000, "TMP", "2 m above ground", "6 hour fcst")


def test_byte_ranges_are_inclusive_and_end_before_next_message():
    ranges = byte_ranges(parse_idx(SAMPLE), WANTED)
    assert ranges[("TMP", "2 m above ground")] == (1000, 1499)
    assert ranges[("UGRD", "10 m above ground")] == (1500, 2099)


def test_averaged_messages_are_ignored():
    ranges = byte_ranges(parse_idx(SAMPLE), WANTED)
    assert ranges[("PRATE", "surface")] == (2700, 2999)
    assert ranges[("TCDC", "entire atmosphere")] == (3400, 3899)


def test_analysis_step_counts_as_instantaneous():
    text = "1:0:d=2026092300:PRATE:surface:anl:\n2:500:d=2026092300:TMP:surface:anl:\n"
    assert byte_ranges(parse_idx(text), [("PRATE", "surface")]) == {("PRATE", "surface"): (0, 499)}


def test_last_message_range_is_open_ended():
    text = "1:0:d=2026092300:TMP:surface:anl:\n2:800:d=2026092300:TCDC:entire atmosphere:anl:\n"
    ranges = byte_ranges(parse_idx(text), [("TCDC", "entire atmosphere")])
    assert ranges[("TCDC", "entire atmosphere")] == (800, None)


def test_missing_field_raises():
    with pytest.raises(ValueError, match="missing"):
        byte_ranges(parse_idx(SAMPLE), [("HGT", "500 mb")])


def test_duplicate_instantaneous_field_raises():
    text = "1:0:d=x:TMP:2 m above ground:anl:\n2:10:d=x:TMP:2 m above ground:6 hour fcst:\n"
    with pytest.raises(ValueError, match="multiple"):
        byte_ranges(parse_idx(text), [("TMP", "2 m above ground")])


@pytest.mark.parametrize("text", ["garbage\n", "1:abc:d=x:TMP:2 m above ground:anl:\n"])
def test_malformed_lines_raise(text):
    with pytest.raises(ValueError):
        parse_idx(text)


def test_non_increasing_offsets_raise():
    with pytest.raises(ValueError, match="increasing"):
        parse_idx("1:500:d=x:A:l:anl:\n2:100:d=x:B:l:anl:\n")
```

**Step 2: Run to verify failure**

```powershell
pipeline\.venv\Scripts\python -m pytest pipeline\tests\test_idx.py -q
```

Expected: FAIL — module not found.

**Step 3: Implement**

```python
import re
from dataclasses import dataclass

_INSTANT_STEP = re.compile(r"^(anl|\d+ hour fcst)$")

Field = tuple[str, str]


@dataclass(frozen=True)
class IdxEntry:
    offset: int
    var: str
    level: str
    step: str


def parse_idx(text: str) -> list[IdxEntry]:
    entries = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        parts = line.split(":")
        if len(parts) < 6:
            raise ValueError(f"malformed idx line {lineno}: {line!r}")
        try:
            offset = int(parts[1])
        except ValueError:
            raise ValueError(f"bad offset on idx line {lineno}: {line!r}") from None
        entries.append(IdxEntry(offset, parts[3], parts[4], parts[5]))
    if any(b.offset <= a.offset for a, b in zip(entries, entries[1:])):
        raise ValueError("idx offsets are not strictly increasing")
    return entries


def byte_ranges(entries: list[IdxEntry], wanted: list[Field]) -> dict[Field, tuple[int, int | None]]:
    """Inclusive (start, end) per wanted field; end is None for the file's last message."""
    ranges: dict[Field, tuple[int, int | None]] = {}
    for i, entry in enumerate(entries):
        key = (entry.var, entry.level)
        if key not in wanted or not _INSTANT_STEP.match(entry.step):
            continue
        if key in ranges:
            raise ValueError(f"multiple instantaneous messages for {key}")
        end = entries[i + 1].offset - 1 if i + 1 < len(entries) else None
        ranges[key] = (entry.offset, end)
    missing = [k for k in wanted if k not in ranges]
    if missing:
        raise ValueError(f"idx is missing fields: {missing}")
    return ranges
```

**Step 4: Run to verify pass.** Expected: `10 passed`.

**Step 5: Commit**

```powershell
git add pipeline/zephyr_pipeline/idx.py pipeline/tests/test_idx.py
git commit -m "Parse GFS .idx inventories into byte ranges

Only instantaneous messages (anl / N hour fcst) are selected because forecast
files also carry 0-N hour averages for PRATE and TCDC."
```

---

### Task 8: Fetching (network isolated behind `get`)

**Files:**
- Create: `pipeline/zephyr_pipeline/fetch.py`
- Test: `pipeline/tests/test_fetch.py`

**Step 1: Write the failing tests**

```python
from datetime import datetime, timezone

import pytest

from zephyr_pipeline.cycles import Run
from zephyr_pipeline.fetch import WANTED, download_subset, grib_url

RUN = Run(datetime(2026, 9, 23, 6, tzinfo=timezone.utc), 5)


def message(tag: bytes) -> bytes:
    return b"GRIB" + tag * 20 + b"7777"


def fake_file(order):
    """Builds a fake GRIB file + idx from (var, level, step) triples."""
    body, lines = b"", []
    for n, (var, level, step) in enumerate(order, 1):
        lines.append(f"{n}:{len(body)}:d=2026092306:{var}:{level}:{step}:")
        body += message(var.encode()[:1])
    return body, "\n".join(lines) + "\n"


def fake_get(files):
    calls = []

    def get(url, headers):
        calls.append((url, headers.get("Range")))
        body = files[url]
        rng = headers.get("Range")
        if rng is None:
            return body
        start, _, end = rng.removeprefix("bytes=").partition("-")
        return body[int(start) : int(end) + 1 if end else None]

    return get, calls


ORDER = [
    ("TMP", "2 m above ground", "5 hour fcst"),
    ("UGRD", "10 m above ground", "5 hour fcst"),
    ("VGRD", "10 m above ground", "5 hour fcst"),
    ("PRATE", "surface", "5 hour fcst"),
    ("PRATE", "surface", "0-5 hour ave fcst"),
    ("TCDC", "entire atmosphere", "5 hour fcst"),
]


def test_grib_url_layout():
    assert grib_url(RUN) == (
        "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260923/06/atmos/gfs.t06z.pgrb2.0p25.f005"
    )
    assert grib_url(RUN, "1p00").endswith("gfs.t06z.pgrb2.1p00.f005")


def test_download_subset_returns_wanted_messages_in_wanted_order():
    body, idx = fake_file(ORDER)
    url = grib_url(RUN)
    get, calls = fake_get({url: body, url + ".idx": idx.encode()})

    data = download_subset(RUN, get=get)

    assert data == message(b"U") + message(b"V") + message(b"T") + message(b"P") + message(b"T")
    assert calls[0] == (url + ".idx", None)
    assert calls[-1][1].endswith("-")  # TCDC is last in the file: open-ended range


def test_wanted_covers_the_five_fields():
    assert {v for v, _ in WANTED} == {"UGRD", "VGRD", "TMP", "PRATE", "TCDC"}


def test_unframed_response_raises():
    body, idx = fake_file(ORDER)
    url = grib_url(RUN)
    get, _ = fake_get({url: b"<Error>AccessDenied</Error>" + body[27:], url + ".idx": idx.encode()})
    with pytest.raises(ValueError, match="GRIB"):
        download_subset(RUN, get=get)
```

**Step 2: Run to verify failure.**

```powershell
pipeline\.venv\Scripts\python -m pytest pipeline\tests\test_fetch.py -q
```

Expected: FAIL — module not found.

**Step 3: Implement**

```python
import urllib.error
import urllib.request
from collections.abc import Callable

from .cycles import Run
from .idx import byte_ranges, parse_idx

BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
WANTED = [
    ("UGRD", "10 m above ground"),
    ("VGRD", "10 m above ground"),
    ("TMP", "2 m above ground"),
    ("PRATE", "surface"),
    ("TCDC", "entire atmosphere"),
]

HttpGet = Callable[[str, dict[str, str]], bytes]


def grib_url(run: Run, resolution: str = "0p25") -> str:
    c = run.cycle_time
    return f"{BUCKET}/gfs.{c:%Y%m%d}/{c:%H}/atmos/gfs.t{c:%H}z.pgrb2.{resolution}.f{run.fhour:03d}"


def http_get(url: str, headers: dict[str, str]) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as resp:
        return resp.read()


def url_exists(url: str) -> bool:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30):
            return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def download_subset(run: Run, get: HttpGet = http_get, resolution: str = "0p25") -> bytes:
    url = grib_url(run, resolution)
    ranges = byte_ranges(parse_idx(get(url + ".idx", {}).decode("ascii")), WANTED)
    chunks = []
    for key in WANTED:
        start, end = ranges[key]
        data = get(url, {"Range": f"bytes={start}-{'' if end is None else end}"})
        if not (data.startswith(b"GRIB") and data.endswith(b"7777")):
            raise ValueError(f"response for {key} is not a single GRIB message")
        if end is not None and len(data) != end - start + 1:
            raise ValueError(f"response for {key} has {len(data)} bytes, expected {end - start + 1}")
        chunks.append(data)
    return b"".join(chunks)
```

**Step 4: Run to verify pass.** Expected: `4 passed`.

**Step 5: Commit**

```powershell
git add pipeline/zephyr_pipeline/fetch.py pipeline/tests/test_fetch.py
git commit -m "Download the five GFS fields with HTTP Range requests

Each response is checked for GRIB framing and exact length, so an S3 error
body or truncated read fails the job instead of producing bad textures."
```

---

### Task 9: Decode + transforms

**Files:**
- Create: `pipeline/zephyr_pipeline/decode.py`
- Create: `pipeline/zephyr_pipeline/transform.py`
- Test: `pipeline/tests/test_transform.py`, `pipeline/tests/test_decode.py`

**Step 1: Write the failing tests**

`pipeline/tests/test_transform.py`:

```python
import numpy as np
import pytest

from zephyr_pipeline.transform import Grid, convert_units, grid_from_coords, roll_longitude


def test_roll_moves_minus_180_to_column_zero():
    lons = np.arange(0, 360, 45.0)  # 0, 45, ..., 315
    arr = np.tile(lons, (2, 1))  # each cell holds its own longitude
    rolled, new_lons = roll_longitude(arr, lons)
    assert new_lons.tolist() == [-180, -135, -90, -45, 0, 45, 90, 135]
    assert rolled[0].tolist() == [180, 225, 270, 315, 0, 45, 90, 135]


def test_roll_rejects_unexpected_longitudes():
    with pytest.raises(ValueError):
        roll_longitude(np.zeros((1, 4)), np.array([-180.0, -90.0, 0.0, 90.0]))


def test_convert_units():
    raw = {
        "u": np.array([1.0]),
        "v": np.array([-2.0]),
        "temperature": np.array([273.15]),
        "precipitation": np.array([1 / 3600]),
        "clouds": np.array([50.0]),
    }
    out = convert_units(raw)
    assert out["temperature"][0] == pytest.approx(0.0)
    assert out["precipitation"][0] == pytest.approx(1.0)  # mm/h
    assert out["u"][0] == 1.0 and out["clouds"][0] == 50.0


def test_grid_from_coords():
    lats = np.array([90.0, 89.0, 88.0])
    lons = np.array([-180.0, -179.0, -178.0, -177.0])
    assert grid_from_coords(lats, lons) == Grid(4, 3, -180.0, 90.0, 1.0, -1.0)


def test_grid_rejects_uneven_spacing():
    with pytest.raises(ValueError):
        grid_from_coords(np.array([90.0, 89.0]), np.array([0.0, 1.0, 3.0]))
```

`pipeline/tests/test_decode.py`:

```python
from pathlib import Path

import numpy as np

from zephyr_pipeline.decode import load_fields

FIXTURE = Path(__file__).parent / "fixtures" / "gfs_1p00_subset.grib2"


def test_fixture_decodes_to_five_physically_plausible_fields():
    fields, lats, lons = load_fields(FIXTURE)

    assert set(fields) == {"u", "v", "temperature", "precipitation", "clouds"}
    assert all(a.shape == (181, 360) for a in fields.values())
    assert lats[0] == 90 and lats[-1] == -90
    assert lons[0] == 0 and lons[-1] == 359

    assert 180 < fields["temperature"].min() and fields["temperature"].max() < 340  # K
    assert np.abs(fields["u"]).max() < 120 and np.abs(fields["v"]).max() < 120  # m/s
    assert fields["precipitation"].min() >= 0
    assert 0 <= fields["clouds"].min() and fields["clouds"].max() <= 100
```

**Step 2: Run to verify failure.**

```powershell
pipeline\.venv\Scripts\python -m pytest pipeline\tests\test_transform.py pipeline\tests\test_decode.py -q
```

Expected: FAIL — modules not found.

**Step 3: Implement**

`pipeline/zephyr_pipeline/decode.py` (names/units per M0 Task 2 — update if the
findings differ):

```python
from pathlib import Path

import cfgrib
import numpy as np

EXPECTED = {
    "u10": ("u", "m s**-1"),
    "v10": ("v", "m s**-1"),
    "t2m": ("temperature", "K"),
    "prate": ("precipitation", "kg m**-2 s**-1"),
    "tcc": ("clouds", "%"),
}


def load_fields(path: Path) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray]:
    fields: dict[str, np.ndarray] = {}
    lats = lons = None
    for ds in cfgrib.open_datasets(str(path), backend_kwargs={"indexpath": ""}):
        try:
            for name, da in ds.data_vars.items():
                if name not in EXPECTED:
                    continue
                field, units = EXPECTED[name]
                if da.attrs.get("units") != units:
                    raise ValueError(f"{name}: expected units {units!r}, got {da.attrs.get('units')!r}")
                if field in fields:
                    raise ValueError(f"{name} appears more than once")
                values = da.values.astype(np.float32)
                if not np.isfinite(values).all():
                    raise ValueError(f"{name} contains non-finite values")
                fields[field] = values
                ds_lats, ds_lons = ds.latitude.values, ds.longitude.values
                if lats is None:
                    lats, lons = ds_lats, ds_lons
                elif not (np.array_equal(lats, ds_lats) and np.array_equal(lons, ds_lons)):
                    raise ValueError(f"{name} is on a different grid")
        finally:
            ds.close()
    missing = {f for f, _ in EXPECTED.values()} - fields.keys()
    if missing:
        raise ValueError(f"GRIB file is missing fields: {sorted(missing)}")
    return fields, lats, lons
```

`pipeline/zephyr_pipeline/transform.py`:

```python
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Grid:
    width: int
    height: int
    lon0: float
    lat0: float
    dlon: float
    dlat: float


def roll_longitude(arr: np.ndarray, lons: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if lons[0] != 0 or lons[-1] >= 360 or np.any(np.diff(lons) <= 0):
        raise ValueError("expected ascending longitudes in [0, 360) starting at 0")
    k = int(np.searchsorted(lons, 180.0))
    new_lons = np.concatenate([lons[k:] - 360.0, lons[:k]])
    return np.concatenate([arr[..., k:], arr[..., :k]], axis=-1), new_lons


def convert_units(raw: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    out = dict(raw)
    out["temperature"] = raw["temperature"] - 273.15
    out["precipitation"] = raw["precipitation"] * 3600.0
    return out


def grid_from_coords(lats: np.ndarray, lons: np.ndarray) -> Grid:
    dlat, dlon = float(lats[1] - lats[0]), float(lons[1] - lons[0])
    if not (np.allclose(np.diff(lats), dlat) and np.allclose(np.diff(lons), dlon)):
        raise ValueError("grid spacing is not uniform")
    return Grid(int(lons.size), int(lats.size), float(lons[0]), float(lats[0]), dlon, dlat)
```

**Step 4: Run to verify pass.** Expected: `6 passed` (5 transform + 1 decode).

**Step 5: Commit**

```powershell
git add pipeline/zephyr_pipeline/decode.py pipeline/zephyr_pipeline/transform.py pipeline/tests/test_transform.py pipeline/tests/test_decode.py
git commit -m "Decode GFS fields and normalise units and longitudes

Units are validated against what cfgrib reported in M0 so an upstream change
fails loudly. Longitudes are rolled to -180..180 so texture column 0 is the
dateline and the shader needs no offset."
```

---

### Task 10: Quantization + PNG encoding

**Files:**
- Create: `pipeline/zephyr_pipeline/encode.py`
- Test: `pipeline/tests/test_encode.py`

**Step 1: Write the failing tests**

```python
import io

import numpy as np
import pytest
from PIL import Image

from zephyr_pipeline.encode import dequantize, encode_png, quantize


@pytest.mark.parametrize("encoding", ["linear", "sqrt"])
def test_round_trip_within_half_a_step(encoding):
    rng = np.random.default_rng(0)
    a = rng.uniform(0, 40, size=(50, 80)).astype(np.float32)
    lo, hi = 0.0, 40.0
    back = dequantize(quantize(a, lo, hi, encoding), lo, hi, encoding)
    if encoding == "linear":
        assert np.abs(back - a).max() <= (hi - lo) / 255 / 2 + 1e-4
    else:
        step = (np.sqrt(hi) - np.sqrt(lo)) / 255
        assert np.abs(np.sqrt(back) - np.sqrt(a)).max() <= step / 2 + 1e-4


def test_sqrt_keeps_light_values_that_linear_rounds_to_zero():
    a = np.array([0.05, 50.0], dtype=np.float32)  # linear: 0.255 -> 0; sqrt: 8.06 -> 8
    assert quantize(a, 0, 50, "linear")[0] == 0
    assert quantize(a, 0, 50, "sqrt")[0] > 0


def test_values_outside_range_are_clipped():
    q = quantize(np.array([-5.0, 15.0]), 0.0, 10.0)
    assert q.tolist() == [0, 255]


def test_constant_field_encodes_to_zero():
    assert quantize(np.full((2, 2), 7.0), 7.0, 7.0).tolist() == [[0, 0], [0, 0]]


def test_non_finite_values_rejected():
    with pytest.raises(ValueError):
        quantize(np.array([1.0, np.nan]), 0.0, 1.0)


def test_sqrt_rejects_negative_minimum():
    with pytest.raises(ValueError):
        quantize(np.array([1.0]), -1.0, 1.0, "sqrt")


def test_single_channel_png_is_greyscale():
    img = Image.open(io.BytesIO(encode_png([np.full((3, 4), 9, np.uint8)])))
    assert img.mode == "L" and img.size == (4, 3)


def test_two_channel_png_is_rgb_with_empty_blue():
    u = np.full((3, 4), 10, np.uint8)
    v = np.full((3, 4), 200, np.uint8)
    px = np.asarray(Image.open(io.BytesIO(encode_png([u, v]))))
    assert px.shape == (3, 4, 3)
    assert (px[..., 0] == 10).all() and (px[..., 1] == 200).all() and (px[..., 2] == 0).all()
```

**Step 2: Run to verify failure.** Expected: FAIL — module not found.

**Step 3: Implement**

```python
import io

import numpy as np
from PIL import Image


def _forward(a, vmin, vmax, encoding):
    if encoding == "linear":
        return a, vmin, vmax
    if encoding == "sqrt":
        if vmin < 0:
            raise ValueError("sqrt encoding needs vmin >= 0")
        return np.sqrt(np.maximum(a, 0)), np.sqrt(vmin), np.sqrt(vmax)
    raise ValueError(f"unknown encoding {encoding!r}")


def quantize(a: np.ndarray, vmin: float, vmax: float, encoding: str = "linear") -> np.ndarray:
    if not np.isfinite(a).all():
        raise ValueError("cannot quantize non-finite values")
    a, lo, hi = _forward(np.asarray(a, dtype=np.float64), vmin, vmax, encoding)
    if hi <= lo:
        return np.zeros(a.shape, np.uint8)
    return np.clip(np.rint((a - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8)


def dequantize(q: np.ndarray, vmin: float, vmax: float, encoding: str = "linear") -> np.ndarray:
    _, lo, hi = _forward(np.zeros(1), vmin, vmax, encoding)
    x = lo + q.astype(np.float64) / 255 * (hi - lo)
    return x**2 if encoding == "sqrt" else x


def encode_png(channels: list[np.ndarray]) -> bytes:
    # Two channels go in RGB, not LA: browsers premultiply alpha on upload,
    # which would corrupt the V component wherever it is small.
    if len(channels) == 1:
        img = Image.fromarray(channels[0])
    elif len(channels) == 2:
        img = Image.fromarray(np.dstack([channels[0], channels[1], np.zeros_like(channels[0])]))
    else:
        raise ValueError("encode_png takes 1 or 2 channels")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()
```

**Step 4: Run to verify pass.** Expected: `9 passed`.

**Step 5: Commit**

```powershell
git add pipeline/zephyr_pipeline/encode.py pipeline/tests/test_encode.py
git commit -m "Quantize fields to 8-bit PNGs (linear or sqrt)

sqrt encoding keeps light rain that linear 8-bit rounds to zero. Wind is
packed as RGB rather than LA to avoid alpha premultiplication in WebGL."
```

---

### Task 11: Manifest + build orchestration

**Files:**
- Create: `pipeline/zephyr_pipeline/build.py`
- Test: `pipeline/tests/test_build.py`

**Step 1: Write the failing tests**

```python
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
```

**Step 2: Run to verify failure.** Expected: FAIL — module not found.

**Step 3: Implement**

`pipeline/zephyr_pipeline/build.py`:

```python
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

# layer -> (fields, units, encoding). Precipitation encoding per M0 Task 3.
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
    tmp = out_dir / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, out_dir / "manifest.json")

    keep = {layer["file"] for layer in layers.values()}
    for path in out_dir.glob("*.png"):
        if _TEXTURE_NAME.match(path.name) and path.name not in keep:
            path.unlink()
    return manifest
```

The manifest is written only after every PNG exists, and replaced atomically,
so a reader never sees a manifest pointing at a missing texture.

**Step 4: Run to verify pass.** Expected: `4 passed`. Then the full suite:

```powershell
pipeline\.venv\Scripts\python -m pytest pipeline -q
```

Expected: `41 passed` (8 + 10 + 4 + 6 + 9 + 4).

**Step 5: Commit**

```powershell
git add pipeline/zephyr_pipeline/build.py pipeline/tests/test_build.py
git commit -m "Build manifest and hashed textures from a GRIB subset

Textures get content-hashed names for immutable caching; the manifest is
written last and atomically, and stale textures are pruned after."
```

---

### Task 12: CLI + first real run

**Files:**
- Create: `pipeline/zephyr_pipeline/__main__.py`

**Step 1: Implement** (thin glue over tested parts; verified by a real run
rather than unit tests)

```python
import argparse
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .build import build
from .cycles import NoRunAvailable, pick_run
from .fetch import download_subset, grib_url, url_exists


def _aware(value: str) -> datetime:
    t = datetime.fromisoformat(value)
    if t.tzinfo is None:
        raise argparse.ArgumentTypeError("--now needs a timezone, e.g. 2026-09-23T14:00Z")
    return t


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="zephyr_pipeline", description="Build zephyr textures from the latest GFS run")
    p.add_argument("--out", type=Path, required=True, help="output directory, e.g. web/public/data")
    p.add_argument("--resolution", choices=["0p25", "0p50", "1p00"], default="0p25")
    p.add_argument("--now", type=_aware, help="pretend current time (ISO 8601 with timezone)")
    args = p.parse_args(argv)

    now = args.now or datetime.now(timezone.utc)
    try:
        run = pick_run(now, lambda r: url_exists(grib_url(r, args.resolution) + ".idx"))
    except NoRunAvailable as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(f"GFS {run.cycle_time:%Y-%m-%d %H}z f{run.fhour:03d}, valid {run.valid_time:%Y-%m-%d %H:%M}Z")

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        grib = Path(tmp) / "subset.grib2"
        grib.write_bytes(download_subset(run, resolution=args.resolution))
        manifest = build(args.out, grib, run, datetime.now(timezone.utc))

    for name, layer in manifest["layers"].items():
        size = (args.out / layer["file"]).stat().st_size / 1024
        print(f"  {name:13} {layer['file']:32} {size:7.1f} KiB  {layer['min']} .. {layer['max']} {layer['units']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

**Step 2: Run against a fixed time (reproducible)**

```powershell
pipeline\.venv\Scripts\python -m zephyr_pipeline --out web\public\data --now 2026-09-23T05:40Z
```

Expected: `GFS 2026-09-23 00z f006, valid 2026-09-23 06:00Z` (05:40 falls in
the 00z cycle; 5 h 40 m rounds to f006; the archived file exists). Four texture lines with
plausible ranges: temperature roughly −70..+50 °C, wind components within
±60 m/s, clouds 0..100 %, precipitation 0..~100 mm/h.

**Step 3: Run for "now"**

```powershell
pipeline\.venv\Scripts\python -m zephyr_pipeline --out web\public\data
```

Expected: picks a run 4–10 h old; the previous run's PNGs are gone from
`web\public\data` (unless nothing changed) and `manifest.json` points at the
new ones.

**Step 4: Eyeball the textures**

Open `web\public\data\temperature.*.png`. Expected: recognisable continents,
with Antarctica dark at the bottom, and the Americas on the left half
(column 0 = 180°). If the image is mirrored or split at the Greenwich meridian,
the roll is wrong. Stop and debug with superpowers:systematic-debugging.

**Step 5: Commit**

```powershell
git add pipeline/zephyr_pipeline/__main__.py
git commit -m "Add pipeline CLI

Exits 2 when no recent run is published, so the scheduled job can fail
without deploying and the site keeps its last good data."
```

**Checkpoint:** M1 done. Next, plan M2–M6 using the M0 findings.
