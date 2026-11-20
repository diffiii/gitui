// Color palettes. Each one recolors the UI (src/palettes.css, keyed by `data-palette`) and picks
// matching Shiki themes for diffs, in a light and a dark variant.

export interface Palette {
  label: string;
  /** Shiki themes for diffs (@pierre/diffs). */
  diffs: { light: string; dark: string };
}

/** In menu order; the first is the default. */
export const PALETTES = {
  neutral: { label: "Neutral", diffs: { light: "pierre-light", dark: "pierre-dark" } },
  github: {
    label: "GitHub",
    diffs: { light: "github-light-default", dark: "github-dark-default" },
  },
  catppuccin: {
    label: "Catppuccin",
    diffs: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  },
  "rose-pine": { label: "Rosé Pine", diffs: { light: "rose-pine-dawn", dark: "rose-pine" } },
  gruvbox: {
    label: "Gruvbox",
    diffs: { light: "gruvbox-light-medium", dark: "gruvbox-dark-medium" },
  },
} as const satisfies Record<string, Palette>;

export type PaletteId = keyof typeof PALETTES;
export const PALETTE_IDS = Object.keys(PALETTES) as PaletteId[];
