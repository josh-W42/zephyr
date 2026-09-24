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
