export interface KeyMove {
  dLon: number; // degrees the view centre moves east
  dLat: number; // degrees the view centre moves north
  zoom: number; // camera distance multiplier
}

const ZOOM_IN = 0.85;

/** Keyboard globe control: arrows move the view centre (Shift for bigger steps), +/- zoom. */
export function keyMove(key: string, shift: boolean): KeyMove | null {
  const step = shift ? 15 : 5;
  switch (key) {
    case "ArrowRight":
      return { dLon: step, dLat: 0, zoom: 1 };
    case "ArrowLeft":
      return { dLon: -step, dLat: 0, zoom: 1 };
    case "ArrowUp":
      return { dLon: 0, dLat: step, zoom: 1 };
    case "ArrowDown":
      return { dLon: 0, dLat: -step, zoom: 1 };
    case "+":
    case "=":
      return { dLon: 0, dLat: 0, zoom: ZOOM_IN };
    case "-":
      return { dLon: 0, dLat: 0, zoom: 1 / ZOOM_IN };
    default:
      return null;
  }
}
