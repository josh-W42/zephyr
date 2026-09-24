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
