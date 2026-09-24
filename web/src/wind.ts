import * as THREE from "three";
import { GPUComputationRenderer } from "three/addons/misc/GPUComputationRenderer.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { GLSL_GEO, type Grid } from "./geo";
import type { Layer } from "./manifest";
import {
  copyCameraState,
  emptyCameraState,
  GLSL_REPROJECT,
  TRAIL_RADIUS,
  updateCameraState,
} from "./reproject";
import { gridUniforms } from "./textures";

const SPEED = 0.02; // degrees of arc per (m/s) per frame; tuned visually in M6
const DROP_RATE = 0.003; // mean particle life ~330 frames
const FADE = 0.96;

const UPDATE = /* glsl */ `
${GLSL_GEO}
uniform sampler2D uWind;
uniform vec2 uWindMin;
uniform vec2 uWindMax;
uniform float uSeed;
float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 p = texture2D(particles, uv);
  vec2 wind = mix(uWindMin, uWindMax, texture2D(uWind, gridTexUV(p.xy)).rg);
  float coslat = max(cos(radians(p.y)), 0.05);
  p.xy += vec2(wind.x / coslat, wind.y) * ${SPEED.toFixed(4)};
  p.x = mod(p.x + 180.0, 360.0) - 180.0;
  vec2 seed = uv * 7.31 + uSeed;
  if (rand(seed) < ${DROP_RATE.toFixed(4)} || abs(p.y) > 88.0) {
    p.xy = vec2(rand(seed + 1.3) * 360.0 - 180.0, degrees(asin(rand(seed + 2.9) * 2.0 - 1.0)));
  }
  gl_FragColor = vec4(p.xy, length(wind), 1.0);
}`;

const POINTS_VERT = /* glsl */ `
${GLSL_GEO}
uniform sampler2D uParticles;
uniform float uPointSize;
attribute vec2 ref;
varying float vSpeed;
void main() {
  vec4 p = texture2D(uParticles, ref);
  vec3 world = lonLatToDir(p.xy) * ${TRAIL_RADIUS.toFixed(3)};
  vSpeed = p.z;
  if (dot(world, cameraPosition - world) < 0.0) { // far side of the globe
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  gl_PointSize = uPointSize;
}`;

const POINTS_FRAG = /* glsl */ `
varying float vSpeed;
void main() { gl_FragColor = vec4(1.0, 1.0, 1.0, clamp(vSpeed / 12.0, 0.4, 1.0)); }`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Samples last frame's trails where this pixel's surface point was, so trails
// stay on the globe as the camera moves. Subtracting one 8-bit step
// guarantees trails decay to zero in RGBA8 targets.
const FADE_FRAG = /* glsl */ `
${GLSL_REPROJECT}
uniform sampler2D uPrev;
uniform float uFade;
varying vec2 vUv;
void main() {
  vec3 r = reprojectUV(vUv);
  gl_FragColor = r.z > 0.5 ? max(texture2D(uPrev, r.xy) * uFade - vec4(1.0 / 255.0), 0.0) : vec4(0.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uTrail;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTrail, vUv); }`;

export class WindLayer {
  static supported(renderer: THREE.WebGLRenderer): boolean {
    return renderer.capabilities.maxVertexTextures > 0 && renderer.extensions.has("EXT_color_buffer_float");
  }

  private readonly gpu: GPUComputationRenderer;
  private readonly variable: ReturnType<GPUComputationRenderer["addVariable"]>;
  private readonly pointsScene = new THREE.Scene();
  private readonly pointsMaterial: THREE.ShaderMaterial;
  private readonly fade: FullScreenQuad;
  private readonly composite: FullScreenQuad;
  private trails: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly current = emptyCameraState();
  private readonly previous = emptyCameraState();
  private clearNext = true; // never sample stale or uninitialised trail targets
  private visible = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.Camera,
    wind: THREE.Texture,
    layer: Layer,
    grid: Grid,
    side: number,
  ) {
    this.gpu = new GPUComputationRenderer(side, side, renderer);
    const initial = this.gpu.createTexture();
    const d = initial.image.data as Float32Array;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.random() * 360 - 180;
      d[i + 1] = (Math.asin(Math.random() * 2 - 1) * 180) / Math.PI;
    }
    this.variable = this.gpu.addVariable("particles", UPDATE, initial);
    this.gpu.setVariableDependencies(this.variable, [this.variable]);
    Object.assign(this.variable.material.uniforms, {
      ...gridUniforms(grid),
      uWind: { value: wind },
      uWindMin: { value: new THREE.Vector2(layer.min[0], layer.min[1]) },
      uWindMax: { value: new THREE.Vector2(layer.max[0], layer.max[1]) },
      uSeed: { value: 0 },
    });
    const error = this.gpu.init();
    if (error) throw new Error(error);

    const n = side * side;
    const refs = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) refs.set([((i % side) + 0.5) / side, (Math.floor(i / side) + 0.5) / side], i * 2);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setAttribute("ref", new THREE.BufferAttribute(refs, 2));
    this.pointsMaterial = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      uniforms: {
        ...gridUniforms(grid),
        uParticles: { value: null },
        uPointSize: { value: Math.max(1, renderer.getPixelRatio()) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, this.pointsMaterial);
    points.frustumCulled = false;
    this.pointsScene.add(points);

    this.fade = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: FADE_FRAG,
        uniforms: {
          uPrev: { value: null },
          uFade: { value: FADE },
          uInvViewProj: { value: this.current.invViewProj },
          uCamPos: { value: this.current.position },
          uPrevViewProj: { value: this.previous.viewProj },
          uPrevCamPos: { value: this.previous.position },
          uRadius: { value: TRAIL_RADIUS },
        },
        blending: THREE.NoBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    // Trail targets hold premultiplied color (white * alpha over transparent black).
    this.composite = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: COMPOSITE_FRAG,
        uniforms: { uTrail: { value: null } },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    this.trails = [this.makeTarget(), this.makeTarget()];
  }

  private makeTarget() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: false });
  }

  setWind(texture: THREE.Texture, layer: Layer) {
    const u = this.variable.material.uniforms;
    u.uWind.value = texture;
    u.uWindMin.value.set(layer.min[0], layer.min[1]);
    u.uWindMax.value.set(layer.max[0], layer.max[1]);
  }

  setVisible(on: boolean) {
    this.visible = on;
    this.clearNext = true;
  }

  resize() {
    this.trails.forEach((t) => t.dispose());
    this.trails = [this.makeTarget(), this.makeTarget()];
    this.clearNext = true;
  }

  render() {
    if (!this.visible) return;
    this.variable.material.uniforms.uSeed.value = Math.random() * 100;
    this.gpu.compute();

    updateCameraState(this.camera, this.current);
    if (this.clearNext) copyCameraState(this.current, this.previous);
    const [prev, next] = this.trails;
    this.renderer.setRenderTarget(next);
    const fade = this.fade.material as THREE.ShaderMaterial;
    fade.uniforms.uPrev.value = prev.texture;
    fade.uniforms.uFade.value = this.clearNext ? 0 : FADE;
    this.clearNext = false;
    this.fade.render(this.renderer);
    this.pointsMaterial.uniforms.uParticles.value = this.gpu.getCurrentRenderTarget(this.variable).texture;
    this.renderer.render(this.pointsScene, this.camera);
    this.renderer.setRenderTarget(null);
    (this.composite.material as THREE.ShaderMaterial).uniforms.uTrail.value = next.texture;
    this.composite.render(this.renderer);
    this.trails = [next, prev];
    copyCameraState(this.current, this.previous);
  }

  /** Current particle state (lon, lat, speed, 1) — debugging only. */
  readParticles(): Float32Array {
    const rt = this.gpu.getCurrentRenderTarget(this.variable);
    const out = new Float32Array(rt.width * rt.height * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, out);
    return out;
  }
}
