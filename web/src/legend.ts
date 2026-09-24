import { colorAt, inverse, type ColorScale } from "./colors";
import { formatValue } from "./format";

export function drawLegend(canvas: HTMLCanvasElement, ticks: HTMLElement, scale: ColorScale | null, units = "") {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ticks.replaceChildren();
  canvas.hidden = ticks.hidden = scale === null;
  if (!scale) return;
  for (let x = 0; x < canvas.width; x++) {
    const [r, g, b, a] = colorAt(scale, inverse(scale, x / (canvas.width - 1)));
    ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
    ctx.fillRect(x, 0, 1, canvas.height);
  }
  for (const t of [0, 0.5, 1]) {
    const span = document.createElement("span");
    span.textContent = formatValue(inverse(scale, t), units);
    ticks.append(span);
  }
}
