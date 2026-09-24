export interface Grid {
  width: number;
  height: number;
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
}

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export function lonLatToVec3(lon: number, lat: number, r = 1): Vec3 {
  const lo = lon * RAD;
  const la = lat * RAD;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo)];
}

export function vec3ToLonLat([x, y, z]: Vec3): [number, number] {
  return [Math.atan2(-z, x) / RAD, Math.asin(y / Math.hypot(x, y, z)) / RAD];
}

export function wrapLon(lon: number): number {
  return mod(lon + 180, 360) - 180;
}

export function gridTexUV(lon: number, lat: number, g: Grid): [number, number] {
  const u = mod(((lon - g.lon0) / g.dlon + 0.5) / g.width, 1);
  const v = ((lat - g.lat0) / g.dlat + 0.5) / g.height;
  return [u, v];
}

export function gridIndex(lon: number, lat: number, g: Grid): [number, number] {
  const col = mod(Math.round((lon - g.lon0) / g.dlon), g.width);
  const row = Math.min(g.height - 1, Math.max(0, Math.round((lat - g.lat0) / g.dlat)));
  return [col, row];
}

// GLSL twins of the functions above; the shaders' behaviour is verified in the
// browser against the tested TypeScript versions.
export const GLSL_GEO = /* glsl */ `
uniform vec4 uGrid;      // lon0, lat0, dlon, dlat
uniform vec2 uGridSize;  // width, height
vec3 lonLatToDir(vec2 ll) {
  vec2 r = radians(ll);
  return vec3(cos(r.y) * cos(r.x), sin(r.y), -cos(r.y) * sin(r.x));
}
vec2 dirToLonLat(vec3 d) {
  return vec2(degrees(atan(-d.z, d.x)), degrees(asin(clamp(d.y, -1.0, 1.0))));
}
vec2 gridTexUV(vec2 ll) {
  return vec2(((ll.x - uGrid.x) / uGrid.z + 0.5) / uGridSize.x,
              ((ll.y - uGrid.y) / uGrid.w + 0.5) / uGridSize.y);
}
`;
