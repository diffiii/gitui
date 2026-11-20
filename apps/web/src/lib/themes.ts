// Color themes. Each one recolors the UI (src/themes.css, keyed by `data-palette` on <html>) and
// picks a matching syntax theme for diffs, in a light and a dark variant.

export interface Palette {
  id: string;
  label: string;
  /** Shiki themes for diffs (@pierre/diffs). */
  diffs: { light: string; dark: string };
  /** Accent color shown in the theme picker, per mode. */
  swatch: { light: string; dark: string };
}

export const PALETTES = [
  {
    id: "neutral",
    label: "Neutral",
    diffs: { light: "pierre-light", dark: "pierre-dark" },
    swatch: { light: "#262626", dark: "#e5e5e5" },
  },
  {
    id: "github",
    label: "GitHub",
    diffs: { light: "github-light-default", dark: "github-dark-default" },
    swatch: { light: "#0969da", dark: "#4493f8" },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    diffs: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
    swatch: { light: "#8839ef", dark: "#cba6f7" },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    diffs: { light: "rose-pine-dawn", dark: "rose-pine" },
    swatch: { light: "#907aa9", dark: "#c4a7e7" },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    diffs: { light: "gruvbox-light-medium", dark: "gruvbox-dark-medium" },
    swatch: { light: "#af3a03", dark: "#fe8019" },
  },
] as const satisfies readonly Palette[];

export type PaletteId = (typeof PALETTES)[number]["id"];

/** The palette with this id; the default one for an unknown id (e.g. a stale saved value). */
export const findPalette = (id: string): Palette =>
  PALETTES.find((p) => p.id === id) ?? PALETTES[0];
