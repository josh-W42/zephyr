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
