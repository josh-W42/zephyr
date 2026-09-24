import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

function lonLatToVec3(lonDeg: number, latDeg: number, r = 1): THREE.Vector3 {
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const lat = THREE.MathUtils.degToRad(latDeg);
  return new THREE.Vector3(
    r * Math.cos(lat) * Math.cos(lon),
    r * Math.sin(lat),
    -r * Math.cos(lat) * Math.sin(lon),
  );
}

// Equirectangular test texture: column 0 = lon -180, row 0 = lat +90.
const W = 2048;
const H = 1024;
const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext("2d")!;
const x = (lon: number) => ((lon + 180) / 360) * W;
const y = (lat: number) => ((90 - lat) / 180) * H;

ctx.fillStyle = "#223";
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = "#f0f";
ctx.fillRect(0, 0, W, y(80));
const meridians: [number, string][] = [[0, "#f00"], [90, "#0f0"], [-90, "#00f"]];
for (const [lon, color] of meridians) {
  ctx.fillStyle = color;
  ctx.fillRect(x(lon) - 3, 0, 6, H);
}
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, 3, H);
ctx.fillRect(W - 3, 0, 3, H);
ctx.fillStyle = "#ff0";
ctx.fillRect(0, y(0) - 3, W, 6);

const texture = new THREE.CanvasTexture(canvas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.wrapS = THREE.RepeatWrapping;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
const controls = new OrbitControls(camera, renderer.domElement);

scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), new THREE.MeshBasicMaterial({ map: texture })));

const markers: [number, number, number][] = [
  [0, 0, 0xffff00],
  [90, 0, 0x00ffff],
  [-90, 0, 0xff8800],
  [0, 85, 0xffffff],
  [180, 0, 0xff0000],
];
for (const [lon, lat, color] of markers) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.03), new THREE.MeshBasicMaterial({ color }));
  m.position.copy(lonLatToVec3(lon, lat, 1.01));
  scene.add(m);
}

function view(lon: number, lat: number) {
  camera.position.copy(lonLatToVec3(lon, lat, 3.5));
  controls.update();
}
(window as unknown as { view: typeof view }).view = view;
view(0, 20);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
