import { expect, it } from "vitest";
import { keyMove } from "./keys";

it.each([
  ["ArrowRight", false, { dLon: 5, dLat: 0, zoom: 1 }],
  ["ArrowLeft", false, { dLon: -5, dLat: 0, zoom: 1 }],
  ["ArrowUp", false, { dLon: 0, dLat: 5, zoom: 1 }],
  ["ArrowDown", true, { dLon: 0, dLat: -15, zoom: 1 }],
  ["+", false, { dLon: 0, dLat: 0, zoom: 0.85 }],
  ["=", false, { dLon: 0, dLat: 0, zoom: 0.85 }],
  ["-", false, { dLon: 0, dLat: 0, zoom: 1 / 0.85 }],
])("%s (shift %s)", (key, shift, expected) => {
  expect(keyMove(key, shift)).toEqual(expected);
});

it("ignores other keys so the page keeps them", () => {
  expect(keyMove("Tab", false)).toBeNull();
  expect(keyMove("a", false)).toBeNull();
});
