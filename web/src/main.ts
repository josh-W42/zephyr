import "./style.css";
import * as THREE from "three";
import { runBench, type BenchResult } from "./bench";
import { debugWind, driftStats } from "./debugWind";
import { sampleByte } from "./field";
import { formatLonLat, formatValidTime, formatValue, windFrom } from "./format";
import { vec3ToLonLat } from "./geo";
import { Globe } from "./globe";
import { drawLegend } from "./legend";
import { decodeValue, parseManifest, staleness, type LayerName, type ScalarName } from "./manifest";
import { SCALAR_LAYERS } from "./scales";
import { loadField, rgbaDataTexture, type LoadedField } from "./textures";
import { Panel } from "./ui";
import { WindLayer } from "./wind";

declare global {
  interface Window {
    __zephyr?: Record<string, unknown>;
    __zephyrBench?: Promise<BenchResult>;
  }
}

/** Integer query parameter within [min, max], else null. */
function intParam(name: string, min: number, max: number): number | null {
  const n = Number(params.get(name));
  return params.has(name) && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

const DATA = `${import.meta.env.BASE_URL}data/`;
const HINT = "Hover the globe for values";
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const params = new URLSearchParams(location.search);
const dev = import.meta.env.DEV;
const now = () => (dev && params.has("now") ? new Date(params.get("now")!) : new Date());

async function start() {
  const res = await fetch(`${DATA}manifest.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  const manifest = parseManifest(await res.json());

  const cache = new Map<LayerName, Promise<LoadedField>>();
  const field = (name: LayerName) => {
    let p = cache.get(name);
    if (!p) {
      p = loadField(DATA + manifest.layers[name].file);
      p.catch(() => cache.delete(name)); // allow a retry on the next selection
      cache.set(name, p);
    }
    return p;
  };
  const [land, wind, first] = await Promise.all([field("land"), field("wind"), field("temperature")]);

  const canvas = $<HTMLCanvasElement>("#globe");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x05070b);
  renderer.autoClear = false;
  const globe = new Globe(canvas, land.texture, manifest.grid);
  const panel = new Panel("temperature");
  panel.setValidTime(formatValidTime(manifest.validTime, manifest.run));

  let windLayer: WindLayer | null = null;
  if (WindLayer.supported(renderer) && !(dev && params.has("nofloat"))) {
    const side = intParam("particles", 32, 1024) ?? (matchMedia("(pointer: coarse)").matches ? 128 : 256);
    windLayer = new WindLayer(renderer, globe.camera, wind.texture, manifest.layers.wind, manifest.grid, side);
    const debug = dev ? params.get("debug") : null;
    if (debug === "eastward" || debug === "rotation") {
      const d = debugWind(debug, manifest.grid);
      windLayer.setWind(rgbaDataTexture(d.data, manifest.grid.width, manifest.grid.height), d.layer);
    }
  } else {
    panel.notice("Wind animation needs WebGL float render targets, which this device lacks. Color layers still work.");
  }
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  panel.setWind(windLayer !== null, !reducedMotion);
  windLayer?.setVisible(!reducedMotion);
  panel.onWind = (on) => windLayer?.setVisible(on);

  let active: { name: ScalarName; field: LoadedField } | null = { name: "temperature", field: first };
  const show = () => {
    const layer = active && manifest.layers[active.name];
    const config = active && SCALAR_LAYERS[active.name];
    const scale = config?.scale ?? null;
    globe.setScalar(active?.field.texture ?? null, layer ?? undefined, scale ?? undefined);
    drawLegend($("#legend"), $("#legend-ticks"), scale, layer?.units, config?.ticks);
  };
  show();

  let selection = 0;
  panel.onLayer = async (name) => {
    const token = ++selection;
    if (!name) {
      active = null;
      return show();
    }
    panel.setBusy(true);
    try {
      const loaded = await field(name);
      if (token !== selection) return; // a newer choice won
      active = { name, field: loaded };
      show();
    } catch (err) {
      console.error(err);
      panel.notice(`Couldn't load the ${SCALAR_LAYERS[name].label.toLowerCase()} layer.`);
    } finally {
      if (token === selection) panel.setBusy(false);
    }
  };

  const describe = (lon: number, lat: number) => {
    const w = manifest.layers.wind;
    const [u, v] = [0, 1].map((c) => decodeValue(sampleByte(wind.pixels, manifest.grid, lon, lat, c), w, c));
    const from = windFrom(u, v);
    const parts = [formatLonLat(lon, lat)];
    if (active) {
      const layer = manifest.layers[active.name];
      parts.push(formatValue(decodeValue(sampleByte(active.field.pixels, manifest.grid, lon, lat), layer), layer.units));
    }
    parts.push(`wind ${from.speed.toFixed(1)} m/s from ${from.compass}`);
    return parts.join(" · ");
  };
  const readout = (e: PointerEvent) => {
    const hit = globe.pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    panel.setReadout(hit ? describe(...hit) : HINT);
  };
  canvas.addEventListener("pointermove", (e) => e.pointerType === "mouse" && readout(e));
  canvas.addEventListener("pointerup", readout);
  // Touch pointers "leave" right after pointerup; resetting then would erase every tap.
  canvas.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && panel.setReadout(HINT));

  const checkStale = () => {
    const s = staleness(manifest.validTime, now());
    panel.setBanner(s.stale ? `Weather data is ${Math.round(s.ageHours)} hours old — the refresh may be delayed.` : null);
  };
  checkStale();
  setInterval(checkStale, 60_000);

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    globe.resize(innerWidth, innerHeight);
    windLayer?.resize();
  };
  addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop(() => {
    globe.update();
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(globe.scene, globe.camera);
    windLayer?.render();
  });

  const benchSeconds = intParam("bench", 1, 120);
  if (benchSeconds) {
    window.__zephyrBench = runBench(benchSeconds).then((r) => {
      console.info("zephyr bench", JSON.stringify(r));
      return r;
    });
  }

  if (dev) {
    window.__zephyr = {
      describe,
      view: (lon: number, lat: number) => globe.view(lon, lat),
      camera: () => {
        const p = globe.camera.position;
        return { lonLat: vec3ToLonLat([p.x, p.y, p.z]), distance: p.length() };
      },
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
