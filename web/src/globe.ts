import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ColorScale } from "./colors";
import { GLSL_GEO, lonLatToVec3, vec3ToLonLat, type Grid } from "./geo";
import type { Layer } from "./manifest";
import { gridUniforms, scaleTexture } from "./textures";

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
${GLSL_GEO}
uniform sampler2D uLand;
uniform sampler2D uField;
uniform sampler2D uScale;
uniform float uHasField;
uniform vec2 uFieldRange;
uniform float uFieldSqrt;
uniform vec2 uDomain;
uniform float uScaleSqrt;
varying vec3 vDir;

float decode(float b) {
  if (uFieldSqrt > 0.5) {
    float s = mix(sqrt(uFieldRange.x), sqrt(uFieldRange.y), b);
    return s * s;
  }
  return mix(uFieldRange.x, uFieldRange.y, b);
}

float normalized(float v) {
  float t = uScaleSqrt > 0.5
    ? (sqrt(max(v, 0.0)) - sqrt(uDomain.x)) / (sqrt(uDomain.y) - sqrt(uDomain.x))
    : (v - uDomain.x) / (uDomain.y - uDomain.x);
  return clamp(t, 0.0, 1.0);
}

void main() {
  vec2 uv = gridTexUV(dirToLonLat(normalize(vDir)));
  float land = texture2D(uLand, uv).r;
  vec3 color = mix(vec3(0.043, 0.063, 0.098), vec3(0.12, 0.14, 0.17), land);
  if (uHasField > 0.5) {
    float t = normalized(decode(texture2D(uField, uv).r));
    vec4 c = texture2D(uScale, vec2((t * 255.0 + 0.5) / 256.0, 0.5));
    color = mix(color, c.rgb, c.a);
  }
  float coast = 1.0 - smoothstep(0.0, fwidth(land) * 1.5 + 1e-4, abs(land - 0.5));
  color = mix(color, vec3(0.85), coast * 0.55);
  gl_FragColor = vec4(color, 1.0);
}`;

const FOV = 35;
const DEFAULT_DISTANCE = 3.4;

export class Globe {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
  readonly controls: OrbitControls;
  private readonly material: THREE.ShaderMaterial;
  private readonly raycaster = new THREE.Raycaster();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 1);

  constructor(canvas: HTMLCanvasElement, land: THREE.Texture, grid: Grid) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...gridUniforms(grid),
        uLand: { value: land },
        uField: { value: null },
        uScale: { value: null },
        uHasField: { value: 0 },
        uFieldRange: { value: new THREE.Vector2() },
        uFieldSqrt: { value: 0 },
        uDomain: { value: new THREE.Vector2() },
        uScaleSqrt: { value: 0 },
      },
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 192, 96), this.material));
    this.camera.position.set(...lonLatToVec3(-30, 25, DEFAULT_DISTANCE));
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12; // the default 0.05 coasted ~100° after a fast drag
    this.controls.minDistance = 1.25;
    this.controls.maxDistance = 6;
  }

  /** Call once per frame. Rotation slows as the camera nears the surface so the globe tracks the cursor. */
  update() {
    const altitude = this.camera.position.length() - 1;
    this.controls.rotateSpeed = THREE.MathUtils.clamp(altitude / (DEFAULT_DISTANCE - 1), 0.1, 1);
    this.controls.update();
  }

  setScalar(field: THREE.Texture | null, layer?: Layer, scale?: ColorScale) {
    const u = this.material.uniforms;
    if (!field || !layer || !scale) {
      u.uHasField.value = 0;
      return;
    }
    (u.uScale.value as THREE.Texture | null)?.dispose();
    u.uField.value = field;
    u.uScale.value = scaleTexture(scale);
    u.uHasField.value = 1;
    u.uFieldRange.value.set(layer.min[0], layer.max[0]);
    u.uFieldSqrt.value = layer.encoding === "sqrt" ? 1 : 0;
    u.uDomain.value.set(...scale.domain);
    u.uScaleSqrt.value = scale.transform === "sqrt" ? 1 : 0;
  }

  resize(width: number, height: number) {
    const aspect = width / height;
    this.camera.aspect = aspect;
    // Keep the narrower screen dimension at FOV so the globe fits portrait phones too.
    this.camera.fov =
      aspect >= 1 ? FOV : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / aspect));
    this.camera.updateProjectionMatrix();
  }

  /** Lon/lat under a point in normalized device coordinates, or null off-globe. */
  pick(ndcX: number, ndcY: number): [number, number] | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.ray.intersectSphere(this.sphere, new THREE.Vector3());
    return hit ? vec3ToLonLat([hit.x, hit.y, hit.z]) : null;
  }

  view(lon: number, lat: number, distance = this.camera.position.length()) {
    this.camera.position.set(...lonLatToVec3(lon, lat, distance));
    this.controls.update();
  }
}
