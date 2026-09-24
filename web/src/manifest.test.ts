import { describe, expect, it } from "vitest";
import { decodeValue, ManifestError, parseManifest, staleness, type Layer } from "./manifest";

const layer = (file: string, n = 1, encoding = "linear") => ({
  file,
  units: "x",
  encoding,
  min: Array(n).fill(0),
  max: Array(n).fill(10),
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
