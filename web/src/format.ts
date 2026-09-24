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
