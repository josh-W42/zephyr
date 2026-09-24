import * as THREE from "three";

export const TRAIL_RADIUS = 1.002;

export interface CameraState {
  viewProj: THREE.Matrix4;
  invViewProj: THREE.Matrix4;
  position: THREE.Vector3;
}

export const emptyCameraState = (): CameraState => ({
  viewProj: new THREE.Matrix4(),
  invViewProj: new THREE.Matrix4(),
  position: new THREE.Vector3(),
});

export function updateCameraState(camera: THREE.Camera, s: CameraState): CameraState {
  camera.updateMatrixWorld();
  s.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  s.invViewProj.copy(s.viewProj).invert();
  s.position.setFromMatrixPosition(camera.matrixWorld);
  return s;
}

export function copyCameraState(from: CameraState, to: CameraState): CameraState {
  to.viewProj.copy(from.viewProj);
  to.invViewProj.copy(from.invViewProj);
  to.position.copy(from.position);
  return to;
}

/** Point on the trail sphere under a screen UV (0..1, origin bottom-left), or null. */
export function sphereHit(uv: [number, number], cam: CameraState, radius = TRAIL_RADIUS): THREE.Vector3 | null {
  const dir = new THREE.Vector3(uv[0] * 2 - 1, uv[1] * 2 - 1, 0)
    .applyMatrix4(cam.invViewProj)
    .sub(cam.position)
    .normalize();
  const b = cam.position.dot(dir);
  const disc = b * b - (cam.position.lengthSq() - radius * radius);
  if (disc < 0) return null;
  return cam.position.clone().addScaledVector(dir, -b - Math.sqrt(disc));
}

/** Where the surface point under `uv` appeared on the previous frame's screen, or null. */
export function reprojectUV(
  uv: [number, number],
  current: CameraState,
  previous: CameraState,
  radius = TRAIL_RADIUS,
): [number, number] | null {
  const p = sphereHit(uv, current, radius);
  if (!p) return null;
  if (p.dot(previous.position.clone().sub(p)) < 0) return null; // was on the far side
  const q = p.applyMatrix4(previous.viewProj);
  const r: [number, number] = [q.x * 0.5 + 0.5, q.y * 0.5 + 0.5];
  return r.every((x) => x >= 0 && x <= 1) ? r : null;
}

// GLSL twin of reprojectUV, used by the trail fade pass.
export const GLSL_REPROJECT = /* glsl */ `
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform vec3 uPrevCamPos;
uniform float uRadius;
// Returns previous-frame UV in .xy and validity (1 or 0) in .z.
vec3 reprojectUV(vec2 uv) {
  vec4 w = uInvViewProj * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vec3 dir = normalize(w.xyz / w.w - uCamPos);
  float b = dot(uCamPos, dir);
  float disc = b * b - (dot(uCamPos, uCamPos) - uRadius * uRadius);
  if (disc < 0.0) return vec3(0.0);
  vec3 p = uCamPos + dir * (-b - sqrt(disc));
  if (dot(p, uPrevCamPos - p) < 0.0) return vec3(0.0);
  vec4 q = uPrevViewProj * vec4(p, 1.0);
  vec2 r = q.xy / q.w * 0.5 + 0.5;
  if (any(lessThan(r, vec2(0.0))) || any(greaterThan(r, vec2(1.0)))) return vec3(0.0);
  return vec3(r, 1.0);
}
`;
