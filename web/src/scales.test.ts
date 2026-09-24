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
