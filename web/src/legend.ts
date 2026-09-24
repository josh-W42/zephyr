import { colorAt, inverse, normalize, type ColorScale } from "./colors";

export function drawLegend(
  canvas: HTMLCanvasElement,
  ticksEl: HTMLElement,
  scale: ColorScale | null,
  units = "",
  ticks: number[] = [],
) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ticksEl.replaceChildren();
  canvas.hidden = ticksEl.hidden = scale === null;
  if (!scale) return;
  for (let x = 0; x < canvas.width; x++) {
    const [r, g, b, a] = colorAt(scale, inverse(scale, x / (canvas.width - 1)));
    ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
    ctx.fillRect(x, 0, 1, canvas.height);
  }
  ticks.forEach((value, i) => {
    const t = normalize(scale, value);
    const span = document.createElement("span");
    span.textContent = i === ticks.length - 1 ? `${value} ${units}` : String(value);
    span.style.left = `${t * 100}%`;
    span.style.transform = `translateX(${t < 0.1 ? 0 : t > 0.9 ? -100 : -50}%)`;
    ticksEl.append(span);
  });
}
