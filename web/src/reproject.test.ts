import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { lonLatToVec3 } from "./geo";
import { emptyCameraState, reprojectUV, sphereHit, TRAIL_RADIUS, updateCameraState } from "./reproject";

function cam(lon: number, lat: number, dist = 3.4) {
  const c = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  c.position.set(...lonLatToVec3(lon, lat, dist));
  c.lookAt(0, 0, 0);
  c.updateProjectionMatrix();
  return updateCameraState(c, emptyCameraState());
}

const near = (a: THREE.Vector3, b: THREE.Vector3, eps = 1e-6) => expect(a.distanceTo(b)).toBeLessThan(eps);
const GRID: [number, number][] = [];
for (let u = 0.3; u <= 0.71; u += 0.1) for (let v = 0.3; v <= 0.71; v += 0.1) GRID.push([u, v]);

describe("sphereHit", () => {
  it("centre pixel hits the point under the camera", () => {
    near(sphereHit([0.5, 0.5], cam(0, 0))!, new THREE.Vector3(TRAIL_RADIUS, 0, 0));
  });
  it("corner pixel misses the globe", () => {
    expect(sphereHit([0.02, 0.02], cam(0, 0))).toBeNull();
  });
});

describe("reprojectUV", () => {
  it("is the identity when the camera has not moved", () => {
    const c = cam(20, 10);
    for (const uv of GRID) {
      const r = reprojectUV(uv, c, c)!;
      expect(r[0]).toBeCloseTo(uv[0], 6);
      expect(r[1]).toBeCloseTo(uv[1], 6);
    }
  });

  it("returns where the same surface point was on the previous screen", () => {
    const [cur, prev] = [cam(10, 5), cam(0, 0)];
    let hits = 0;
    for (const uv of GRID) {
      const r = reprojectUV(uv, cur, prev);
      if (!r) continue;
      hits++;
      near(sphereHit(r, prev)!, sphereHit(uv, cur)!, 1e-5);
    }
    expect(hits).toBeGreaterThan(10);
  });

  it("moves east-lying points to the right of the previous screen (M0 axes)", () => {
    const r = reprojectUV([0.5, 0.5], cam(10, 0), cam(0, 0))!;
    expect(r[0]).toBeGreaterThan(0.5);
    expect(r[1]).toBeCloseTo(0.5, 6);
  });

  it("returns null for points hidden behind the globe last frame", () => {
    expect(reprojectUV([0.5, 0.5], cam(120, 0), cam(0, 0))).toBeNull();
  });

  it("returns null off the globe", () => {
    expect(reprojectUV([0.02, 0.02], cam(0, 0), cam(0, 0))).toBeNull();
  });
});
