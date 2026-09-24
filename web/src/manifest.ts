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
const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

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
  if (![...min, ...max].every(isFiniteNumber)) fail(`non-finite range for ${name}`);
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
    if (!isFiniteNumber(grid[k])) fail(`bad grid.${k}`);
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
