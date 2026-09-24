import * as THREE from "three";
import { scaleBytes, type ColorScale } from "./colors";
import type { FieldPixels } from "./field";
import type { Grid } from "./geo";

export interface LoadedField {
  texture: THREE.Texture;
  pixels: FieldPixels;
}

function dataTextureSettings<T extends THREE.Texture>(t: T): T {
  t.flipY = false; // row 0 (north) at v = 0; ImageBitmaps ignore flipY anyway
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export async function loadField(url: string): Promise<LoadedField> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // No color conversion or premultiplication: the bytes are data, not colors.
  const bitmap = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return {
    texture: dataTextureSettings(new THREE.Texture(bitmap)),
    pixels: { width: bitmap.width, height: bitmap.height, data },
  };
}

export function rgbaDataTexture(data: Uint8Array, width: number, height: number): THREE.DataTexture {
  return dataTextureSettings(new THREE.DataTexture(data, width, height, THREE.RGBAFormat));
}

export function scaleTexture(scale: ColorScale): THREE.DataTexture {
  const t = rgbaDataTexture(scaleBytes(scale), 256, 1);
  t.wrapS = THREE.ClampToEdgeWrapping;
  return t;
}

export function gridUniforms(g: Grid) {
  return {
    uGrid: { value: new THREE.Vector4(g.lon0, g.lat0, g.dlon, g.dlat) },
    uGridSize: { value: new THREE.Vector2(g.width, g.height) },
  };
}
