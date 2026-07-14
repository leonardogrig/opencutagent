/**
 * OpenCutAgent animation kit — design tokens for the "Excalidraw (dark)" style.
 * THE single source of style truth. No literal hex/font should appear anywhere
 * else in the codebase — always import from here.
 *
 * Palette: Excalidraw's dark theme (near-black canvas, light ink, Open Color
 * stroke hues, the Excalidraw violet as the accent) rendered with Excalifont.
 */
export const tokens = {
  color: {
    // — canvas —
    bg: "#121212", // Excalidraw dark canvas
    dotGrid: "#2b2b2b", // subtle dot-grid dots
    surface: "#26262c", // card / island surface
    surfaceAlt: "#31313a",

    // — ink (neutral hand-drawn strokes) —
    ink: "#cdcdcd", // DEFAULT stroke
    inkWhite: "#FFFFFF",
    inkMuted: "#999999",
    inkFaint: "#686868",
    inkOnLight: "#1e1e1e", // strokes on light surfaces (sticky notes)

    // — accent (highlight / subject) —
    accent: "#a8a5ff", // Excalidraw violet (dark-theme variant)
    accentDeep: "#6965db", // Excalidraw violet (saturated)

    // — support (color-coding; Excalidraw's dark-mode stroke hues) —
    red: "#ff8787",
    orange: "#ffa94d",
    yellow: "#ffd43b",
    green: "#69db7c",
    blue: "#4dabf7",
    purple: "#da77f2",
    purpleSoft: "#eebefa",

    // — component-specific —
    stickyBg: "#FEF9C2",
    stickyBorder: "#FFF085",
    stickyText: "#733E0A",
    videoMatte: "#000000", // letterbox behind embedded media
  },

  font: {
    // Excalifont = self-hosted (public/fonts). Inter loaded via @remotion/google-fonts.
    hand: "'Excalifont', 'Comic Sans MS', 'Segoe Print', cursive",
    ui: "'Inter', system-ui, -apple-system, sans-serif",
    mono: "ui-monospace, Menlo, Consolas, monospace",
  },
  weight: { regular: 400, medium: 500, bold: 600 },

  /** Type scale authored for 1920×1080. Scale linearly with composition width. */
  fontSize: {
    display: 140,
    h1: 104,
    h2: 72,
    h3: 52,
    body: 40,
    label: 46,
    caption: 30,
  },

  radius: { sm: 6, md: 8, lg: 12, xl: 16, xxl: 24, pill: 9999 },
  space: { xs: 8, sm: 16, md: 24, lg: 48, xl: 96, xxl: 160 },
  /** rough.js strokeWidth tiers (px @ 1080p+). */
  stroke: { hair: 2, thin: 3, base: 4, bold: 6, heavy: 8 },
  shadow: {
    card: "0 10px 15px -3px rgba(0,0,0,.35)",
    glow: (c: string) => `drop-shadow(0 0 18px ${c}66)`,
  },

  /** rough.js option defaults — clean-but-sketchy on dark canvas. */
  rough: {
    roughness: 1.3,
    bowing: 1,
    strokeWidth: 4,
    fillStyle: "hachure" as const,
    fillWeight: 2.5,
    hachureGap: 8,
    curveStepCount: 9,
    preserveVertices: true,
  },

  /** Keep key content ≥ this fraction from every edge. */
  safeMarginPct: 0.075,
} as const;

export type Tokens = typeof tokens;
export type ColorToken = keyof Tokens["color"];

/** Resolve a color token name OR a raw hex string to a hex string. */
export const resolveColor = (c: string): string =>
  (tokens.color as Record<string, string>)[c] ?? c;
