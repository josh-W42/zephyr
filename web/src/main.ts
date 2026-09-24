import "./style.css";
import * as THREE from "three";
import { sampleByte } from "./field";
import { formatLonLat, formatValue } from "./format";
import { Globe } from "./globe";
import { drawLegend } from "./legend";
import { decodeValue, parseManifest } from "./manifest";
import { SCALAR_LAYERS } from "./scales";
import { loadField } from "./textures";

declare global {
  interface Window {
    __zephyr?: Record<string, unknown>;
  }
}

const DATA = `${import.meta.env.BASE_URL}data/`;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function start() {
  const res = await fetch(`${DATA}manifest.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  const manifest = parseManifest(await res.json());
  const [land, temperature] = await Promise.all([
    loadField(DATA + manifest.layers.land.file),
    loadField(DATA + manifest.layers.temperature.file),
  ]);

  const canvas = $<HTMLCanvasElement>("#globe");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x05070b);
  const globe = new Globe(canvas, land.texture, manifest.grid);
  const { scale } = SCALAR_LAYERS.temperature;
  const layer = manifest.layers.temperature;
  globe.setScalar(temperature.texture, layer, scale);
  drawLegend($("#legend"), $("#legend-ticks"), scale, layer.units);

  const valueAt = (lon: number, lat: number) =>
    decodeValue(sampleByte(temperature.pixels, manifest.grid, lon, lat), layer);

  canvas.addEventListener("pointermove", (e) => {
    const hit = globe.pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    $("#readout").textContent = hit
      ? `${formatLonLat(...hit)} · ${formatValue(valueAt(...hit), layer.units)}`
      : "Hover the globe for values";
  });

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    globe.resize(innerWidth, innerHeight);
  };
  addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop(() => {
    globe.controls.update();
    renderer.render(globe.scene, globe.camera);
  });

  if (import.meta.env.DEV) {
    window.__zephyr = { valueAt, view: (lon: number, lat: number) => globe.view(lon, lat) };
  }
}

start().catch((err: unknown) => {
  console.error(err);
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = "Couldn't load the weather data. Please try again later.";
  document.body.append(box);
});
