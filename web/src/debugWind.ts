import type { Grid } from "./geo";
import type { Layer } from "./manifest";

export type DebugWind = "eastward" | "rotation";

const RAD = Math.PI / 180;

// "rotation" is solid-body rotation about +X (lon 0, lat 0): w = x̂ × r, which in
// local east/north components is u = -U sin(lat) cos(lon), v = U sin(lon).
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
  return {
    data,
    layer: { file: "debug", units: "m/s", encoding: "linear", min: [-speed, -speed], max: [speed, speed] },
  };
}

/** Mean lon/lat motion (degrees) of particles that started inside `box` and were not respawned. */
export function driftStats(
  before: Float32Array,
  after: Float32Array,
  [lonMin, lonMax, latMin, latMax]: [number, number, number, number],
  maxJump = 20,
) {
  let n = 0;
  let dLon = 0;
  let dLat = 0;
  for (let i = 0; i < before.length; i += 4) {
    const lo = before[i];
    const la = before[i + 1];
    if (lo < lonMin || lo > lonMax || la < latMin || la > latMax) continue;
    const dl = ((after[i] - lo + 540) % 360) - 180;
    const da = after[i + 1] - la;
    if (Math.abs(dl) > maxJump || Math.abs(da) > maxJump) continue;
    n++;
    dLon += dl;
    dLat += da;
  }
  return n ? { n, dLon: dLon / n, dLat: dLat / n } : { n, dLon: 0, dLat: 0 };
}
