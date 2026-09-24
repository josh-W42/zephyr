import type { ColorScale } from "./colors";
import type { ScalarName } from "./manifest";

// Fixed domains so a color means the same thing every day.
export const SCALAR_LAYERS: Record<ScalarName, { label: string; scale: ColorScale }> = {
  temperature: {
    label: "Temperature",
    scale: {
      domain: [-40, 45],
      transform: "linear",
      stops: [
        { value: -40, color: "#2a1a5e", alpha: 0.85 },
        { value: -20, color: "#3d5bb8", alpha: 0.85 },
        { value: -5, color: "#7db5e3", alpha: 0.85 },
        { value: 0, color: "#e6f0f0", alpha: 0.85 },
        { value: 10, color: "#f5d67a", alpha: 0.85 },
        { value: 25, color: "#ee8a3c", alpha: 0.85 },
        { value: 35, color: "#c8302c", alpha: 0.85 },
        { value: 45, color: "#6b0f2b", alpha: 0.85 },
      ],
    },
  },
  precipitation: {
    label: "Precipitation",
    scale: {
      domain: [0, 50],
      transform: "sqrt",
      stops: [
        { value: 0, color: "#7fd3ff", alpha: 0 },
        { value: 0.1, color: "#7fd3ff", alpha: 0.35 },
        { value: 1, color: "#3aa0ff", alpha: 0.7 },
        { value: 5, color: "#2f5bff", alpha: 0.85 },
        { value: 15, color: "#a23cff", alpha: 0.9 },
        { value: 50, color: "#ff3ce0", alpha: 0.95 },
      ],
    },
  },
  clouds: {
    label: "Cloud cover",
    scale: {
      domain: [0, 100],
      transform: "linear",
      stops: [
        { value: 0, color: "#ffffff", alpha: 0 },
        { value: 20, color: "#ffffff", alpha: 0 },
        { value: 100, color: "#ffffff", alpha: 0.8 },
      ],
    },
  },
};
