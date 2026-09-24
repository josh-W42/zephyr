# Multi-hue Palette + Reprojected Trails Implementation Plan

> **For Claude:** Execute inline in this session (user preference). Follow
> superpowers:executing-plans discipline: run every verification, commit per
> task with reasoning, surface contradictions.

**Goal:** Replace the orange-heavy temperature scale with a multi-hue one and
keep wind trails attached to the globe while the camera moves.

**Architecture:** Scales gain declared legend ticks; the legend places them
along the (possibly sqrt) scale. The trail fade pass reprojects: each pixel
ray-casts the trail sphere with the current camera and samples the previous
trail image where that surface point was last frame. The math has a tested
TypeScript twin, `reproject.ts`.

**Tech stack:** TypeScript, three r186, Vitest. Design:
`docs/plans/2026-09-24-palette-and-trail-reprojection-design.md`.

Paths are relative to `zephyr/`. Session cwd is the parent folder, so commands
use `zephyr\...`, `npm --prefix zephyr/web`, `git -C zephyr`.

---

### Task 1: Multi-hue temperature scale + legend ticks

**Files:**
- Create: `web/src/scales.test.ts`
- Modify: `web/src/scales.ts`, `web/src/legend.ts`, `web/src/style.css`, `web/src/main.ts`

**Step 1: Failing test** — `web/src/scales.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { SCALAR_LAYERS } from "./scales";

describe.each(Object.entries(SCALAR_LAYERS))("%s scale", (_, { scale, ticks }) => {
  const [lo, hi] = scale.domain;
  const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);

  it("stops strictly ascend within the domain", () => {
    const values = scale.stops.map((s) => s.value);
    expect(ascending(values)).toBe(true);
    expect(values[0]).toBeGreaterThanOrEqual(lo);
    expect(values[values.length - 1]).toBeLessThanOrEqual(hi);
  });

  it("stops are #rrggbb with alpha in [0, 1]", () => {
    for (const s of scale.stops) {
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.alpha).toBeGreaterThanOrEqual(0);
      expect(s.alpha).toBeLessThanOrEqual(1);
    }
  });

  it("declares ascending legend ticks within the domain", () => {
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ascending(ticks)).toBe(true);
    expect(ticks[0]).toBeGreaterThanOrEqual(lo);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(hi);
  });
});
```

**Step 2: Run → fail** (`ticks` is undefined). `npm --prefix zephyr/web test`

**Step 3: Implement**

`scales.ts` — type becomes
`Record<ScalarName, { label: string; scale: ColorScale; ticks: number[] }>`;
temperature stops become:

```ts
        { value: -40, color: "#3b1a63", alpha: 0.85 },
        { value: -25, color: "#5b3fbf", alpha: 0.85 },
        { value: -10, color: "#2f6fd6", alpha: 0.85 },
        { value: 0, color: "#4fc3e8", alpha: 0.85 },
        { value: 8, color: "#3fae9a", alpha: 0.85 },
        { value: 15, color: "#6dbf5a", alpha: 0.85 },
        { value: 20, color: "#c3d64f", alpha: 0.85 },
        { value: 24, color: "#f3d34a", alpha: 0.85 },
        { value: 28, color: "#f59a36", alpha: 0.85 },
        { value: 32, color: "#e0472f", alpha: 0.85 },
        { value: 38, color: "#b01f4a", alpha: 0.85 },
        { value: 45, color: "#6a0d3a", alpha: 0.85 },
```

ticks: temperature `[-40, -20, 0, 20, 40]`, precipitation `[0, 1, 5, 20, 50]`,
clouds `[0, 50, 100]`.

`legend.ts` — replace the three evenly spaced labels:

```ts
import { colorAt, inverse, normalize, type ColorScale } from "./colors";

export function drawLegend(
  canvas: HTMLCanvasElement,
  ticksEl: HTMLElement,
  scale: ColorScale | null,
  units = "",
  ticks: number[] = [],
) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ticksEl.replaceChildren();
  canvas.hidden = ticksEl.hidden = scale === null;
  if (!scale) return;
  for (let x = 0; x < canvas.width; x++) {
    const [r, g, b, a] = colorAt(scale, inverse(scale, x / (canvas.width - 1)));
    ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
    ctx.fillRect(x, 0, 1, canvas.height);
  }
  ticks.forEach((value, i) => {
    const t = normalize(scale, value);
    const span = document.createElement("span");
    span.textContent = i === ticks.length - 1 ? `${value} ${units}` : String(value);
    span.style.left = `${t * 100}%`;
    span.style.transform = `translateX(${t < 0.1 ? 0 : t > 0.9 ? -100 : -50}%)`;
    ticksEl.append(span);
  });
}
```

`style.css` — replace the `.legend figcaption` rule:

```css
.legend figcaption { position: relative; height: 1.4em; font-size: 11px; color: var(--muted); margin-top: 4px; }
.legend figcaption span { position: absolute; top: 0; white-space: nowrap; }
```

`main.ts` — `const { scale, ticks } = SCALAR_LAYERS.temperature;` and
`drawLegend($("#legend"), $("#legend-ticks"), scale, layer.units, ticks);`

**Step 4: Run → pass; `npx tsc -p .` (in web) → 0.**

**Step 5: Browser check** — screenshots from `view(-30, 20)` (Atlantic),
`view(-150, 0)` (Pacific), `view(15, 45)` (Europe): tropics show yellow→orange
structure, mid-latitudes green/teal, legend ticks aligned under the bar.
Show the user; adjust stops by eye if asked.

**Step 6: Commit** — "Switch temperature to a multi-hue scale with declared ticks".

---

### Task 2: Reprojection math (TypeScript twin)

**Files:**
- Create: `web/src/reproject.ts`, `web/src/reproject.test.ts`

**Step 1: Failing tests**

```ts
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { lonLatToVec3 } from "./geo";
import { emptyCameraState, reprojectUV, sphereHit, TRAIL_RADIUS, updateCameraState } from "./reproject";

function cam(lon: number, lat: number, dist = 3.4) {
  const c = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  c.position.set(...lonLatToVec3(lon, lat, dist));
  c.lookAt(0, 0, 0);
  c.updateProjectionMatrix();
  return updateCameraState(c, emptyCameraState());
}

const near = (a: THREE.Vector3, b: THREE.Vector3, eps = 1e-6) => expect(a.distanceTo(b)).toBeLessThan(eps);
const GRID: [number, number][] = [];
for (let u = 0.3; u <= 0.71; u += 0.1) for (let v = 0.3; v <= 0.71; v += 0.1) GRID.push([u, v]);

describe("sphereHit", () => {
  it("centre pixel hits the point under the camera", () => {
    near(sphereHit([0.5, 0.5], cam(0, 0))!, new THREE.Vector3(TRAIL_RADIUS, 0, 0));
  });
  it("corner pixel misses the globe", () => {
    expect(sphereHit([0.02, 0.02], cam(0, 0))).toBeNull();
  });
});

describe("reprojectUV", () => {
  it("is the identity when the camera has not moved", () => {
    const c = cam(20, 10);
    for (const uv of GRID) {
      const r = reprojectUV(uv, c, c)!;
      expect(r[0]).toBeCloseTo(uv[0], 6);
      expect(r[1]).toBeCloseTo(uv[1], 6);
    }
  });

  it("returns where the same surface point was on the previous screen", () => {
    const [cur, prev] = [cam(10, 5), cam(0, 0)];
    let hits = 0;
    for (const uv of GRID) {
      const r = reprojectUV(uv, cur, prev);
      if (!r) continue;
      hits++;
      near(sphereHit(r, prev)!, sphereHit(uv, cur)!, 1e-5);
    }
    expect(hits).toBeGreaterThan(10);
  });

  it("moves east-lying points to the right of the previous screen (M0 axes)", () => {
    const r = reprojectUV([0.5, 0.5], cam(10, 0), cam(0, 0))!;
    expect(r[0]).toBeGreaterThan(0.5);
    expect(r[1]).toBeCloseTo(0.5, 6);
  });

  it("returns null for points hidden behind the globe last frame", () => {
    expect(reprojectUV([0.5, 0.5], cam(120, 0), cam(0, 0))).toBeNull();
  });

  it("returns null off the globe", () => {
    expect(reprojectUV([0.02, 0.02], cam(0, 0), cam(0, 0))).toBeNull();
  });
});
```

**Step 2: Run → fail** (module missing).

**Step 3: Implement** — `web/src/reproject.ts`

```ts
import * as THREE from "three";

export const TRAIL_RADIUS = 1.002;

export interface CameraState {
  viewProj: THREE.Matrix4;
  invViewProj: THREE.Matrix4;
  position: THREE.Vector3;
}

export const emptyCameraState = (): CameraState => ({
  viewProj: new THREE.Matrix4(),
  invViewProj: new THREE.Matrix4(),
  position: new THREE.Vector3(),
});

export function updateCameraState(camera: THREE.Camera, s: CameraState): CameraState {
  camera.updateMatrixWorld();
  s.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  s.invViewProj.copy(s.viewProj).invert();
  s.position.setFromMatrixPosition(camera.matrixWorld);
  return s;
}

export function copyCameraState(from: CameraState, to: CameraState): CameraState {
  to.viewProj.copy(from.viewProj);
  to.invViewProj.copy(from.invViewProj);
  to.position.copy(from.position);
  return to;
}

/** Point on the trail sphere under a screen UV (0..1, origin bottom-left), or null. */
export function sphereHit(uv: [number, number], cam: CameraState, radius = TRAIL_RADIUS): THREE.Vector3 | null {
  const dir = new THREE.Vector3(uv[0] * 2 - 1, uv[1] * 2 - 1, 0)
    .applyMatrix4(cam.invViewProj)
    .sub(cam.position)
    .normalize();
  const b = cam.position.dot(dir);
  const disc = b * b - (cam.position.lengthSq() - radius * radius);
  if (disc < 0) return null;
  return cam.position.clone().addScaledVector(dir, -b - Math.sqrt(disc));
}

/** Where the surface point under `uv` appeared on the previous frame's screen, or null. */
export function reprojectUV(
  uv: [number, number],
  current: CameraState,
  previous: CameraState,
  radius = TRAIL_RADIUS,
): [number, number] | null {
  const p = sphereHit(uv, current, radius);
  if (!p) return null;
  if (p.dot(previous.position.clone().sub(p)) < 0) return null; // was on the far side
  const q = p.applyMatrix4(previous.viewProj);
  const r: [number, number] = [q.x * 0.5 + 0.5, q.y * 0.5 + 0.5];
  return r.every((x) => x >= 0 && x <= 1) ? r : null;
}

// GLSL twin of reprojectUV, used by the trail fade pass.
export const GLSL_REPROJECT = /* glsl */ `
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform vec3 uPrevCamPos;
uniform float uRadius;
// Returns previous-frame UV in .xy and validity (1 or 0) in .z.
vec3 reprojectUV(vec2 uv) {
  vec4 w = uInvViewProj * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vec3 dir = normalize(w.xyz / w.w - uCamPos);
  float b = dot(uCamPos, dir);
  float disc = b * b - (dot(uCamPos, uCamPos) - uRadius * uRadius);
  if (disc < 0.0) return vec3(0.0);
  vec3 p = uCamPos + dir * (-b - sqrt(disc));
  if (dot(p, uPrevCamPos - p) < 0.0) return vec3(0.0);
  vec4 q = uPrevViewProj * vec4(p, 1.0);
  vec2 r = q.xy / q.w * 0.5 + 0.5;
  if (any(lessThan(r, vec2(0.0))) || any(greaterThan(r, vec2(1.0)))) return vec3(0.0);
  return vec3(r, 1.0);
}
`;
```

**Step 4: Run → pass. Step 5: Commit** — "Add trail reprojection math with a tested TypeScript twin".

---

### Task 3: Reproject trails in WindLayer

**Files:** Modify `web/src/wind.ts`, `web/src/main.ts`

**Step 1: `wind.ts`**
- Remove `HIDE_AFTER_MOVE_MS`, `lastMove`, `cameraMoved()`, and the `moving`
  branch; `render()` takes no argument.
- Import `copyCameraState, emptyCameraState, GLSL_REPROJECT, TRAIL_RADIUS,
  updateCameraState` from `./reproject`.
- `FADE_FRAG` becomes:

  ```glsl
  ${GLSL_REPROJECT}
  uniform sampler2D uPrev;
  uniform float uFade;
  varying vec2 vUv;
  void main() {
    vec3 r = reprojectUV(vUv);
    gl_FragColor = r.z > 0.5 ? max(texture2D(uPrev, r.xy) * uFade - vec4(1.0 / 255.0), 0.0) : vec4(0.0);
  }
  ```

- Fade material uniforms add `uInvViewProj`, `uPrevViewProj` (Matrix4),
  `uCamPos`, `uPrevCamPos` (Vector3), `uRadius: TRAIL_RADIUS`. They point at
  the fields of two `CameraState`s owned by the layer (`current`, `previous`),
  so updating the states updates the uniforms.
- Fields: `private readonly current = emptyCameraState()`,
  `private readonly previous = emptyCameraState()`, `private clearNext = true`
  (first frame, `setVisible(true)` and `resize()` set it so stale or
  uninitialised trail targets are never sampled).
- `render()`:

  ```ts
  render() {
    if (!this.visible) return;
    this.variable.material.uniforms.uSeed.value = Math.random() * 100;
    this.gpu.compute();

    updateCameraState(this.camera, this.current);
    if (this.clearNext) copyCameraState(this.current, this.previous);
    const [prev, next] = this.trails;
    this.renderer.setRenderTarget(next);
    const fade = this.fade.material as THREE.ShaderMaterial;
    fade.uniforms.uPrev.value = prev.texture;
    fade.uniforms.uFade.value = this.clearNext ? 0 : FADE;
    this.clearNext = false;
    this.fade.render(this.renderer);
    this.pointsMaterial.uniforms.uParticles.value = this.gpu.getCurrentRenderTarget(this.variable).texture;
    this.renderer.render(this.pointsScene, this.camera);
    this.renderer.setRenderTarget(null);
    (this.composite.material as THREE.ShaderMaterial).uniforms.uTrail.value = next.texture;
    this.composite.render(this.renderer);
    this.trails = [next, prev];
    copyCameraState(this.current, this.previous);
  }
  ```

- `POINTS_VERT` uses `lonLatToDir(p.xy) * ${TRAIL_RADIUS.toFixed(3)}` so points
  and the reprojection sphere agree.

**Step 2: `main.ts`** — delete the `controls` `"change"` listener;
`windLayer?.render(now)` → `windLayer?.render()`; loop callback takes no arg.

**Step 3: Tests + tsc** → pass / 0.

**Step 4: Browser verification**
1. Console errors: none.
2. `left_click_drag` then an immediate screenshot: streaks visible on the globe
   mid-damping; nothing smeared outside the globe's disc.
3. Zoom (`scroll` up 5 at centre) then screenshot: trails on the globe, slightly
   soft at most.
4. Rotate to the far side via repeated drags: no ghost trails appear where
   the globe used to be.
5. Regression: real-data drift `drift(300, [-180, 180, -55, -40], [-170, -120, 15, 25])`
   → westerlies `dLon > 0`, trades `dLon < 0` (compute pass unchanged).
6. Frame time: the 3 s rAF measurement → p95 still ≈ 16.7 ms.

**Step 5: Commit** — "Reproject wind trails through camera motion instead of hiding them".

---

### Task 4: Keep the M2–M6 plan consistent

**Files:** Modify `docs/plans/2026-09-24-zephyr-m2-m6-plan.md` (M4 Task 11
code): remove the `cameraMoved` listener, `render(t)` → `render()`, and pass
`SCALAR_LAYERS[name].ticks` to `drawLegend`. Mark the M6 palette task as
"palette replaced 2026-09-24; colorblind review still due". Commit.
