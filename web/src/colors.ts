export interface ColorStop {
  value: number;
  color: string; // #rrggbb, sRGB
  alpha: number; // 0..1
}

export interface ColorScale {
  domain: [number, number];
  transform: "linear" | "sqrt";
  stops: ColorStop[]; // ascending by value
}

export type RGBA = [number, number, number, number];

const hex = (c: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];

export function normalize(s: ColorScale, value: number): number {
  const [a, b] = s.domain;
  const t =
    s.transform === "sqrt"
      ? (Math.sqrt(Math.max(value, 0)) - Math.sqrt(a)) / (Math.sqrt(b) - Math.sqrt(a))
      : (value - a) / (b - a);
  return Math.min(1, Math.max(0, t));
}

export function inverse(s: ColorScale, t: number): number {
  const [a, b] = s.domain;
  if (s.transform === "sqrt") {
    const r = Math.sqrt(a) + t * (Math.sqrt(b) - Math.sqrt(a));
    return r * r;
  }
  return a + t * (b - a);
}

export function colorAt(s: ColorScale, value: number): RGBA {
  const { stops } = s;
  const last = stops[stops.length - 1];
  const rgba = (st: ColorStop): RGBA => [...hex(st.color), Math.round(st.alpha * 255)];
  if (value <= stops[0].value) return rgba(stops[0]);
  if (value >= last.value) return rgba(last);
  const i = stops.findIndex((st) => st.value > value);
  const [p, q] = [stops[i - 1], stops[i]];
  const t = (value - p.value) / (q.value - p.value);
  const [pc, qc] = [rgba(p), rgba(q)];
  return pc.map((c, k) => Math.round(c + (qc[k] - c) * t)) as RGBA;
}

export function scaleBytes(s: ColorScale, n = 256): Uint8Array {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) out.set(colorAt(s, inverse(s, i / (n - 1))), i * 4);
  return out;
}
