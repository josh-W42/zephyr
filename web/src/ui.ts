import type { ScalarName } from "./manifest";
import { SCALAR_LAYERS } from "./scales";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
type Choice = ScalarName | "none";

// DOM wiring only; all text goes through textContent, never innerHTML.
export class Panel {
  onLayer: (name: ScalarName | null) => void = () => {};
  onWind: (on: boolean) => void = () => {};
  private readonly wind = $<HTMLInputElement>("#wind-toggle");

  constructor(initial: ScalarName) {
    const fieldset = $("#layers");
    const choices: [Choice, string][] = [
      ...(Object.keys(SCALAR_LAYERS) as ScalarName[]).map((k): [Choice, string] => [k, SCALAR_LAYERS[k].label]),
      ["none", "None"],
    ];
    for (const [value, label] of choices) {
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "layer";
      input.value = value;
      input.checked = value === initial;
      input.addEventListener("change", () => this.onLayer(value === "none" ? null : value));
      const wrap = document.createElement("label");
      wrap.append(input, document.createTextNode(label));
      fieldset.append(wrap);
    }
    this.wind.addEventListener("change", () => this.onWind(this.wind.checked));

    const panel = $("#panel");
    const menu = $<HTMLButtonElement>("#menu");
    const setCollapsed = (collapsed: boolean) => {
      panel.dataset.collapsed = String(collapsed);
      menu.setAttribute("aria-expanded", String(!collapsed));
    };
    setCollapsed(matchMedia("(max-width: 700px)").matches);
    menu.addEventListener("click", () => setCollapsed(panel.dataset.collapsed !== "true"));
  }

  setWind(available: boolean, on: boolean) {
    this.wind.disabled = !available;
    this.wind.checked = available && on;
  }

  setValidTime(text: string) {
    $("#valid").textContent = text;
  }

  setReadout(text: string) {
    $("#readout").textContent = text;
  }

  setBanner(text: string | null) {
    const b = $("#banner");
    b.hidden = text === null;
    b.textContent = text ?? "";
  }

  notice(text: string) {
    const n = $("#notice");
    n.hidden = false;
    n.textContent = text;
  }

  setBusy(busy: boolean) {
    $("#layers").setAttribute("aria-busy", String(busy));
  }
}
