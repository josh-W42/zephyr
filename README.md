# zephyr

**Live wind and weather on a 3D globe** — https://zephyr-globe.web.app

About 65,000 GPU-animated wind particles flow over switchable temperature,
precipitation and cloud-cover layers from NOAA's GFS weather model. The data
refreshes every 6 hours with no server: a scheduled GitHub Action turns the
latest model run into a few PNG textures, and the site is static files on
Firebase Hosting.

Sibling of [apsis](https://apsis-globe.web.app), a satellite-tracker globe
built on the same shape: precomputed data, a hand-built Three.js globe, and a
staleness banner.

## How it works

```
GitHub Actions (04:30 / 10:30 / 16:30 / 22:30 UTC)
  pipeline/ (Python 3.11)
    NOAA GFS on AWS ── .idx inventory + HTTP Range ──► 6 GRIB2 messages (~3 MB, not ~500 MB)
    cfgrib decode ─► units + longitudes −180..180 ─► 8-bit PNGs (content-hashed) + manifest.json
  vite build ─► Firebase Hosting (manifest no-cache, textures immutable)

Browser (web/, TypeScript + Three.js r186)
  manifest.json (validated) ─► textures as ImageBitmaps (no colour conversion)
     ├─ globe fragment shader: lon/lat from surface direction → texel centre →
     │    land-mask basemap + coastline → colour layer
     ├─ GPU wind: particles in a float texture (GPUComputationRenderer),
     │    advected in lon/lat → points → fading trail target, reprojected
     │    through camera motion → composited over the globe
     └─ CPU copy of each texture → hover / keyboard readout
```

## Decisions worth knowing

| Decision | Why |
| --- | --- |
| Byte-range downloads from the AWS GFS mirror, not the NOMADS filter | Exact messages, no rate limiting, and past runs stay archived, so test fixtures are reproducible. |
| Match instantaneous steps explicitly (`anl` / `N hour fcst`) | Forecast files carry both instantaneous and 0–N hour *averaged* precipitation and cloud cover. |
| 8-bit PNGs; square-root encoding for precipitation | ~1.8 MiB for all layers; linear 8-bit erased 4.2% of rainy cells. |
| Texel-centre mapping (`gridTexUV`) | GFS values sit on grid points; without the half-texel offset every layer shifts by 0.125°. |
| Basemap from GFS's own land mask | Land/ocean shading and coastlines with no third-party map image or licence. |
| Particles on the GPU | ~65k particles with ≥16× headroom on a desktop GPU; advecting on the CPU (e.g. in a worker, as apsis does for satellites) would mean uploading every position each frame. |
| Screen-space trails, reprojected each frame | Crisp at any zoom, and still attached to the globe while dragging (each pixel ray-casts the sphere and samples last frame where that point was). |
| Content-hashed textures + manifest written last, atomically | Browsers cache textures forever and never see a manifest that points at a missing file. |
| Deploy key with only *Firebase Hosting Admin* | Least privilege; verified sufficient for the deploy action. |

## How it was verified

- **Pipeline:** 42 pytest tests, including decoding a real 1° GRIB2 fixture and a
  PNG round trip checked at known points on both sides of the dateline.
- **Web:** 91 Vitest tests. The shaders' math has tested TypeScript twins
  (`geo.ts`, `reproject.ts`).
- **Readout vs data:** browser values are byte-identical to Python reading the
  same PNG, at London, in the Sahara, and across the dateline.
- **Wind direction:** dev-only debug fields with closed-form motion (for
  rotation about +X, flow goes north at 90°E, south at 90°W and west at
  0°/45°N), measured from GPU particle state, and 1/cos(latitude) scaling
  within 1%. On real data, the westerlies and trade winds move in the
  directions the data's own u/v means predict.

## Performance

Measured with `?bench=20` (20 s after a 3 s warm-up, read once at the end; runs
with hidden frames are invalid). NVIDIA RTX 3070 Ti, Chrome:

| Viewport | Particles | p50 | p95 | worst |
| --- | --- | --- | --- | --- |
| 1344×417 | 65k (256²) | 16.7 ms | 16.8 ms | 17.0 ms |
| 1344×417 | 262k / 1.04M | 16.7 ms | 16.8 ms | 16.9 ms |
| 1920×1080 | 65k | 16.7 ms | 16.8 ms | 16.8 ms |

It's vsync-locked throughout, so these show headroom, not a ceiling. Phones
default to 16k particles; real mobile devices have not been benchmarked. Try
`?bench=20&particles=128` on one.

## Accessibility

WCAG 2.1 AA pass: keyboard control of the globe (focus it, then arrows rotate,
Shift for bigger steps, and +/− zoom; the readout describes the centre point),
a live readout region, ≥4.5:1 text contrast even over white clouds, and the
wind animation off by default under `prefers-reduced-motion`.

Known limitation: the multi-hue temperature scale makes about 17 °C and 27 °C
hard to tell apart for red-green colour-blind viewers. The readout gives exact
values. A measured colour-blind-safe alternative is documented in
`docs/plans/2026-09-24-palette-and-trail-reprojection-design.md`.

## Run it locally

```bash
py -3.11 -m venv pipeline/.venv
pipeline/.venv/Scripts/python -m pip install -e "pipeline[dev]"
pipeline/.venv/Scripts/python -m zephyr_pipeline --out web/public/data
npm --prefix web install
npm --prefix web run dev
```

Tests: `pipeline/.venv/Scripts/python -m pytest pipeline -q` and
`npm --prefix web test`.

Dev-only URL switches: `?debug=eastward|rotation` (synthetic winds),
`?nofloat` (no-float-texture fallback), `?now=<ISO time>` (staleness banner).
Anywhere: `?bench=<seconds>` and `?particles=<grid side>`.

## Operations

- **Refresh on demand:** `gh workflow run refresh-data -f deploy=true`, or
  `-f deploy=false` for a dry run.
- **If the refresh stops:** the site keeps serving the last good data, and the
  banner appears once it is over 12 hours old. GitHub disables scheduled
  workflows in public repos after 60 days without activity; any commit or a
  manual run restarts them.
- **Secrets:** `FIREBASE_SERVICE_ACCOUNT` (secret), `FIREBASE_PROJECT_ID`
  (variable).

## Layout

- `pipeline/`: GFS → textures (`zephyr_pipeline/`), tests and a real GRIB2
  fixture. `spikes/` holds the M0 probe scripts kept as evidence.
- `web/`: the Vite app. `uv-probe.html` is the M0 sphere-alignment probe.
- `docs/plans/`: design, findings and implementation plans, in order.

Data: NOAA Global Forecast System via the NOAA Open Data Dissemination program.
