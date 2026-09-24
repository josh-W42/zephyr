export function formatLonLat(lon: number, lat: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}

export function formatValue(value: number, units: string): string {
  if (units === "%") return `${Math.round(value)} %`;
  if (units === "mm/h" && value < 0.1) return `${value.toFixed(2)} mm/h`;
  return `${value.toFixed(1)} ${units}`;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** Meteorological convention: the direction the wind blows *from*. */
export function windFrom(u: number, v: number) {
  const degrees = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  return { speed: Math.hypot(u, v), degrees, compass: COMPASS[Math.round(degrees / 22.5) % 16] };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function formatValidTime(validTime: string, run: { cycle: string; fhour: number }): string {
  const t = new Date(validTime);
  const c = new Date(run.cycle);
  const when = `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC`;
  return `Valid ${when} · GFS ${pad(c.getUTCHours())}z +${run.fhour} h`;
}
