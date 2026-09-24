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
