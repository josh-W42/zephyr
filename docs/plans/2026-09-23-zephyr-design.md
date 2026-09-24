# zephyr — Design

**Date:** 2026-09-23
**Status:** Approved design, pre-implementation
**Sibling project:** [apsis](https://apsis-globe.web.app) (live satellite-tracker globe)

## Summary

zephyr is a live 3D globe showing current global weather conditions: animated
wind particles flowing over switchable color layers (temperature,
precipitation, cloud cover). It is a portfolio piece, deployed and polished,
and deliberately mirrors apsis's proven shape: precomputed static data refreshed
on a schedule, a hand-built Three.js globe, Firebase Hosting, and a staleness
banner. No server.

## Goals

- Striking, smooth wind-flow animation over a 3D globe.
- Switchable scalar layers with legend and hover readout.
- Data refreshed automatically every 6 hours, free to host.
- A clean architecture story for interviews (pipeline → textures → GPU).

## Non-goals (v1)

- Historical playback or climate-change-over-time views.
- Air quality (not in GFS; would need Copernicus CAMS or Open-Meteo AQ).
- Forecast scrubbing, point forecasts, user accounts.

## Architecture

```
GitHub Actions (cron, 6h)
  └─ pipeline/ (Python)
       AWS GFS 0.25° (.idx + Range) ─► xarray+cfgrib decode ──► 8-bit PNG textures
                                                          └► manifest.json
  └─ firebase deploy (Hosting)
                                   │
Browser (web/, Vite + TS + Three.js)
  manifest.json ──► load textures ──► color-layer shader on sphere
                                  └─► GPU wind particles (ping-pong) ──► screen-space trails
```

Repo layout: `pipeline/`, `web/`, `.github/workflows/refresh.yml`, `docs/`.

## Data pipeline

1. **Select cycle.** GFS runs at 00/06/12/18z and appears roughly 4–5 h after
   cycle time. Pick the latest cycle whose file for the forecast hour closest
   to "now" exists (0p25 files are hourly), typically f004–f006.
2. **Download a subset** from the NOAA Open Data mirror on AWS
   (`noaa-gfs-bdp-pds`) using the per-file `.idx` inventory and HTTP Range
   requests: UGRD/VGRD at 10 m, TMP at 2 m, PRATE (surface), TCDC (entire
   atmosphere). ~0.5 MB per field instead of ~500 MB. Chosen over the NOMADS
   filter (verified 2026-09-23): exact messages, no NOMADS rate limiting, and
   the bucket archives past runs so test fixtures are reproducible.
   Forecast files carry both an instantaneous and an "0-N hour ave" message
   for PRATE and TCDC, so selection must match the instantaneous step
   (`anl` or `N hour fcst`) explicitly.
3. **Decode** with `xarray` + `cfgrib`; roll longitudes 0–360 → −180–180.
4. **Encode** each field as an 8-bit PNG, linearly quantized between per-field
   min/max. Wind: U→R, V→G. Scalars: R. Temperature resolves to ~0.5 °C.
5. **Manifest** (`manifest.json`): per-layer file name, min/max, units; GFS
   cycle, forecast hour, valid time, generated-at time.
6. **Deploy** to Firebase Hosting. Textures use content-hashed names with
   immutable caching; `manifest.json` is `no-cache`. Deploy auth: service
   account with the Firebase Hosting Admin role only, stored as a GitHub secret.

**Failure handling.** If NOMADS is down or the cycle is incomplete, the job
exits without deploying; the site keeps serving the last good data. The
frontend shows a staleness banner when valid time is > ~12 h old.

**Size.** Native 0.25° grid is 1440×721. Measure in M0; downsample to 0.5° if
the wind PNG is much over ~1 MB.

## Frontend

**Globe.** Three.js sphere with a muted dark basemap so data layers dominate.

**Color layers.** One `ShaderMaterial` samples the active field texture by
equirectangular UV, decodes with manifest min/max uniforms, and maps through a
1D colormap LUT texture. Temperature: diverging blue→red. Precipitation and
clouds: alpha ramps to transparent near zero. Longitude uses repeat wrapping
(no dateline seam). Switching layers swaps a texture and uniforms.

**Wind particles (GPU).** Technique after Mapbox `webgl-wind`:
- ~65k particles (16k on mobile) stored as lon/lat in a float texture, updated
  with Three's `GPUComputationRenderer` (ping-pong render targets).
- Update pass samples the wind texture at each particle, advances position with
  the longitude step scaled by 1/cos(lat), and randomly respawns a small
  fraction per frame to prevent clumping.
- Draw pass renders points slightly above the surface, colored by speed.

**Trails.** Screen-space fade: each frame, fade the previous frame's texture
and draw particles on top. Crisp at any zoom; particles hide while the camera
is being dragged and fade back in afterward (the earth.nullschool approach).
Rejected alternative: map-space equirectangular trail texture, which avoids
smearing but blurs on zoom and distorts near the poles.

**UI (apsis-style sidebar).**
- Layer picker: Temperature / Precipitation / Clouds / None; wind toggle.
- Legend with colorbar and units.
- Hover readout: raycast sphere → lon/lat → lookup in a CPU-side copy of the
  field. Approximate (8-bit data), e.g. ±0.25 °C.
- Timestamp: "Valid 15:00 UTC · GFS 12z run"; staleness banner.

**Fallback.** If float render targets are unsupported, disable wind animation
with a short notice; color layers still work.

## Testing

**Pipeline (pytest).**
- Encode/decode round-trip within quantization tolerance.
- Longitude roll: known-longitude values land in the correct pixel.
- Cycle selection as a pure function of (now, available cycles), including
  just-after-cycle, missing cycles, and date rollover.
- A small real GRIB2 fixture checked in, so decoding is tested on real data.

**Frontend (Vitest).** lat/lon ↔ UV ↔ 3D conversions at known points (poles,
0/0, dateline), value decode, hover lookup with dateline wrap, staleness
threshold.

**Shaders.** Debug wind fields selectable by URL param (uniform eastward;
solid-body rotation) whose correct motion is obvious by eye, including at the
poles. Verified in the browser with screenshots.

**CI.** PRs run both test suites; the refresh workflow has a dry-run mode that
builds artifacts without deploying.

## Milestones

| #  | Milestone | Done when |
| -- | --------- | --------- |
| M0 | Spike unknowns | Byte-range subset fetch, cfgrib decode names/units (Windows + Linux), PNG sizes, sphere UV alignment all confirmed or resolved |
| M1 | Pipeline locally | `manifest.json` + PNGs written into `web/public/data` |
| M2 | Globe + temperature | Temperature layer, legend, hover readout |
| M3 | GPU wind | Particles + trails, verified against debug fields |
| M4 | Layers + UI | Precip, clouds, sidebar, staleness banner, fallback |
| M5 | Automation | Scheduled Action + new Firebase project + deploy |
| M6 | Polish | Mobile perf, frame-time benchmarks, README architecture story |

## M0 findings (2026-09-23)

Evidence: commits `87572d5`..`76a9e0c`, scripts in `pipeline/spikes/`.

**ecCodes / cfgrib.**
- Windows, Python 3.11: `pip install eccodes cfgrib` works; the Windows
  `eccodes` wheel (cp311-win_amd64) bundles `eccodes.dll`.
  `python -m cfgrib selfcheck` → `Found: ecCodes v2.48.0. Your system is ready.`
- Linux: the `eccodes` wheel is pure Python and depends on `eccodeslib` via
  `platform_system != "Windows"`; `eccodeslib` publishes
  `cp311 manylinux_2_28_x86_64` wheels, which the GitHub Ubuntu runner supports.
  **Not executed on Linux yet**: Docker Desktop was not running and WSL Ubuntu
  has no pip/venv (needs `sudo apt install python3-venv`). First real Linux
  run is the M5 CI job.
- Versions: numpy 2.4.6, xarray 2026.7.0, cfgrib 0.9.15.1, eccodes 2.48.0,
  pillow 12.3.0, pytest 9.1.1 (pinned as minimums in `pyproject.toml`).
- cfgrib triggers an xarray `FutureWarning` (merge `compat` default changing).
  Harmless now; M1 opts in to the new defaults inside `load_fields` so the
  fixture test would catch any behaviour change.

**Download + decode** (`probe_download.py 20260923 0 6`).
- All 15 Range requests (5 fields × 0p25/0p50/1p00) → `HTTP 206`, each a
  complete GRIB message (`GRIB`…`7777`). Missing key HEAD → `404`.
- 0p25 subset 3.1 MiB, 0p50 0.95 MiB, 1p00 276 KiB.
- cfgrib names/units, all `stepType=instant`: `u10`/`v10` `m s**-1`,
  `t2m` `K`, `prate` `kg m**-2 s**-1`, `tcc` `%` (typeOfLevel `atmosphere`).
- Grid: latitude 90 → −90, longitude 0 → 359.75 (0p25: 721×1440).

**Textures** (`probe_png.py`, 8-bit, Pillow `optimize=True`).

| Resolution | wind RGB | temperature | precipitation | clouds | total |
| --- | --- | --- | --- | --- | --- |
| 0p25 | 684 KiB | 237 KiB | 90 KiB | 497 KiB | ~1.5 MiB |
| 0p50 | 231 KiB | 80 KiB | 33 KiB | 131 KiB | ~0.5 MiB |

Decision: **stay at 0p25**. Precipitation: linear 8-bit zeroes 4.2% of rainy
(>0.1 mm/h) cells at 0p25 (max 55.8 mm/h); sqrt zeroes none → **sqrt
encoding** for precipitation.

**Sphere alignment** (`web/uv-probe.html`, three r186 — same as apsis).
Default `SphereGeometry` UVs + texture with column 0 = −180°, row 0 = +90°,
default `flipY`: `lonLatToVec3(lon, lat) = (cos lat·cos lon, sin lat,
−cos lat·sin lon)` places markers exactly on 0°, 90°E, 90°W and 180°. No seam
at the dateline with `RepeatWrapping`; north cap centred; not mirrored
(from 45°E, 0° is left of 90°E). No console errors.

**Tooling.** The preview tool reads `claude/.claude/launch.json` (the session
root), which already serves ipa-captions on 5173; zephyr's dev server is the
`zephyr-web` entry on **port 5174** (`--strictPort`).
