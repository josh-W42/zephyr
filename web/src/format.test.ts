import { expect, it } from "vitest";
import { formatLonLat, formatValidTime, formatValue, windFrom } from "./format";

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

it.each([
  [0, -5, "N", 0], // blowing south = from the north
  [-5, 0, "E", 90], // blowing west = from the east
  [5, 0, "W", 270],
  [3, 3, "SW", 225],
])("wind (%d, %d) is from %s", (u, v, compass, deg) => {
  const w = windFrom(u, v);
  expect(w.compass).toBe(compass);
  expect(w.degrees).toBeCloseTo(deg);
  expect(w.speed).toBeCloseTo(Math.hypot(u, v));
});

it("formats the validity line", () => {
  expect(formatValidTime("2026-09-24T05:00:00Z", { cycle: "2026-09-24T00:00:00Z", fhour: 5 })).toBe(
    "Valid 24 Sep 05:00 UTC · GFS 00z +5 h",
  );
});
