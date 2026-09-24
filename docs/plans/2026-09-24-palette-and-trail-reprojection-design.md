# Multi-hue temperature scale + reprojected wind trails — Design

**Date:** 2026-09-24 · **Status:** approved · **Slots in:** between M3 and M4

## Why

1. **Palette.** Area-weighted, 46% of the globe sat between 20 and 30 °C on
   2026-09-24 (median 20.3 °C), but the diverging scale (white at 0 °C) gave
   that band only ~12% of its color range, so the globe read as flat orange.
   Considered: neutral at 25 °C (would turn ~half the globe near-white and
   make 15 °C read "cold"); redistributing the old hues (smallest change, still
   warm-heavy). Chosen: a multi-hue weather-map scale.
2. **Trails while rotating.** Trails live in screen space, so they smeared off
   the globe when the camera moved; M3 hid them during motion. Considered:
   dots without trails while dragging; map-space trails (blur on zoom, pole
   stretch); 3D line trails (~8× geometry, loses the fade look). Chosen:
   reproject the previous trail image through the camera change.

## 1. Multi-hue temperature scale

- Domain stays −40…45 °C; stops densest where the area is: −40 deep purple,
  −25 violet, −10 blue, 0 cyan (freezing stays a landmark), 8 teal, 15 green,
  20 yellow-green, 24 yellow, 28 orange, 32 red, 38 crimson, 45 dark magenta.
- Each scalar layer declares legend ticks at meaningful values (temperature
  −40, −20, 0, 20, 40; precipitation 0, 1, 5, 20, 50; clouds 0, 50, 100),
  placed at their position along the (possibly sqrt) scale.
- A test checks every scale's stops ascend and lie in its domain, and ticks lie
  in the domain. Colors are judged by eye on the real globe; the colorblind
  review stays in M6.

## 2. Reprojected trails

Each frame the fade pass, per pixel:
1. Casts a ray from the current camera position through the pixel and
   intersects the trail sphere (r = 1.002). Miss → 0.
2. If that surface point was on the far side from the previous camera → 0.
3. Projects it with the previous frame's view-projection; outside the previous
   screen → 0; otherwise samples the previous trail image there × fade.

The "hide while moving" logic is removed; particles draw every frame.

The math has a TypeScript twin (`reproject.ts`) tested in Vitest, like
`geo.ts`. Key property: the returned previous-frame UV, cast through the
previous camera, hits the same surface point as the current pixel. Plus: no
motion → UV unchanged; off-globe → null; point hidden last frame → null.

**Known limitation:** zooming resamples the trail image, so streaks soften
briefly mid-zoom.

## Colour-vision review (M6, 2026-09-24) — decision: keep this palette

Reviewed with the dataviz skill's validator (Machado CVD simulation, OKLab ΔE×100)
over every pair of 1 °C samples at least 10 / 15 °C apart:

| ≥15 °C apart, pairs with ΔE < 8 | normal | deutan | protan | tritan |
| --- | --- | --- | --- | --- |
| shipped multi-hue scale | 0 | 12 (worst 15 vs 30 °C, 4.8) | 4 | 35 (worst −4 vs 11 °C, 3.1) |
| CVD-safe alternative (lightness peak at 18 °C) | 0 | 0 | 0 | 0 |

Cause: lightness peaks at yellow (24 °C), so green (~17 °C) and orange (~27 °C) sit at
equal lightness and collapse for red-green colour-blind viewers. The alternative
(stops −40 #5a1b6b, −25 #5a42b2, −10 #3778d7, 0 #22a9dc, 10 #56d3da, 18 #b6f6d2,
23 #e5e261, 28 #f6b324, 32 #f37513, 38 #d03830, 45 #97182b) fixes it but makes the
tropics amber/orange again. **The user chose to keep the shipped palette**; the hover
readout (exact °C) and the legend ticks are the secondary encoding. Revisit if the
project targets accessibility compliance.
