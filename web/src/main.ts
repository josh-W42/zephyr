import "./style.css";
import * as THREE from "three";
import { debugWind, driftStats } from "./debugWind";
import { sampleByte } from "./field";
import { formatLonLat, formatValue } from "./format";
import { Globe } from "./globe";
import { drawLegend } from "./legend";
import { decodeValue, parseManifest } from "./manifest";
import { SCALAR_LAYERS } from "./scales";
import { loadField, rgbaDataTexture } from "./textures";
import { WindLayer } from "./wind";

declare global {
  interface Window {
    __zephyr?: Record<string, unknown>;
  }
}

const DATA = `${import.meta.env.BASE_URL}data/`;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const params = new URLSearchParams(location.search);
const dev = import.meta.env.DEV;

async function start() {
  const res = await fetch(`${DATA}manifest.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  const manifest = parseManifest(await res.json());
  const [land, wind, temperature] = await Promise.all([
    loadField(DATA + manifest.layers.land.file),
    loadField(DATA + manifest.layers.wind.file),
    loadField(DATA + manifest.layers.temperature.file),
  ]);

  const canvas = $<HTMLCanvasElement>("#globe");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x05070b);
  renderer.autoClear = false;
  const globe = new Globe(canvas, land.texture, manifest.grid);
  const { scale, ticks } = SCALAR_LAYERS.temperature;
  const layer = manifest.layers.temperature;
  globe.setScalar(temperature.texture, layer, scale);
  drawLegend($("#legend"), $("#legend-ticks"), scale, layer.units, ticks);

  let windLayer: WindLayer | null = null;
  if (WindLayer.supported(renderer) && !(dev && params.has("nofloat"))) {
    const side = matchMedia("(pointer: coarse)").matches ? 128 : 256;
    windLayer = new WindLayer(renderer, globe.camera, wind.texture, manifest.layers.wind, manifest.grid, side);
    const debug = dev ? params.get("debug") : null;
    if (debug === "eastward" || debug === "rotation") {
      const d = debugWind(debug, manifest.grid);
      windLayer.setWind(rgbaDataTexture(d.data, manifest.grid.width, manifest.grid.height), d.layer);
    }
  } else {
    const notice = $("#notice");
    notice.hidden = false;
    notice.textContent =
      "Wind animation needs WebGL float render targets, which this device lacks. Color layers still work.";
  }

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
    windLayer?.resize();
  };
  addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop(() => {
    globe.controls.update();
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(globe.scene, globe.camera);
    windLayer?.render();
  });

  if (dev) {
    window.__zephyr = {
      valueAt,
      view: (lon: number, lat: number) => globe.view(lon, lat),
      // Several boxes share one pair of readings so their drifts are directly comparable.
      drift: async (ms: number, ...boxes: [number, number, number, number][]) => {
        if (!windLayer) return null;
        const before = windLayer.readParticles();
        await new Promise((r) => setTimeout(r, ms));
        const after = windLayer.readParticles();
        const stats = boxes.map((box) => driftStats(before, after, box));
        return stats.length === 1 ? stats[0] : stats;
      },
    };
  }
}

start().catch((err: unknown) => {
  console.error(err);
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = "Couldn't load the weather data. Please try again later.";
  document.body.append(box);
});
