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
