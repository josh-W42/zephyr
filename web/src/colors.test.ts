import { describe, expect, it } from "vitest";
import { colorAt, inverse, normalize, scaleBytes, type ColorScale } from "./colors";

const S: ColorScale = {
  domain: [0, 100],
  transform: "linear",
  stops: [
    { value: 0, color: "#000000", alpha: 0 },
    { value: 50, color: "#ff0000", alpha: 1 },
    { value: 100, color: "#ffffff", alpha: 1 },
  ],
};
const SQ: ColorScale = { ...S, domain: [0, 64], transform: "sqrt" };

describe("colorAt", () => {
  it("returns stop colors exactly", () => expect(colorAt(S, 50)).toEqual([255, 0, 0, 255]));
  it("interpolates between stops", () => expect(colorAt(S, 25)).toEqual([128, 0, 0, 128]));
  it("clamps outside the stops", () => {
    expect(colorAt(S, -5)).toEqual([0, 0, 0, 0]);
    expect(colorAt(S, 500)).toEqual([255, 255, 255, 255]);
  });
});

describe("normalize / inverse", () => {
  it("linear", () => expect(normalize(S, 25)).toBe(0.25));
  it("sqrt", () => {
    expect(normalize(SQ, 16)).toBeCloseTo(0.5);
    expect(inverse(SQ, 0.5)).toBeCloseTo(16);
  });
  it("clamps", () => expect(normalize(S, 250)).toBe(1));
});

it("scaleBytes builds a 256-texel RGBA ramp", () => {
  const b = scaleBytes(S);
  expect(b.length).toBe(256 * 4);
  expect([...b.slice(0, 4)]).toEqual([0, 0, 0, 0]);
  expect([...b.slice(255 * 4)]).toEqual([255, 255, 255, 255]);
});
