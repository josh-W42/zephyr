import type { ColorScale } from "./colors";
import type { ScalarName } from "./manifest";

// Fixed domains so a color means the same thing every day. Temperature stops
// are densest in 15-32 C, where most of the planet's area sits.
export const SCALAR_LAYERS: Record<ScalarName, { label: string; scale: ColorScale; ticks: number[] }> = {
  temperature: {
    label: "Temperature",
    ticks: [-40, -20, 0, 20, 40],
    scale: {
      domain: [-40, 45],
      transform: "linear",
      stops: [
        { value: -40, color: "#3b1a63", alpha: 0.85 },
        { value: -25, color: "#5b3fbf", alpha: 0.85 },
        { value: -10, color: "#2f6fd6", alpha: 0.85 },
        { value: 0, color: "#4fc3e8", alpha: 0.85 },
        { value: 8, color: "#3fae9a", alpha: 0.85 },
        { value: 15, color: "#6dbf5a", alpha: 0.85 },
        { value: 20, color: "#c3d64f", alpha: 0.85 },
        { value: 24, color: "#f3d34a", alpha: 0.85 },
        { value: 28, color: "#f59a36", alpha: 0.85 },
        { value: 32, color: "#e0472f", alpha: 0.85 },
        { value: 38, color: "#b01f4a", alpha: 0.85 },
        { value: 45, color: "#6a0d3a", alpha: 0.85 },
      ],
    },
  },
  precipitation: {
    label: "Precipitation",
    ticks: [0, 1, 5, 20, 50],
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
    ticks: [0, 50, 100],
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
