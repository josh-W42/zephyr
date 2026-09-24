import { expect, it } from "vitest";
import { summarize } from "./bench";

it("summarizes frame times with nearest-rank percentiles", () => {
  const deltas = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100 ms
  expect(summarize(deltas, 0)).toEqual({ frames: 100, p50: 50, p95: 95, p99: 99, max: 100, hiddenFrames: 0, valid: true });
});

it("marks runs with hidden frames invalid", () => {
  expect(summarize([16, 17, 16], 2).valid).toBe(false);
});

it("marks empty runs invalid", () => {
  expect(summarize([], 0)).toMatchObject({ frames: 0, valid: false });
});
