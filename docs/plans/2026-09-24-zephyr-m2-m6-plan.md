# zephyr M2–M6 Implementation Plan

> **For Claude:** Execute inline in this session (user preference — no subagents,
> no separate session). Follow superpowers:executing-plans checkpoint discipline:
> run every verification, commit per task with the reasoning in the message, and
> surface findings that contradict this plan instead of quietly adapting.

**Goal:** Turn the M1 pipeline output into the deployed zephyr site: a Three.js
globe with switchable color layers, GPU wind particles with trails, an
apsis-style sidebar, scheduled refresh + Firebase deploy, and a polish pass.

**Architecture:** The browser loads `manifest.json`, validates it, and loads
textures as `ImageBitmap`s decoded *without* color conversion; each becomes both
a GPU texture and a CPU pixel copy for hover readouts. The globe's fragment
shader derives lon/lat from the surface direction, maps it to grid texel
centers, and composites land mask → color layer → coastline. Wind particles
live in a float texture advanced by `GPUComputationRenderer`; they are drawn as
points into a fading screen-space trail target that is composited over the
globe, and hidden while the camera moves.

**Tech stack:** TypeScript, Vite 8, three r186 (+ `OrbitControls`,
`GPUComputationRenderer`, `FullScreenQuad` addons), Vitest (**new dev
dependency — verify before install**), GitHub Actions, Firebase Hosting.

**Verified before writing this plan (2026-09-24):**
- `GPUComputationRenderer` (r186): `addVariable(name, frag, initTex)`,
  `setVariableDependencies`, `init()` → error string or `null`, `compute()`,
  `getCurrentRenderTarget(v)`, `createTexture()`; dependency samplers are
  injected as `uniform sampler2D <name>`; `resolution` is a define. `init()`
  only checks vertex-texture support — **not** float render targets, so zephyr
  checks `EXT_color_buffer_float` itself.
- GFS files contain `LAND:surface` → cfgrib `lsm`, units `'(0 - 1)'`,
  `instant`, values exactly {0, 1}.
- `gh` is logged in as `josh-W42`; the repo has no remote yet.
- M0: `lonLatToVec3 = (cos φ cos λ, sin φ, −cos φ sin λ)` matches the sphere.

**Conventions used throughout.**
- *Texture orientation:* every data texture is uploaded with `flipY = false`,
  so texture row 0 (north, `lat0 = 90`) is at v = 0. The shaders never use
  the sphere's built-in UVs; they compute lon/lat from the surface direction.
- *Grid points, not cells:* GFS values sit on grid points (col 0 is exactly
  −180°). Texel *centers* are at (j + 0.5)/W, so lon/lat → UV must add half a
  texel (`gridTexUV`). Getting this wrong shifts everything by 0.125°.
- *Display-space colors:* color-scale bytes are sRGB values written straight to
  the canvas; shaders omit `<colorspace_fragment>`, and data textures use
  `NoColorSpace`.
- All paths are relative to `C:\Users\wilso\Documents\programming\claude\zephyr`.
  Web tests: `npm --prefix web test`. Pipeline tests:
  `pipeline\.venv\Scripts\python -m pytest pipeline -q`.
- Dev server: `preview_start` with name `zephyr-web` (port 5174). Regenerate
  data with `pipeline\.venv\Scripts\python -m zephyr_pipeline --out web\public\data`.

---

## M2 — Globe, land mask, temperature layer

### Task 1: Export the land mask from the pipeline

**Files:**
- Modify: `pipeline/zephyr_pipeline/fetch.py` (`WANTED`)
- Modify: `pipeline/zephyr_pipeline/decode.py` (`EXPECTED`)
- Modify: `pipeline/zephyr_pipeline/build.py` (`LAYERS`)
- Modify: `pipeline/tests/test_fetch.py`, `pipeline/tests/test_decode.py`, `pipeline/tests/test_build.py`
- Regenerate: `pipeline/tests/fixtures/gfs_1p00_subset.grib2`

**Step 1: Update the tests first**

`test_fetch.py` — add LAND as the last message in the fake file, expect it last
in the output, and include it in the covered set:

```python
ORDER = [
    ("TMP", "2 m above ground", "5 hour fcst"),
    ("UGRD", "10 m above ground", "5 hour fcst"),
    ("VGRD", "10 m above ground", "5 hour fcst"),
    ("PRATE", "surface", "5 hour fcst"),
    ("PRATE", "surface", "0-5 hour ave fcst"),
    ("TCDC", "entire atmosphere", "5 hour fcst"),
    ("LAND", "surface", "5 hour fcst"),
]
```

```python
    assert data == (
        message(b"U") + message(b"V") + message(b"T") + message(b"P") + message(b"T") + message(b"L")
    )
    assert calls[0] == (url + ".idx", None)
    assert calls[-1][1].endswith("-")  # LAND is last in the file: open-ended range
```

```python
def test_wanted_covers_the_six_fields():
    assert {v for v, _ in WANTED} == {"UGRD", "VGRD", "TMP", "PRATE", "TCDC", "LAND"}
```

(Delete `test_wanted_covers_the_five_fields`.)

`test_decode.py`:

```python
    assert set(fields) == {"u", "v", "temperature", "precipitation", "clouds", "land"}
```

and append:

```python
    assert set(np.unique(fields["land"]).tolist()) <= {0.0, 1.0}
    assert 0.2 < fields["land"].mean() < 0.45  # ~29% of Earth is land; GFS counts Antarctica
```

`test_build.py`:

```python
    assert set(m["layers"]) == {"wind", "temperature", "precipitation", "clouds", "land"}
```

and add:

```python
def test_land_mask_is_binary_texture(tmp_path):
    m = build(tmp_path, FIXTURE, RUN, GENERATED)
    land = m["layers"]["land"]
    assert (land["min"], land["max"]) == ([0.0], [1.0])
    assert set(np.unique(pixels(tmp_path / land["file"])).tolist()) == {0, 255}
```

**Step 2: Run to verify failure**

```powershell
pipeline\.venv\Scripts\python -m pytest pipeline -q
```

Expected: failures in test_fetch (missing LAND handling), test_decode and
test_build (no `land` field).

**Step 3: Implement**

`fetch.py` — append to `WANTED`: `("LAND", "surface"),`
`decode.py` — add to `EXPECTED`: `"lsm": ("land", "(0 - 1)"),`
`build.py` — add to `LAYERS`: `"land": (["land"], "", "linear"),`

**Step 4: Regenerate the fixture with the pipeline's own downloader**

```powershell
pipeline\.venv\Scripts\python -c "from datetime import datetime, timezone; from pathlib import Path; from zephyr_pipeline.cycles import Run; from zephyr_pipeline.fetch import download_subset; Path('pipeline/tests/fixtures/gfs_1p00_subset.grib2').write_bytes(download_subset(Run(datetime(2026, 9, 23, 0, tzinfo=timezone.utc), 6), resolution='1p00'))"
```

**Step 5: Run to verify pass**

Expected: **42 passed** (fetch 4, idx 10, cycles 8, transform 5, decode 1,
encode 9, build 5).

**Step 6: Regenerate web data and commit**

```powershell
pipeline\.venv\Scripts\python -m zephyr_pipeline --out web\public\data
git add pipeline
git commit -m "Export the GFS land mask as a sixth texture

The globe draws its basemap (land/ocean shading and coastline) from this
mask, so no third-party map image is needed. Fixture regenerated from the
same archived run with the pipeline's own downloader."
```

---

### Task 2: Vitest + geographic math

**Files:**
- Modify: `web/package.json` (script `test`)
- Create: `web/src/geo.ts`, `web/src/geo.test.ts`

**Step 1: Install Vitest** (new dev dependency)

```powershell
npm --prefix web install -D vitest
```

Add to `web/package.json` scripts: `"test": "vitest run"`.

**Step 2: Write the failing tests** — `web/src/geo.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { gridIndex, gridTexUV, lonLatToVec3, vec3ToLonLat, wrapLon, type Grid } from "./geo";

const G: Grid = { width: 1440, height: 721, lon0: -180, lat0: 90, dlon: 0.25, dlat: -0.25 };

function close(a: number[], b: number[]) {
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));
}

describe("lonLatToVec3 (axes confirmed in M0)", () => {
  it.each([
    [0, 0, [1, 0, 0]],
    [90, 0, [0, 0, -1]],
    [-90, 0, [0, 0, 1]],
    [180, 0, [-1, 0, 0]],
    [0, 90, [0, 1, 0]],
  ])("(%d, %d)", (lon, lat, xyz) => close(lonLatToVec3(lon, lat), xyz));
});

describe("vec3ToLonLat", () => {
  it.each([[10, 20], [-120.5, -45.25], [179, 1], [-179, -89]])("round-trips (%d, %d)", (lon, lat) => {
    close(vec3ToLonLat(lonLatToVec3(lon, lat, 3.2)), [lon, lat]);
  });
});

describe("wrapLon", () => {
  it.each([[190, -170], [-190, 170], [180, -180], [0, 0]])("%d -> %d", (a, b) => expect(wrapLon(a)).toBeCloseTo(b));
});

describe("gridTexUV hits texel centers", () => {
  it("first grid point", () => close(gridTexUV(-180, 90, G), [0.5 / 1440, 0.5 / 721]));
  it("origin", () => close(gridTexUV(0, 0, G), [720.5 / 1440, 360.5 / 721]));
  it("last column", () => close(gridTexUV(179.75, 0, G), [1439.5 / 1440, 360.5 / 721]));
  it("lon 180 wraps to column 0", () => close(gridTexUV(180, -90, G), [0.5 / 1440, 720.5 / 721]));
});

describe("gridIndex (nearest grid point)", () => {
  it("origin", () => expect(gridIndex(0, 0, G)).toEqual([720, 360]));
  it("London", () => expect(gridIndex(-0.13, 51.5, G)).toEqual([719, 154]));
  it("wraps east of the last column", () => expect(gridIndex(179.9, 0, G)).toEqual([0, 360]));
  it("wraps west of the dateline", () => expect(gridIndex(-180.1, 0, G)).toEqual([0, 360]));
  it("clamps latitude", () => expect(gridIndex(0, 95, G)[1]).toBe(0));
});
```

**Step 3: Run to verify failure**

```powershell
npm --prefix web test
```

Expected: FAIL — cannot resolve `./geo`.

**Step 4: Implement** — `web/src/geo.ts`

```ts
export interface Grid {
  width: number;
  height: number;
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
}

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export function lonLatToVec3(lon: number, lat: number, r = 1): Vec3 {
  const lo = lon * RAD;
  const la = lat * RAD;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo)];
}

export function vec3ToLonLat([x, y, z]: Vec3): [number, number] {
  return [Math.atan2(-z, x) / RAD, Math.asin(y / Math.hypot(x, y, z)) / RAD];
}

export function wrapLon(lon: number): number {
  return mod(lon + 180, 360) - 180;
}

export function gridTexUV(lon: number, lat: number, g: Grid): [number, number] {
  const u = mod(((lon - g.lon0) / g.dlon + 0.5) / g.width, 1);
  const v = ((lat - g.lat0) / g.dlat + 0.5) / g.height;
  return [u, v];
}

export function gridIndex(lon: number, lat: number, g: Grid): [number, number] {
  const col = mod(Math.round((lon - g.lon0) / g.dlon), g.width);
  const row = Math.min(g.height - 1, Math.max(0, Math.round((lat - g.lat0) / g.dlat)));
  return [col, row];
}

// GLSL twins of the functions above; the shaders' behaviour is verified in the
// browser against the tested TypeScript versions.
export const GLSL_GEO = /* glsl */ `
uniform vec4 uGrid;      // lon0, lat0, dlon, dlat
uniform vec2 uGridSize;  // width, height
vec3 lonLatToDir(vec2 ll) {
  vec2 r = radians(ll);
  return vec3(cos(r.y) * cos(r.x), sin(r.y), -cos(r.y) * sin(r.x));
}
vec2 dirToLonLat(vec3 d) {
  return vec2(degrees(atan(-d.z, d.x)), degrees(asin(clamp(d.y, -1.0, 1.0))));
}
vec2 gridTexUV(vec2 ll) {
  return vec2(((ll.x - uGrid.x) / uGrid.z + 0.5) / uGridSize.x,
              ((ll.y - uGrid.y) / uGrid.w + 0.5) / uGridSize.y);
}
`;
```

(`gridTexUV` in GLSL leaves u unwrapped; `RepeatWrapping` on S handles it.)

**Step 5: Run to verify pass.** Expected: 22 geo tests pass.

**Step 6: Commit**

```powershell
git add web/package.json web/package-lock.json web/src/geo.ts web/src/geo.test.ts
git commit -m "Add geographic math with texel-center grid mapping

GFS values sit on grid points, so lon/lat -> UV adds half a texel; otherwise
every layer would be offset by 0.125 degrees. Vitest added as a dev dependency."
```

---

### Task 3: Manifest parsing, value decoding, staleness

**Files:**
- Create: `web/src/manifest.ts`, `web/src/manifest.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { decodeValue, ManifestError, parseManifest, staleness, type Layer } from "./manifest";

const layer = (file: string, n = 1, encoding = "linear") => ({
  file, units: "x", encoding, min: Array(n).fill(0), max: Array(n).fill(10),
});

const SAMPLE = {
  version: 1,
  run: { cycle: "2026-09-24T00:00:00Z", fhour: 5 },
  validTime: "2026-09-24T05:00:00Z",
  generatedAt: "2026-09-24T05:10:00Z",
  grid: { width: 1440, height: 721, lon0: -180, lat0: 90, dlon: 0.25, dlat: -0.25 },
  layers: {
    wind: layer("wind.0123456789ab.png", 2),
    temperature: layer("temperature.0123456789ab.png"),
    precipitation: layer("precipitation.0123456789ab.png", 1, "sqrt"),
    clouds: layer("clouds.0123456789ab.png"),
    land: layer("land.0123456789ab.png"),
  },
};

const mutate = (f: (m: any) => void) => {
  const m = structuredClone(SAMPLE);
  f(m);
  return m;
};

describe("parseManifest", () => {
  it("accepts a valid manifest", () => {
    expect(parseManifest(SAMPLE).layers.wind.min).toEqual([0, 0]);
  });

  it.each([
    ["wrong version", mutate((m) => (m.version = 2))],
    ["missing layer", mutate((m) => delete m.layers.clouds)],
    ["path traversal in file", mutate((m) => (m.layers.land.file = "../secret.png"))],
    ["absolute URL in file", mutate((m) => (m.layers.land.file = "https://evil.example/x.png"))],
    ["wind with one channel", mutate((m) => (m.layers.wind = layer("wind.0123456789ab.png", 1)))],
    ["non-finite range", mutate((m) => (m.layers.temperature.max = [null]))],
    ["unknown encoding", mutate((m) => (m.layers.clouds.encoding = "log"))],
    ["bad timestamp", mutate((m) => (m.validTime = "yesterday"))],
    ["zero grid width", mutate((m) => (m.grid.width = 0))],
    ["not an object", "hello"],
  ])("rejects %s", (_, bad) => {
    expect(() => parseManifest(bad)).toThrow(ManifestError);
  });
});

describe("decodeValue", () => {
  const lin: Layer = { file: "", units: "", encoding: "linear", min: [-10], max: [30] };
  const sq: Layer = { file: "", units: "", encoding: "sqrt", min: [0], max: [64] };

  it("linear endpoints", () => {
    expect(decodeValue(0, lin)).toBe(-10);
    expect(decodeValue(255, lin)).toBe(30);
  });
  it("sqrt endpoints and midpoint", () => {
    expect(decodeValue(255, sq)).toBeCloseTo(64);
    expect(decodeValue(127.5, sq)).toBeCloseTo(16); // (8 * 0.5)^2
  });
  it("uses the requested channel's range", () => {
    const wind: Layer = { file: "", units: "", encoding: "linear", min: [-5, -20], max: [5, 20] };
    expect(decodeValue(255, wind, 1)).toBe(20);
  });
});

describe("staleness", () => {
  it("fresh within the threshold", () => {
    const s = staleness("2026-09-24T05:00:00Z", new Date("2026-09-24T11:00:00Z"));
    expect(s).toEqual({ ageHours: 6, stale: false });
  });
  it("stale beyond it", () => {
    expect(staleness("2026-09-24T05:00:00Z", new Date("2026-09-24T17:30:00Z")).stale).toBe(true);
  });
});
```

**Step 2: Run to verify failure.** Expected: FAIL — cannot resolve `./manifest`.

**Step 3: Implement** — `web/src/manifest.ts`

```ts
import type { Grid } from "./geo";

export const LAYER_NAMES = ["wind", "temperature", "precipitation", "clouds", "land"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];
export type ScalarName = "temperature" | "precipitation" | "clouds";
export type Encoding = "linear" | "sqrt";

export interface Layer {
  file: string;
  units: string;
  encoding: Encoding;
  min: number[];
  max: number[];
}

export interface Manifest {
  version: 1;
  run: { cycle: string; fhour: number };
  validTime: string;
  generatedAt: string;
  grid: Grid;
  layers: Record<LayerName, Layer>;
}

export class ManifestError extends Error {}

// Texture names come from the manifest and are joined onto our data URL, so
// only the pipeline's own naming pattern is allowed.
const FILE = /^[a-z]+\.[0-9a-f]{12}\.png$/;

function fail(message: string): never {
  throw new ManifestError(message);
}
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isFinite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function timestamp(x: unknown, what: string): string {
  if (typeof x !== "string" || Number.isNaN(Date.parse(x))) fail(`${what} is not a timestamp`);
  return x;
}

function parseLayer(name: LayerName, x: unknown): Layer {
  if (!isObj(x)) fail(`missing layer ${name}`);
  if (typeof x.file !== "string" || !FILE.test(x.file)) fail(`bad file for ${name}`);
  if (typeof x.units !== "string") fail(`bad units for ${name}`);
  if (x.encoding !== "linear" && x.encoding !== "sqrt") fail(`bad encoding for ${name}`);
  const channels = name === "wind" ? 2 : 1;
  const { min, max } = x;
  if (!Array.isArray(min) || !Array.isArray(max) || min.length !== channels || max.length !== channels) {
    fail(`bad range for ${name}`);
  }
  if (![...min, ...max].every(isFinite)) fail(`non-finite range for ${name}`);
  return { file: x.file, units: x.units, encoding: x.encoding, min: min as number[], max: max as number[] };
}

export function parseManifest(x: unknown): Manifest {
  if (!isObj(x) || x.version !== 1) fail("unsupported manifest version");
  const { run, grid, layers } = x;
  if (!isObj(run) || !Number.isInteger(run.fhour)) fail("bad run");
  if (!isObj(grid)) fail("bad grid");
  for (const k of ["width", "height"]) {
    if (!Number.isInteger(grid[k]) || (grid[k] as number) <= 0) fail(`bad grid.${k}`);
  }
  for (const k of ["lon0", "lat0", "dlon", "dlat"]) {
    if (!isFinite(grid[k])) fail(`bad grid.${k}`);
  }
  if (!isObj(layers)) fail("bad layers");
  const parsed = {} as Record<LayerName, Layer>;
  for (const name of LAYER_NAMES) parsed[name] = parseLayer(name, layers[name]);
  return {
    version: 1,
    run: { cycle: timestamp(run.cycle, "run.cycle"), fhour: run.fhour as number },
    validTime: timestamp(x.validTime, "validTime"),
    generatedAt: timestamp(x.generatedAt, "generatedAt"),
    grid: grid as unknown as Grid,
    layers: parsed,
  };
}

export function decodeValue(byte: number, layer: Layer, channel = 0): number {
  const lo = layer.min[channel];
  const hi = layer.max[channel];
  const t = byte / 255;
  if (layer.encoding === "sqrt") {
    const s = Math.sqrt(lo) + t * (Math.sqrt(hi) - Math.sqrt(lo));
    return s * s;
  }
  return lo + t * (hi - lo);
}

export function staleness(validTime: string, now: Date, thresholdHours = 12) {
  const ageHours = (now.getTime() - Date.parse(validTime)) / 3_600_000;
  return { ageHours, stale: ageHours > thresholdHours };
}
```

**Step 4: Run to verify pass.** Expected: all manifest tests pass.

**Step 5: Commit**

```powershell
git add web/src/manifest.ts web/src/manifest.test.ts
git commit -m "Validate the manifest and decode 8-bit values

Texture names are restricted to the pipeline's hashed pattern because they
are joined onto the data URL; the manifest is external input to the page."
```

---

### Task 4: CPU field sampling + readout formatting

**Files:**
- Create: `web/src/field.ts`, `web/src/field.test.ts`
- Create: `web/src/format.ts`, `web/src/format.test.ts`

**Step 1: Write the failing tests**

`web/src/field.test.ts`:

```ts
import { expect, it } from "vitest";
import { sampleByte } from "./field";
import type { Grid } from "./geo";

// 4 x 3 grid: lon -180, -90, 0, 90; lat 90, 0, -90. R = col*10 + row, G = 100 + that.
const G: Grid = { width: 4, height: 3, lon0: -180, lat0: 90, dlon: 90, dlat: -90 };
const data = new Uint8ClampedArray(4 * 3 * 4);
for (let row = 0; row < 3; row++)
  for (let col = 0; col < 4; col++) {
    const i = (row * 4 + col) * 4;
    data[i] = col * 10 + row;
    data[i + 1] = 100 + col * 10 + row;
  }
const F = { width: 4, height: 3, data };

it("reads the nearest grid point", () => expect(sampleByte(F, G, 0, 0)).toBe(21));
it("reads the requested channel", () => expect(sampleByte(F, G, 0, 0, 1)).toBe(121));
it("wraps across the dateline", () => expect(sampleByte(F, G, 170, -80)).toBe(2));
it("rounds to the nearer point", () => expect(sampleByte(F, G, 50, 40)).toBe(31)); // col 3 (90°), row 1 (0°)
```

`web/src/format.test.ts`:

```ts
import { expect, it } from "vitest";
import { formatLonLat, formatValue } from "./format";

it("formats hemispheres", () => {
  expect(formatLonLat(-0.13, 51.5)).toBe("51.50°N 0.13°W");
  expect(formatLonLat(151.2, -33.87)).toBe("33.87°S 151.20°E");
});

it("formats values by unit", () => {
  expect(formatValue(12.345, "°C")).toBe("12.3 °C");
  expect(formatValue(0.04, "mm/h")).toBe("0.04 mm/h");
  expect(formatValue(3.21, "mm/h")).toBe("3.2 mm/h");
  expect(formatValue(62.6, "%")).toBe("63 %");
});
```

**Step 2: Run to verify failure.** Expected: FAIL — cannot resolve modules.

**Step 3: Implement**

`web/src/field.ts`:

```ts
import { gridIndex, type Grid } from "./geo";

export interface FieldPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

export function sampleByte(f: FieldPixels, grid: Grid, lon: number, lat: number, channel = 0): number {
  const [col, row] = gridIndex(lon, lat, grid);
  return f.data[(row * f.width + col) * 4 + channel];
}
```

`web/src/format.ts`:

```ts
export function formatLonLat(lon: number, lat: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}

export function formatValue(value: number, units: string): string {
  if (units === "%") return `${Math.round(value)} %`;
  if (units === "mm/h" && value < 0.1) return `${value.toFixed(2)} mm/h`;
  return `${value.toFixed(1)} ${units}`;
}
```

**Step 4: Run to verify pass.**

**Step 5: Commit**

```powershell
git add web/src/field.ts web/src/field.test.ts web/src/format.ts web/src/format.test.ts
git commit -m "Sample fields on the CPU for hover readouts"
```

---

### Task 5: Color scales

**Files:**
- Create: `web/src/colors.ts`, `web/src/colors.test.ts`
- Create: `web/src/scales.ts`

**Step 1: Write the failing tests** — `web/src/colors.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { colorAt, inverse, normalize, scaleBytes, type ColorScale } from "./colors";

const S: ColorScale = {
  domain: [0, 100],
  transform: "linear",
  stops: [
    { value: 0, color: "#000000", alpha: 0 },
    { value: 50, color: "#ff0000", alpha: 1 },
    { value: 100, color: "#ffffff", alpha: 1 },
  ],
};
const SQ: ColorScale = { ...S, domain: [0, 64], transform: "sqrt" };

describe("colorAt", () => {
  it("returns stop colors exactly", () => expect(colorAt(S, 50)).toEqual([255, 0, 0, 255]));
  it("interpolates between stops", () => expect(colorAt(S, 25)).toEqual([128, 0, 0, 128]));
  it("clamps outside the stops", () => {
    expect(colorAt(S, -5)).toEqual([0, 0, 0, 0]);
    expect(colorAt(S, 500)).toEqual([255, 255, 255, 255]);
  });
});

describe("normalize / inverse", () => {
  it("linear", () => expect(normalize(S, 25)).toBe(0.25));
  it("sqrt", () => {
    expect(normalize(SQ, 16)).toBeCloseTo(0.5);
    expect(inverse(SQ, 0.5)).toBeCloseTo(16);
  });
  it("clamps", () => expect(normalize(S, 250)).toBe(1));
});

it("scaleBytes builds a 256-texel RGBA ramp", () => {
  const b = scaleBytes(S);
  expect(b.length).toBe(256 * 4);
  expect([...b.slice(0, 4)]).toEqual([0, 0, 0, 0]);
  expect([...b.slice(255 * 4)]).toEqual([255, 255, 255, 255]);
});
```

**Step 2: Run to verify failure.**

**Step 3: Implement**

`web/src/colors.ts`:

```ts
export interface ColorStop {
  value: number;
  color: string; // #rrggbb, sRGB
  alpha: number; // 0..1
}

export interface ColorScale {
  domain: [number, number];
  transform: "linear" | "sqrt";
  stops: ColorStop[]; // ascending by value
}

export type RGBA = [number, number, number, number];

const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];

export function normalize(s: ColorScale, value: number): number {
  const [a, b] = s.domain;
  const t =
    s.transform === "sqrt"
      ? (Math.sqrt(Math.max(value, 0)) - Math.sqrt(a)) / (Math.sqrt(b) - Math.sqrt(a))
      : (value - a) / (b - a);
  return Math.min(1, Math.max(0, t));
}

export function inverse(s: ColorScale, t: number): number {
  const [a, b] = s.domain;
  if (s.transform === "sqrt") {
    const r = Math.sqrt(a) + t * (Math.sqrt(b) - Math.sqrt(a));
    return r * r;
  }
  return a + t * (b - a);
}

export function colorAt(s: ColorScale, value: number): RGBA {
  const { stops } = s;
  const last = stops[stops.length - 1];
  const rgba = (st: ColorStop): RGBA => [...hex(st.color), Math.round(st.alpha * 255)];
  if (value <= stops[0].value) return rgba(stops[0]);
  if (value >= last.value) return rgba(last);
  const i = stops.findIndex((st) => st.value > value);
  const [p, q] = [stops[i - 1], stops[i]];
  const t = (value - p.value) / (q.value - p.value);
  const [pc, qc] = [rgba(p), rgba(q)];
  return pc.map((c, k) => Math.round(c + (qc[k] - c) * t)) as RGBA;
}

export function scaleBytes(s: ColorScale, n = 256): Uint8Array {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) out.set(colorAt(s, inverse(s, i / (n - 1))), i * 4);
  return out;
}
```

`web/src/scales.ts` (fixed domains, so a color means the same thing every day;
palette to be reviewed in M6):

```ts
import type { ColorScale } from "./colors";
import type { ScalarName } from "./manifest";

export const SCALAR_LAYERS: Record<ScalarName, { label: string; scale: ColorScale }> = {
  temperature: {
    label: "Temperature",
    scale: {
      domain: [-40, 45],
      transform: "linear",
      stops: [
        { value: -40, color: "#2a1a5e", alpha: 0.85 },
        { value: -20, color: "#3d5bb8", alpha: 0.85 },
        { value: -5, color: "#7db5e3", alpha: 0.85 },
        { value: 0, color: "#e6f0f0", alpha: 0.85 },
        { value: 10, color: "#f5d67a", alpha: 0.85 },
        { value: 25, color: "#ee8a3c", alpha: 0.85 },
        { value: 35, color: "#c8302c", alpha: 0.85 },
        { value: 45, color: "#6b0f2b", alpha: 0.85 },
      ],
    },
  },
  precipitation: {
    label: "Precipitation",
    scale: {
      domain: [0, 50],
      transform: "sqrt",
      stops: [
        { value: 0, color: "#7fd3ff", alpha: 0 },
        { value: 0.1, color: "#7fd3ff", alpha: 0.35 },
        { value: 1, color: "#3aa0ff", alpha: 0.7 },
        { value: 5, color: "#2f5bff", alpha: 0.85 },
        { value: 15, color: "#a23cff", alpha: 0.9 },
        { value: 50, color: "#ff3ce0", alpha: 0.95 },
      ],
    },
  },
  clouds: {
    label: "Cloud cover",
    scale: {
      domain: [0, 100],
      transform: "linear",
      stops: [
        { value: 0, color: "#ffffff", alpha: 0 },
        { value: 20, color: "#ffffff", alpha: 0 },
        { value: 100, color: "#ffffff", alpha: 0.8 },
      ],
    },
  },
};
```

**Step 4: Run to verify pass.**

**Step 5: Commit**

```powershell
git add web/src/colors.ts web/src/colors.test.ts web/src/scales.ts
git commit -m "Add color scales with fixed domains

The shader indexes the ramp in transform space (sqrt for precipitation), and
the legend samples the same function, so the two cannot drift apart."
```

---

### Task 6: Globe rendering, temperature layer, legend, readout

**Files:**
- Create: `web/src/textures.ts`, `web/src/globe.ts`, `web/src/legend.ts`, `web/src/style.css`
- Modify: `web/index.html`, `web/src/main.ts`

**Step 1: `web/src/textures.ts`**

```ts
import * as THREE from "three";
import type { FieldPixels } from "./field";
import type { Grid } from "./geo";
import { scaleBytes, type ColorScale } from "./colors";

export interface LoadedField {
  texture: THREE.Texture;
  pixels: FieldPixels;
}

function dataTextureSettings<T extends THREE.Texture>(t: T): T {
  t.flipY = false; // row 0 (north) at v = 0; ImageBitmaps ignore flipY anyway
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export async function loadField(url: string): Promise<LoadedField> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // No color conversion or premultiplication: the bytes are data, not colors.
  const bitmap = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return {
    texture: dataTextureSettings(new THREE.Texture(bitmap)),
    pixels: { width: bitmap.width, height: bitmap.height, data },
  };
}

export function rgbaDataTexture(data: Uint8Array, width: number, height: number): THREE.DataTexture {
  return dataTextureSettings(new THREE.DataTexture(data, width, height, THREE.RGBAFormat));
}

export function scaleTexture(scale: ColorScale): THREE.DataTexture {
  const t = rgbaDataTexture(scaleBytes(scale), 256, 1);
  t.wrapS = THREE.ClampToEdgeWrapping;
  return t;
}

export function gridUniforms(g: Grid) {
  return {
    uGrid: { value: new THREE.Vector4(g.lon0, g.lat0, g.dlon, g.dlat) },
    uGridSize: { value: new THREE.Vector2(g.width, g.height) },
  };
}
```

**Step 2: `web/src/globe.ts`**

```ts
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ColorScale } from "./colors";
import { GLSL_GEO, lonLatToVec3, vec3ToLonLat, type Grid } from "./geo";
import type { Layer } from "./manifest";
import { gridUniforms, scaleTexture } from "./textures";

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
${GLSL_GEO}
uniform sampler2D uLand;
uniform sampler2D uField;
uniform sampler2D uScale;
uniform float uHasField;
uniform vec2 uFieldRange;
uniform float uFieldSqrt;
uniform vec2 uDomain;
uniform float uScaleSqrt;
varying vec3 vDir;

float decode(float b) {
  if (uFieldSqrt > 0.5) {
    float s = mix(sqrt(uFieldRange.x), sqrt(uFieldRange.y), b);
    return s * s;
  }
  return mix(uFieldRange.x, uFieldRange.y, b);
}

float normalized(float v) {
  float t = uScaleSqrt > 0.5
    ? (sqrt(max(v, 0.0)) - sqrt(uDomain.x)) / (sqrt(uDomain.y) - sqrt(uDomain.x))
    : (v - uDomain.x) / (uDomain.y - uDomain.x);
  return clamp(t, 0.0, 1.0);
}

void main() {
  vec2 uv = gridTexUV(dirToLonLat(normalize(vDir)));
  float land = texture2D(uLand, uv).r;
  vec3 color = mix(vec3(0.043, 0.063, 0.098), vec3(0.12, 0.14, 0.17), land);
  if (uHasField > 0.5) {
    float t = normalized(decode(texture2D(uField, uv).r));
    vec4 c = texture2D(uScale, vec2((t * 255.0 + 0.5) / 256.0, 0.5));
    color = mix(color, c.rgb, c.a);
  }
  float coast = 1.0 - smoothstep(0.0, fwidth(land) * 1.5 + 1e-4, abs(land - 0.5));
  color = mix(color, vec3(0.85), coast * 0.55);
  gl_FragColor = vec4(color, 1.0);
}`;

export class Globe {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  readonly controls: OrbitControls;
  private readonly material: THREE.ShaderMaterial;
  private readonly raycaster = new THREE.Raycaster();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 1);

  constructor(canvas: HTMLCanvasElement, land: THREE.Texture, grid: Grid) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...gridUniforms(grid),
        uLand: { value: land },
        uField: { value: null },
        uScale: { value: null },
        uHasField: { value: 0 },
        uFieldRange: { value: new THREE.Vector2() },
        uFieldSqrt: { value: 0 },
        uDomain: { value: new THREE.Vector2() },
        uScaleSqrt: { value: 0 },
      },
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 192, 96), this.material));
    this.camera.position.set(...lonLatToVec3(-30, 25, 3.4));
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.25;
    this.controls.maxDistance = 6;
  }

  setScalar(field: THREE.Texture | null, layer?: Layer, scale?: ColorScale) {
    const u = this.material.uniforms;
    if (!field || !layer || !scale) {
      u.uHasField.value = 0;
      return;
    }
    (u.uScale.value as THREE.Texture | null)?.dispose();
    u.uField.value = field;
    u.uScale.value = scaleTexture(scale);
    u.uHasField.value = 1;
    u.uFieldRange.value.set(layer.min[0], layer.max[0]);
    u.uFieldSqrt.value = layer.encoding === "sqrt" ? 1 : 0;
    u.uDomain.value.set(...scale.domain);
    u.uScaleSqrt.value = scale.transform === "sqrt" ? 1 : 0;
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Lon/lat under a point in normalized device coordinates, or null off-globe. */
  pick(ndcX: number, ndcY: number): [number, number] | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.ray.intersectSphere(this.sphere, new THREE.Vector3());
    return hit ? vec3ToLonLat([hit.x, hit.y, hit.z]) : null;
  }

  view(lon: number, lat: number, distance = this.camera.position.length()) {
    this.camera.position.set(...lonLatToVec3(lon, lat, distance));
    this.controls.update();
  }
}
```

**Step 3: `web/src/legend.ts`**

```ts
import { colorAt, inverse, type ColorScale } from "./colors";
import { formatValue } from "./format";

export function drawLegend(canvas: HTMLCanvasElement, ticks: HTMLElement, scale: ColorScale | null, units = "") {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ticks.replaceChildren();
  canvas.hidden = ticks.hidden = scale === null;
  if (!scale) return;
  for (let x = 0; x < canvas.width; x++) {
    const [r, g, b, a] = colorAt(scale, inverse(scale, x / (canvas.width - 1)));
    ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
    ctx.fillRect(x, 0, 1, canvas.height);
  }
  for (const t of [0, 0.5, 1]) {
    const span = document.createElement("span");
    span.textContent = formatValue(inverse(scale, t), units);
    ticks.append(span);
  }
}
```

**Step 4: `web/index.html`** (full layout; M4 fills in the controls)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>zephyr — live wind & weather globe</title>
    <meta name="description" content="Live global wind, temperature, precipitation and cloud cover from NOAA GFS on a 3D globe." />
  </head>
  <body>
    <canvas id="globe"></canvas>
    <div id="banner" class="banner" role="status" hidden></div>
    <button id="menu" class="menu" aria-controls="panel" aria-expanded="true" aria-label="Toggle controls">☰</button>
    <aside id="panel" class="panel">
      <h1>zephyr</h1>
      <p id="valid" class="muted">Loading weather data…</p>
      <fieldset id="layers" class="layers"><legend>Layer</legend></fieldset>
      <label class="toggle"><input type="checkbox" id="wind-toggle" checked /> Wind particles</label>
      <p id="notice" class="notice" hidden></p>
      <figure class="legend">
        <canvas id="legend" width="240" height="10"></canvas>
        <figcaption id="legend-ticks"></figcaption>
      </figure>
      <p id="readout" class="readout">Hover the globe for values</p>
      <footer class="muted">Data: NOAA GFS via NOAA Open Data Dissemination.</footer>
    </aside>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

**Step 5: `web/src/style.css`**

```css
:root {
  color-scheme: dark;
  --bg: #05070b;
  --panel: rgba(12, 16, 24, 0.82);
  --text: #e6ebf2;
  --muted: #8b95a5;
  --accent: #7fd3ff;
  --warn: #7a5a12;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); }
#globe { position: fixed; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.panel {
  position: fixed; top: 12px; left: 12px; width: 272px; max-height: calc(100% - 24px); overflow: auto;
  padding: 16px; border-radius: 12px; background: var(--panel); backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.panel h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0.04em; }
.muted { color: var(--muted); margin: 0 0 12px; font-size: 12px; }
.layers { border: 0; padding: 0; margin: 0 0 12px; display: grid; gap: 6px; }
.layers legend { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.layers label, .toggle { display: flex; gap: 8px; align-items: center; cursor: pointer; }
.toggle { margin-bottom: 12px; }
.notice { font-size: 12px; color: #f2c26b; }
.legend { margin: 0 0 12px; }
.legend canvas { width: 100%; height: 10px; border-radius: 3px; display: block; }
.legend figcaption { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 4px; }
.readout { min-height: 2.9em; margin: 0 0 12px; font-variant-numeric: tabular-nums; }
.banner {
  position: fixed; top: 0; left: 50%; transform: translateX(-50%); padding: 6px 14px;
  background: var(--warn); color: #fff3d6; border-radius: 0 0 8px 8px; font-size: 13px; z-index: 2;
}
.menu {
  display: none; position: fixed; top: 12px; left: 12px; z-index: 3; width: 40px; height: 40px;
  border-radius: 8px; border: 1px solid rgba(255,255,255,0.12); background: var(--panel); color: var(--text); font-size: 18px;
}
.error { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; }
@media (max-width: 700px) {
  .menu { display: block; }
  .panel { top: 60px; width: calc(100% - 24px); max-height: 55%; }
  .panel[data-collapsed="true"] { display: none; }
}
```

**Step 6: `web/src/main.ts`** (M2 scope: temperature only; M4 replaces it)

```ts
import "./style.css";
import * as THREE from "three";
import { sampleByte } from "./field";
import { formatLonLat, formatValue } from "./format";
import { Globe } from "./globe";
import { drawLegend } from "./legend";
import { decodeValue, parseManifest } from "./manifest";
import { SCALAR_LAYERS } from "./scales";
import { loadField } from "./textures";

declare global {
  interface Window {
    __zephyr?: Record<string, unknown>;
  }
}

const DATA = `${import.meta.env.BASE_URL}data/`;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function start() {
  const res = await fetch(`${DATA}manifest.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  const manifest = parseManifest(await res.json());
  const [land, temperature] = await Promise.all([
    loadField(DATA + manifest.layers.land.file),
    loadField(DATA + manifest.layers.temperature.file),
  ]);

  const canvas = $<HTMLCanvasElement>("#globe");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x05070b);
  const globe = new Globe(canvas, land.texture, manifest.grid);
  const { scale } = SCALAR_LAYERS.temperature;
  const layer = manifest.layers.temperature;
  globe.setScalar(temperature.texture, layer, scale);
  drawLegend($("#legend"), $("#legend-ticks"), scale, layer.units);

  const valueAt = (lon: number, lat: number) =>
    decodeValue(sampleByte(temperature.pixels, manifest.grid, lon, lat), layer);

  canvas.addEventListener("pointermove", (e) => {
    const hit = globe.pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    $("#readout").textContent = hit
      ? `${formatLonLat(...hit)} · ${formatValue(valueAt(...hit), layer.units)}`
      : "Hover the globe for values";
  });

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    globe.resize(innerWidth, innerHeight);
  };
  addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop(() => {
    globe.controls.update();
    renderer.render(globe.scene, globe.camera);
  });

  if (import.meta.env.DEV) {
    window.__zephyr = { valueAt, view: (lon: number, lat: number) => globe.view(lon, lat) };
  }
}

start().catch((err: unknown) => {
  console.error(err);
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = "Couldn't load the weather data. Please try again later.";
  document.body.append(box);
});
```

**Step 7: Type-check and unit tests**

```powershell
Set-Location web; npx tsc -p .; Set-Location ..
npm --prefix web test
```

Expected: tsc exit 0; all tests pass.

**Step 8: Verify in the browser**

Make sure `web/public/data` holds a fresh pipeline run (Task 1 Step 6).
`preview_start` → `zephyr-web`, then:

1. `read_console_messages` (errors only) → none.
2. Screenshot: temperature colors on a dark globe; coastlines drawn from the
   land mask line up with the land/sea contrast in the temperature field
   (two independent textures agreeing is the alignment check).
3. `__zephyr.view(0, 51)` → Europe/Africa centred; `view(180, 0)` → no seam.
4. **Byte-exact readout check** (proves no color conversion on load and correct
   grid indexing). Python reads the same PNG pixel for London (col 719, row 154):

   ```powershell
   pipeline\.venv\Scripts\python -c "import json, numpy as np; from PIL import Image; m = json.load(open('web/public/data/manifest.json', encoding='utf-8')); t = m['layers']['temperature']; b = int(np.asarray(Image.open('web/public/data/' + t['file']))[154, 719]); print(b, t['min'][0] + b / 255 * (t['max'][0] - t['min'][0]))"
   ```

   `javascript_tool`: `__zephyr.valueAt(-0.13, 51.5)` → must equal the Python
   value (to float precision). If it differs, the ImageBitmap path is
   color-managing the PNG — stop and debug.
5. Hover (via `computer` hover at a point on the globe) → readout text shows
   lat/lon and °C.

**Step 9: Commit**

```powershell
git add web/index.html web/src
git commit -m "Render the globe with land mask, coastline and temperature

The fragment shader derives lon/lat from the surface direction and samples
texel centres; the hover readout reads the same bytes on the CPU, verified
byte-exact against Python for London."
```

**Checkpoint:** screenshot to the user before M3.

---

## M3 — GPU wind particles

### Task 7: Debug wind fields and drift statistics

**Files:**
- Create: `web/src/debugWind.ts`, `web/src/debugWind.test.ts`

The debug fields make shader correctness checkable: every expected motion is
known in closed form. Rotation about the +X axis (lon 0°, lat 0°) is
w = x̂ × r; projecting onto local east/north with our axes gives
**u = −U sin φ cos λ, v = U sin λ**: northward flow at 90°E, southward at 90°W,
westward at (0°, 45°N), and counter-clockwise circulation seen from above
(0°, 0°).

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { debugWind, driftStats } from "./debugWind";
import { sampleByte } from "./field";
import type { Grid } from "./geo";
import { decodeValue } from "./manifest";

const G: Grid = { width: 360, height: 181, lon0: -180, lat0: 90, dlon: 1, dlat: -1 };
const STEP = 30 / 255; // one quantization step for speed 15

function windAt(kind: "eastward" | "rotation", lon: number, lat: number) {
  const { data, layer } = debugWind(kind, G, 15);
  const f = { width: G.width, height: G.height, data: new Uint8ClampedArray(data.buffer) };
  return [0, 1].map((c) => decodeValue(sampleByte(f, G, lon, lat, c), layer, c));
}

describe("debugWind", () => {
  it("eastward is uniform", () => {
    const [u, v] = windAt("eastward", 37, -61);
    expect(u).toBeCloseTo(15, 1);
    expect(Math.abs(v)).toBeLessThanOrEqual(STEP);
  });
  it.each([
    [90, 0, 0, 15],
    [-90, 0, 0, -15],
    [0, 45, -15 * Math.SQRT1_2, 0],
    [0, 0, 0, 0],
  ])("rotation about +X at (%d, %d)", (lon, lat, eu, ev) => {
    const [u, v] = windAt("rotation", lon, lat);
    expect(Math.abs(u - eu)).toBeLessThanOrEqual(STEP);
    expect(Math.abs(v - ev)).toBeLessThanOrEqual(STEP);
  });
});

describe("driftStats", () => {
  const box: [number, number, number, number] = [-10, 10, -10, 10];
  const particles = (...ps: [number, number][]) => new Float32Array(ps.flatMap(([lo, la]) => [lo, la, 0, 1]));

  it("averages motion of particles inside the box", () => {
    const s = driftStats(particles([0, 0], [5, 5], [50, 50]), particles([1, 0], [6, 7], [51, 50]), box);
    expect(s).toEqual({ n: 2, dLon: 1, dLat: 1 });
  });
  it("unwraps motion across the dateline", () => {
    const s = driftStats(particles([179, 0]), particles([-179, 0]), [170, 180, -5, 5]);
    expect(s.dLon).toBeCloseTo(2);
  });
  it("ignores respawned particles", () => {
    const s = driftStats(particles([0, 0], [1, 1]), particles([120, -40], [2, 1]), box);
    expect(s).toEqual({ n: 1, dLon: 1, dLat: 0 });
  });
});
```

**Step 2: Run to verify failure.**

**Step 3: Implement** — `web/src/debugWind.ts`

```ts
import type { Grid } from "./geo";
import type { Layer } from "./manifest";

export type DebugWind = "eastward" | "rotation";
export const DEBUG_WINDS: DebugWind[] = ["eastward", "rotation"];

const RAD = Math.PI / 180;

export function debugWind(kind: DebugWind, g: Grid, speed = 15): { data: Uint8Array; layer: Layer } {
  const data = new Uint8Array(g.width * g.height * 4);
  const enc = (x: number) => Math.round(((x + speed) / (2 * speed)) * 255);
  for (let row = 0; row < g.height; row++) {
    const lat = (g.lat0 + row * g.dlat) * RAD;
    for (let col = 0; col < g.width; col++) {
      const lon = (g.lon0 + col * g.dlon) * RAD;
      const [u, v] = kind === "eastward" ? [speed, 0] : [-speed * Math.sin(lat) * Math.cos(lon), speed * Math.sin(lon)];
      data.set([enc(u), enc(v), 0, 255], (row * g.width + col) * 4);
    }
  }
  return { data, layer: { file: "debug", units: "m/s", encoding: "linear", min: [-speed, -speed], max: [speed, speed] } };
}

/** Mean lon/lat motion (degrees) of particles that started inside `box` and were not respawned. */
export function driftStats(
  before: Float32Array,
  after: Float32Array,
  [lonMin, lonMax, latMin, latMax]: [number, number, number, number],
  maxJump = 20,
) {
  let n = 0, dLon = 0, dLat = 0;
  for (let i = 0; i < before.length; i += 4) {
    const [lo, la] = [before[i], before[i + 1]];
    if (lo < lonMin || lo > lonMax || la < latMin || la > latMax) continue;
    const dl = ((after[i] - lo + 540) % 360) - 180;
    const da = after[i + 1] - la;
    if (Math.abs(dl) > maxJump || Math.abs(da) > maxJump) continue;
    n++; dLon += dl; dLat += da;
  }
  return n ? { n, dLon: dLon / n, dLat: dLat / n } : { n, dLon: 0, dLat: 0 };
}
```

**Step 4: Run to verify pass. Step 5: Commit.**

```powershell
git add web/src/debugWind.ts web/src/debugWind.test.ts
git commit -m "Add closed-form debug wind fields and drift statistics

Rotation about +X has known east/north components everywhere, so particle
motion measured from the GPU can be checked numerically, including v's sign."
```

---

### Task 8: WindLayer (particles, trails, composite)

**Files:**
- Create: `web/src/wind.ts`
- Modify: `web/src/main.ts` (wire wind + dev hooks)

**Step 1: Implement** — `web/src/wind.ts`

```ts
import * as THREE from "three";
import { GPUComputationRenderer } from "three/addons/misc/GPUComputationRenderer.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { GLSL_GEO, type Grid } from "./geo";
import type { Layer } from "./manifest";
import { gridUniforms } from "./textures";

const SPEED = 0.02; // degrees of arc per (m/s) per frame; tuned visually in M6
const DROP_RATE = 0.003; // mean particle life ~330 frames
const FADE = 0.96;
const HIDE_AFTER_MOVE_MS = 200;

const UPDATE = /* glsl */ `
${GLSL_GEO}
uniform sampler2D uWind;
uniform vec2 uWindMin;
uniform vec2 uWindMax;
uniform float uSeed;
float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 p = texture2D(particles, uv);
  vec2 wind = mix(uWindMin, uWindMax, texture2D(uWind, gridTexUV(p.xy)).rg);
  float coslat = max(cos(radians(p.y)), 0.05);
  p.xy += vec2(wind.x / coslat, wind.y) * ${SPEED.toFixed(4)};
  p.x = mod(p.x + 180.0, 360.0) - 180.0;
  vec2 seed = uv * 7.31 + uSeed;
  if (rand(seed) < ${DROP_RATE.toFixed(4)} || abs(p.y) > 88.0) {
    p.xy = vec2(rand(seed + 1.3) * 360.0 - 180.0, degrees(asin(rand(seed + 2.9) * 2.0 - 1.0)));
  }
  gl_FragColor = vec4(p.xy, length(wind), 1.0);
}`;

const POINTS_VERT = /* glsl */ `
${GLSL_GEO}
uniform sampler2D uParticles;
uniform float uPointSize;
attribute vec2 ref;
varying float vSpeed;
void main() {
  vec4 p = texture2D(uParticles, ref);
  vec3 world = lonLatToDir(p.xy) * 1.002;
  vSpeed = p.z;
  if (dot(world, cameraPosition - world) < 0.0) { // far side of the globe
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  gl_PointSize = uPointSize;
}`;

const POINTS_FRAG = /* glsl */ `
varying float vSpeed;
void main() { gl_FragColor = vec4(1.0, 1.0, 1.0, clamp(vSpeed / 12.0, 0.4, 1.0)); }`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Subtracting one 8-bit step guarantees trails decay to zero in RGBA8 targets.
const FADE_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform float uFade;
varying vec2 vUv;
void main() { gl_FragColor = max(texture2D(uPrev, vUv) * uFade - vec4(1.0 / 255.0), 0.0); }`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uTrail;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTrail, vUv); }`;

export class WindLayer {
  static supported(renderer: THREE.WebGLRenderer): boolean {
    return renderer.capabilities.maxVertexTextures > 0 && renderer.extensions.has("EXT_color_buffer_float");
  }

  private readonly gpu: GPUComputationRenderer;
  private readonly variable: ReturnType<GPUComputationRenderer["addVariable"]>;
  private readonly pointsScene = new THREE.Scene();
  private readonly pointsMaterial: THREE.ShaderMaterial;
  private readonly fade: FullScreenQuad;
  private readonly composite: FullScreenQuad;
  private trails: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private lastMove = -Infinity;
  private visible = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.Camera,
    wind: THREE.Texture,
    layer: Layer,
    grid: Grid,
    side: number,
  ) {
    this.gpu = new GPUComputationRenderer(side, side, renderer);
    const initial = this.gpu.createTexture();
    const d = initial.image.data as Float32Array;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.random() * 360 - 180;
      d[i + 1] = (Math.asin(Math.random() * 2 - 1) * 180) / Math.PI;
    }
    this.variable = this.gpu.addVariable("particles", UPDATE, initial);
    this.gpu.setVariableDependencies(this.variable, [this.variable]);
    Object.assign(this.variable.material.uniforms, {
      ...gridUniforms(grid),
      uWind: { value: wind },
      uWindMin: { value: new THREE.Vector2(layer.min[0], layer.min[1]) },
      uWindMax: { value: new THREE.Vector2(layer.max[0], layer.max[1]) },
      uSeed: { value: 0 },
    });
    const error = this.gpu.init();
    if (error) throw new Error(error);

    const n = side * side;
    const refs = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) refs.set([((i % side) + 0.5) / side, (Math.floor(i / side) + 0.5) / side], i * 2);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setAttribute("ref", new THREE.BufferAttribute(refs, 2));
    this.pointsMaterial = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      uniforms: { ...gridUniforms(grid), uParticles: { value: null }, uPointSize: { value: Math.max(1, renderer.getPixelRatio()) } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, this.pointsMaterial);
    points.frustumCulled = false;
    this.pointsScene.add(points);

    this.fade = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: FADE_FRAG,
        uniforms: { uPrev: { value: null }, uFade: { value: FADE } },
        blending: THREE.NoBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    // Trail targets hold premultiplied color (white * alpha over transparent black).
    this.composite = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: COMPOSITE_FRAG,
        uniforms: { uTrail: { value: null } },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    this.trails = [this.makeTarget(), this.makeTarget()];
  }

  private makeTarget() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: false });
  }

  setWind(texture: THREE.Texture, layer: Layer) {
    const u = this.variable.material.uniforms;
    u.uWind.value = texture;
    u.uWindMin.value.set(layer.min[0], layer.min[1]);
    u.uWindMax.value.set(layer.max[0], layer.max[1]);
  }

  setVisible(on: boolean) {
    this.visible = on;
    this.lastMove = performance.now(); // start from clean trails when re-shown
  }

  cameraMoved() {
    this.lastMove = performance.now();
  }

  resize() {
    this.trails.forEach((t) => t.dispose());
    this.trails = [this.makeTarget(), this.makeTarget()];
  }

  render(now: number) {
    if (!this.visible) return;
    this.variable.material.uniforms.uSeed.value = Math.random() * 100;
    this.gpu.compute();

    const [prev, next] = this.trails;
    const moving = now - this.lastMove < HIDE_AFTER_MOVE_MS;
    this.renderer.setRenderTarget(next);
    const fade = this.fade.material as THREE.ShaderMaterial;
    fade.uniforms.uPrev.value = prev.texture;
    fade.uniforms.uFade.value = moving ? 0 : FADE; // 0 clears the trails while moving
    this.fade.render(this.renderer);
    if (!moving) {
      this.pointsMaterial.uniforms.uParticles.value = this.gpu.getCurrentRenderTarget(this.variable).texture;
      this.renderer.render(this.pointsScene, this.camera);
    }
    this.renderer.setRenderTarget(null);
    (this.composite.material as THREE.ShaderMaterial).uniforms.uTrail.value = next.texture;
    this.composite.render(this.renderer);
    this.trails = [next, prev];
  }

  /** Current particle state (lon, lat, speed, 1) — debugging only. */
  readParticles(): Float32Array {
    const rt = this.gpu.getCurrentRenderTarget(this.variable);
    const out = new Float32Array(rt.width * rt.height * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, out);
    return out;
  }
}
```

**Step 2: Wire into `main.ts`**

Changes to the M2 `main.ts`:
- Load `wind` alongside land/temperature.
- `renderer.autoClear = false`; the loop becomes:

  ```ts
  renderer.setAnimationLoop((now) => {
    globe.controls.update();
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(globe.scene, globe.camera);
    windLayer?.render(now);
  });
  ```

- Create the layer when supported (and not forced off with `?nofloat` in dev):

  ```ts
  const params = new URLSearchParams(location.search);
  let windLayer: WindLayer | null = null;
  if (WindLayer.supported(renderer) && !(import.meta.env.DEV && params.has("nofloat"))) {
    const side = matchMedia("(pointer: coarse)").matches ? 128 : 256;
    windLayer = new WindLayer(renderer, globe.camera, wind.texture, manifest.layers.wind, manifest.grid, side);
    const debug = import.meta.env.DEV ? params.get("debug") : null;
    if (debug === "eastward" || debug === "rotation") {
      const d = debugWind(debug, manifest.grid);
      windLayer.setWind(rgbaDataTexture(d.data, manifest.grid.width, manifest.grid.height), d.layer);
    }
    globe.controls.addEventListener("change", () => windLayer?.cameraMoved());
  } else {
    const notice = $("#notice");
    notice.hidden = false;
    notice.textContent = "Wind animation needs WebGL float render targets, which this device lacks. Color layers still work.";
  }
  ```

- In `resize`: `windLayer?.resize();` after `renderer.setSize`.
- Dev hook, added to `window.__zephyr`:

  ```ts
  drift: async (ms: number, box: [number, number, number, number]) => {
    if (!windLayer) return null;
    const before = windLayer.readParticles();
    await new Promise((r) => setTimeout(r, ms));
    return driftStats(before, windLayer.readParticles(), box);
  },
  ```

**Step 3: Type-check + tests.** `npx tsc -p .` (in `web`) → exit 0;
`npm --prefix web test` → pass.

**Step 4: Verify with debug fields** (numbers, not just screenshots)

`navigate` to `http://localhost:5174/?debug=rotation`, wait 2 s, then run each
`__zephyr.drift(500, box)` in `javascript_tool`:

| Box `[lonMin, lonMax, latMin, latMax]` | Expected |
| --- | --- |
| `[80, 100, -10, 10]` (90°E) | `dLat > 0`, `|dLon|` small |
| `[-100, -80, -10, 10]` (90°W) | `dLat < 0` |
| `[-10, 10, 35, 55]` (0°, 45°N) | `dLon < 0`, `|dLat|` small |

Then `?debug=eastward`: box `[-20, 20, -10, 10]` → `dLon > 0`, `|dLat|` ≈ 0;
box `[-20, 20, 60, 70]` → `dLon` about 2× the equatorial value (1/cos 65° ≈ 2.4).
Screenshot each debug mode viewed from `view(0, 0)`.

If any sign is wrong, the bug is in texture orientation (v) or component
order — do not "fix" by flipping a sign in the shader without finding which.

**Step 5: Verify with real data**

`navigate` to `http://localhost:5174/`, wait 2 s:
- Southern Ocean westerlies: `drift(500, [-180, 180, -55, -40])` → `dLon > 0`.
- Pacific trade winds: `drift(500, [-170, -120, 15, 25])` → `dLon < 0`.
  (Done 2026-09-24: 10–20°N was a bad box — the data itself had mean
  u −0.77 there that day, in the ITCZ. Check a box's u/v means from the PNG
  in Python before reading a drift sign. `drift` accepts several boxes and
  measures them from one pair of readings; use that for ratios, since separate
  calls differ by ±1 frame ≈ ±10%.)
- Screenshot: streaks over the temperature layer; drag the globe
  (`left_click_drag`) → trails vanish during the drag and return after.
- `?nofloat` → notice visible, globe + temperature still render.
- Console errors: none.

**Step 6: Commit**

```powershell
git add web/src/wind.ts web/src/main.ts
git commit -m "Animate wind particles on the GPU with screen-space trails

Particles advect in lon/lat in a float texture; trails fade in an RGBA8
target with a one-step floor so they always decay. Verified numerically with
debug fields (rotation about +X: north at 90E, south at 90W, west at 0/45N)
and on real data (Southern Ocean westerlies, Pacific trades)."
```

**Checkpoint:** screenshots to the user before M4.

---

## M4 — Layers, sidebar, staleness

### Task 9: Wind direction + validity formatting

**Files:**
- Modify: `web/src/format.ts`, `web/src/format.test.ts`

**Step 1: Add failing tests**

```ts
import { formatValidTime, windFrom } from "./format";

it.each([
  [0, -5, "N", 0],     // blowing south = from the north
  [-5, 0, "E", 90],    // blowing west = from the east
  [5, 0, "W", 270],
  [3, 3, "SW", 225],
])("wind (%d, %d) is from %s", (u, v, compass, deg) => {
  const w = windFrom(u, v);
  expect(w.compass).toBe(compass);
  expect(w.degrees).toBeCloseTo(deg);
});

it("formats the validity line", () => {
  expect(formatValidTime("2026-09-24T05:00:00Z", { cycle: "2026-09-24T00:00:00Z", fhour: 5 }))
    .toBe("Valid 24 Sep 05:00 UTC · GFS 00z +5 h");
});
```

**Step 2: Run → fail. Step 3: Implement**

```ts
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function windFrom(u: number, v: number) {
  const degrees = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  return { speed: Math.hypot(u, v), degrees, compass: COMPASS[Math.round(degrees / 22.5) % 16] };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function formatValidTime(validTime: string, run: { cycle: string; fhour: number }): string {
  const t = new Date(validTime);
  const c = new Date(run.cycle);
  return `Valid ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC · GFS ${pad(c.getUTCHours())}z +${run.fhour} h`;
}
```

**Step 4: Run → pass. Step 5: Commit** ("Format wind direction and data validity").

---

### Task 10: Sidebar controller

**Files:**
- Create: `web/src/ui.ts`

Pure DOM wiring (no data logic), verified in the browser in Task 12. All text
goes through `textContent`, never `innerHTML`.

```ts
import type { ScalarName } from "./manifest";
import { SCALAR_LAYERS } from "./scales";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
type Choice = ScalarName | "none";

export class Panel {
  onLayer: (name: ScalarName | null) => void = () => {};
  onWind: (on: boolean) => void = () => {};
  private readonly wind = $<HTMLInputElement>("#wind-toggle");

  constructor(initial: ScalarName) {
    const fieldset = $("#layers");
    const choices: [Choice, string][] = [
      ...(Object.entries(SCALAR_LAYERS) as [ScalarName, { label: string }][]).map(([k, v]) => [k, v.label] as [Choice, string]),
      ["none", "None"],
    ];
    for (const [value, label] of choices) {
      const input = document.createElement("input");
      Object.assign(input, { type: "radio", name: "layer", value, checked: value === initial });
      input.addEventListener("change", () => this.onLayer(value === "none" ? null : value));
      const wrap = document.createElement("label");
      wrap.append(input, document.createTextNode(label));
      fieldset.append(wrap);
    }
    this.wind.addEventListener("change", () => this.onWind(this.wind.checked));

    const panel = $("#panel");
    const menu = $<HTMLButtonElement>("#menu");
    const setCollapsed = (collapsed: boolean) => {
      panel.dataset.collapsed = String(collapsed);
      menu.setAttribute("aria-expanded", String(!collapsed));
    };
    setCollapsed(matchMedia("(max-width: 700px)").matches);
    menu.addEventListener("click", () => setCollapsed(panel.dataset.collapsed !== "true"));
  }

  setWind(available: boolean, on: boolean) {
    this.wind.disabled = !available;
    this.wind.checked = available && on;
  }

  setValidTime(text: string) { $("#valid").textContent = text; }
  setReadout(text: string) { $("#readout").textContent = text; }

  setBanner(text: string | null) {
    const b = $("#banner");
    b.hidden = text === null;
    b.textContent = text ?? "";
  }

  notice(text: string) {
    const n = $("#notice");
    n.hidden = false;
    n.textContent = text;
  }

  setBusy(busy: boolean) { $("#layers").setAttribute("aria-busy", String(busy)); }
}
```

Commit: "Add sidebar controller".

---

### Task 11: Full `main.ts` — lazy layers, readout, staleness

**Files:**
- Modify (replace): `web/src/main.ts`

```ts
import "./style.css";
import * as THREE from "three";
import { debugWind, driftStats } from "./debugWind";
import { sampleByte } from "./field";
import { formatLonLat, formatValidTime, formatValue, windFrom } from "./format";
import { Globe } from "./globe";
import { drawLegend } from "./legend";
import { decodeValue, parseManifest, staleness, type LayerName, type ScalarName } from "./manifest";
import { SCALAR_LAYERS } from "./scales";
import { loadField, rgbaDataTexture, type LoadedField } from "./textures";
import { Panel } from "./ui";
import { WindLayer } from "./wind";

declare global {
  interface Window {
    __zephyr?: Record<string, unknown>;
  }
}

const DATA = `${import.meta.env.BASE_URL}data/`;
const HINT = "Hover the globe for values";
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const params = new URLSearchParams(location.search);
const dev = import.meta.env.DEV;
const now = () => (dev && params.has("now") ? new Date(params.get("now")!) : new Date());

async function start() {
  const res = await fetch(`${DATA}manifest.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  const manifest = parseManifest(await res.json());

  const cache = new Map<LayerName, Promise<LoadedField>>();
  const field = (name: LayerName) => {
    let p = cache.get(name);
    if (!p) {
      p = loadField(DATA + manifest.layers[name].file);
      p.catch(() => cache.delete(name)); // allow a retry on the next selection
      cache.set(name, p);
    }
    return p;
  };
  const [land, wind, first] = await Promise.all([field("land"), field("wind"), field("temperature")]);

  const canvas = $<HTMLCanvasElement>("#globe");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x05070b);
  renderer.autoClear = false;
  const globe = new Globe(canvas, land.texture, manifest.grid);
  const panel = new Panel("temperature");
  panel.setValidTime(formatValidTime(manifest.validTime, manifest.run));

  let windLayer: WindLayer | null = null;
  if (WindLayer.supported(renderer) && !(dev && params.has("nofloat"))) {
    const side = matchMedia("(pointer: coarse)").matches ? 128 : 256;
    windLayer = new WindLayer(renderer, globe.camera, wind.texture, manifest.layers.wind, manifest.grid, side);
    const debug = dev ? params.get("debug") : null;
    if (debug === "eastward" || debug === "rotation") {
      const d = debugWind(debug, manifest.grid);
      windLayer.setWind(rgbaDataTexture(d.data, manifest.grid.width, manifest.grid.height), d.layer);
    }
    globe.controls.addEventListener("change", () => windLayer?.cameraMoved());
  } else {
    panel.notice("Wind animation needs WebGL float render targets, which this device lacks. Color layers still work.");
  }
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  panel.setWind(windLayer !== null, !reducedMotion);
  windLayer?.setVisible(!reducedMotion);
  panel.onWind = (on) => windLayer?.setVisible(on);

  let active: { name: ScalarName; field: LoadedField } | null = { name: "temperature", field: first };
  const show = () => {
    const layer = active && manifest.layers[active.name];
    const scale = active && SCALAR_LAYERS[active.name].scale;
    globe.setScalar(active?.field.texture ?? null, layer ?? undefined, scale ?? undefined);
    drawLegend($("#legend"), $("#legend-ticks"), scale, layer?.units);
  };
  show();

  let selection = 0;
  panel.onLayer = async (name) => {
    const token = ++selection;
    if (!name) {
      active = null;
      return show();
    }
    panel.setBusy(true);
    try {
      const loaded = await field(name);
      if (token !== selection) return; // a newer choice won
      active = { name, field: loaded };
      show();
    } catch (err) {
      console.error(err);
      panel.notice(`Couldn't load the ${SCALAR_LAYERS[name].label.toLowerCase()} layer.`);
    } finally {
      if (token === selection) panel.setBusy(false);
    }
  };

  const describe = (lon: number, lat: number) => {
    const w = manifest.layers.wind;
    const [u, v] = [0, 1].map((c) => decodeValue(sampleByte(wind.pixels, manifest.grid, lon, lat, c), w, c));
    const from = windFrom(u, v);
    const parts = [formatLonLat(lon, lat)];
    if (active) {
      const layer = manifest.layers[active.name];
      parts.push(formatValue(decodeValue(sampleByte(active.field.pixels, manifest.grid, lon, lat), layer), layer.units));
    }
    parts.push(`wind ${from.speed.toFixed(1)} m/s from ${from.compass}`);
    return parts.join(" · ");
  };
  const readout = (e: PointerEvent) => {
    const hit = globe.pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    panel.setReadout(hit ? describe(...hit) : HINT);
  };
  canvas.addEventListener("pointermove", (e) => e.pointerType === "mouse" && readout(e));
  canvas.addEventListener("pointerup", (e) => e.pointerType !== "mouse" && readout(e));
  canvas.addEventListener("pointerleave", () => panel.setReadout(HINT));

  const checkStale = () => {
    const s = staleness(manifest.validTime, now());
    panel.setBanner(s.stale ? `Weather data is ${Math.round(s.ageHours)} hours old — the refresh may be delayed.` : null);
  };
  checkStale();
  setInterval(checkStale, 60_000);

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    globe.resize(innerWidth, innerHeight);
    windLayer?.resize();
  };
  addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop((t) => {
    globe.controls.update();
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(globe.scene, globe.camera);
    windLayer?.render(t);
  });

  if (dev) {
    window.__zephyr = {
      describe,
      view: (lon: number, lat: number) => globe.view(lon, lat),
      drift: async (ms: number, box: [number, number, number, number]) => {
        if (!windLayer) return null;
        const before = windLayer.readParticles();
        await new Promise((r) => setTimeout(r, ms));
        return driftStats(before, windLayer.readParticles(), box);
      },
    };
  }
}

start().catch((err: unknown) => {
  console.error(err);
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = "Couldn't load the weather data. Please try again later.";
  document.body.append(box);
});
```

Type-check + tests, then commit: "Wire layers, readout and staleness banner".

### Task 12: Verify M4 in the browser

With `zephyr-web` running:

1. Switch each layer (click radios via `find`/`computer`): Temperature,
   Precipitation, Cloud cover, None. Screenshot each. Legend ticks match the
   scale (e.g. precipitation `0.00 mm/h … 12.5 mm/h … 50.0 mm/h`), legend hidden
   for None. `read_network_requests`: precipitation and clouds PNGs are fetched
   only on first selection.
2. Light rain visible: precipitation layer shows faint blue where rates are
   0.1–1 mm/h (sqrt encoding + scale), not just intense cores.
3. `__zephyr.describe(-0.13, 51.5)` → three parts including `wind … from …`.
   Cross-check the wind direction against the drift sign over the same box.
4. Wind toggle off → trails disappear; on → return.
5. Staleness: `?now=2026-10-01T00:00Z` → amber banner with an hour count;
   default URL → no banner.
6. Mobile: `resize_window` preset `mobile`, reload → ☰ visible, panel
   collapsed; tap ☰ → panel opens; tap globe → readout updates. Reset to
   `desktop` afterwards.
7. Console errors: none.

Commit any fixes; then **checkpoint** with screenshots.

---

## M5 — Automation and deploy

M5 has steps only the user can do (accounts, secrets). They are marked
**[user]**. Claude never handles key files or secret values.

### Task 13: Firebase + CI configuration files

**Files:**
- Create: `firebase.json`, `.github/workflows/ci.yml`, `.github/workflows/refresh.yml`

**Step 1: Look up current action majors** (do not assume)

```powershell
foreach ($r in "actions/checkout","actions/setup-python","actions/setup-node","FirebaseExtended/action-hosting-deploy") { "$r " + (gh api "repos/$r/releases/latest" --jq .tag_name) }
```

Use the returned majors (e.g. `@v5`) in the workflows below; the plan shows
`@vN` placeholders. `action-hosting-deploy` is conventionally referenced as
`@v0`.

**Step 2: `firebase.json`**

```json
{
  "hosting": {
    "public": "web/dist",
    "ignore": ["firebase.json", "**/.*"],
    "headers": [
      { "source": "/data/manifest.json", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
      { "source": "/data/*.png", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] },
      { "source": "/assets/**", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] }
    ]
  }
}
```

**Step 3: `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  pipeline:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@vN
      - uses: actions/setup-python@vN
        with:
          python-version: "3.11"
          cache: pip
          cache-dependency-path: pipeline/pyproject.toml
      - run: pip install -e "pipeline[dev]"
      - run: python -m cfgrib selfcheck
      - run: python -m pytest pipeline -q
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@vN
      - uses: actions/setup-node@vN
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm --prefix web ci
      - run: npm --prefix web test
      - run: npm --prefix web run build
```

**Step 4: `.github/workflows/refresh.yml`**

Runs ~4.5 h after each GFS cycle (00/06/12/18z), when the cycle's early
forecast hours are published.

```yaml
name: refresh-data
on:
  schedule:
    - cron: "30 4,10,16,22 * * *"
  workflow_dispatch:
    inputs:
      deploy:
        description: Deploy to Firebase Hosting
        type: boolean
        default: true
permissions:
  contents: read
concurrency:
  group: refresh
  cancel-in-progress: false
jobs:
  refresh:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@vN
      - uses: actions/setup-python@vN
        with:
          python-version: "3.11"
          cache: pip
          cache-dependency-path: pipeline/pyproject.toml
      - run: pip install -e "pipeline[dev]"
      - run: python -m pytest pipeline -q
      - name: Build textures from the latest GFS run
        run: python -m zephyr_pipeline --out web/public/data
      - uses: actions/setup-node@vN
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm --prefix web ci
      - run: npm --prefix web run build
      - name: Deploy
        if: github.event_name == 'schedule' || inputs.deploy
        uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
          projectId: ${{ vars.FIREBASE_PROJECT_ID }}
          channelId: live
```

(The project ID lives in a repository *variable*, not in code, so the repo
works for anyone who forks it with their own project.)

**Step 5: Build locally to confirm `web/dist` contains `data/`**

```powershell
npm --prefix web run build
Get-ChildItem web\dist\data -Name
```

Expected: `manifest.json` + six PNGs.

**Step 6: Commit** ("Add CI, scheduled refresh workflow and Firebase config").

### Task 14: GitHub repo **[confirm with user first]**

Pushing creates a visible repository. Ask the user for **visibility** (public
suits a portfolio; note that scheduled workflows in public repos are disabled
by GitHub after 60 days without repository activity) and name (default
`zephyr`). Then:

```powershell
gh repo create josh-W42/zephyr --public --source . --remote origin --push
```

Verify: `gh run list --limit 3` → the `ci` run for `main`; wait for it
(`gh run watch`) → both jobs green. **This is the first real Linux run of
ecCodes** — the `cfgrib selfcheck` step must print `Your system is ready.`

### Task 15: Firebase project + deploy credentials **[user]**

1. **[user]** Create a Firebase project in the console (Spark plan is enough for
   Hosting). Tell Claude the project ID.
2. **[user]** In Google Cloud console → IAM & Admin → Service accounts: create
   `zephyr-deployer` with **only** the *Firebase Hosting Admin* role; create a
   JSON key; then run, from the repo directory:
   `gh secret set FIREBASE_SERVICE_ACCOUNT < path\to\key.json` and delete the
   key file.
   (Unverified: whether Hosting Admin alone suffices for
   `action-hosting-deploy` on the live channel. If the first deploy fails with a
   permission error, add the narrowest role the error names — do not grant
   Editor/Owner.)
3. Claude: `gh variable set FIREBASE_PROJECT_ID --body <project-id>`.

### Task 16: First scheduled-path runs

1. Dry run: `gh workflow run refresh-data -f deploy=false` → `gh run watch` →
   green; logs show `GFS … f00N` and six texture lines.
2. Deploy: `gh workflow run refresh-data -f deploy=true` → green.
3. Verify the live site:
   - `curl -sI https://<project-id>.web.app/data/manifest.json` → `cache-control: no-cache`
   - `curl -sI https://<project-id>.web.app/data/<wind file>` → `immutable`
   - Open it in the Browser pane: globe renders, wind animates, no console
     errors, validity line within ~10 h of now.
4. Record the URL in the design doc and memory; commit.

**Checkpoint** with the live URL.

---

## M6 — Polish

Polish is discovery-driven, so these tasks define *what must be true* and how
to measure it, rather than prescribing code.

### Task 17: Frame-time benchmark

Follow the telemetry-viewer benchmarking rules: the Browser pane must be
visible; do not poll during a run; close other tabs on the same origin.

1. Add a `?bench=<seconds>` mode (dev and prod): after a 3 s warm-up, record
   `requestAnimationFrame` deltas and `document.visibilityState` per frame in
   memory; at the end store `{ frames, p50, p95, p99, hiddenFrames }` on
   `window.__zephyrBench` and log it once. A run with `hiddenFrames > 0` is
   invalid.
2. Runs (each 20 s, read once at the end): desktop 256² particles; desktop
   `?particles=128`; mobile emulation (`resize_window` mobile) 128².
3. Target: desktop p95 ≤ 20 ms at 256². If missed, profile which pass costs
   most (compute vs trails vs composite) before changing constants.
4. Record the table in the README.

### Task 18: Visual tuning and palette review

- Tune `SPEED`, `DROP_RATE`, `FADE`, point size so a 10 m/s wind reads as
  flowing, not jittering, at default zoom; make rotation speed scale with
  camera distance (`controls.rotateSpeed`).
- Review the temperature palette with the **dataviz** skill (color-vision
  deficiency, perceptual ordering); adjust stops in `scales.ts` only.

### Task 19: Accessibility and mobile pass

- Run the **design:accessibility-review** skill against the sidebar.
- Keyboard: all controls reachable and operable; visible focus; a keyboard way
  to rotate the globe (arrow keys when the canvas has focus).
- `prefers-reduced-motion`: wind starts off (already wired) — verify with
  `resize_window`'s emulation or a media override.
- Mobile: panel doesn't cover more than ~55% of the screen; tap readout works;
  device-pixel-ratio cap keeps frame times in budget (Task 17 numbers).

### Task 20: README and cleanup

- `README.md`: what it is (link to the live site + screenshot), architecture
  diagram (pipeline → textures → GPU), the key decisions and why (AWS byte
  ranges over NOMADS, 8-bit + sqrt precipitation, texel-center mapping,
  GPU particles vs apsis's worker, screen-space trails, content-hashed
  textures + atomic manifest), M0 findings summary, benchmark table, how to run
  locally, operations notes (60-day schedule disable, re-running the workflow,
  the staleness banner).
- Decide with the user whether to keep `web/uv-probe.html` / `pipeline/spikes`
  as evidence (recommended: keep, referenced from the README).
- Update memory: project status, live URL.

**Final checkpoint:** live URL, screenshots, benchmark table.
