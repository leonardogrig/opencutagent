/**
 * n8n style theme: the engine tokens re-skinned with n8n's brand palette
 * (ported from the n8motion project; values verified against n8n's brand
 * guidelines). Import `n8n` INSTEAD of the engine `tokens` in n8n-style scenes
 * so every color lands on-brand; fonts/sizes/spacing/rough defaults are
 * inherited from the engine unchanged.
 */
import { tokens } from "../../../src/theme/tokens";

export const n8n = {
  ...tokens,
  color: {
    ...tokens.color,

    // — canvas —
    bg: "#131313", // n8n near-black canvas
    bgBrand: "#0E0918", // optional n8n marketing purple-black
    surface: "#2B2B2B", // node card
    surfaceAlt: "#323232",
    inkOnLight: "#040506", // brand black (strokes on light surfaces)

    // — accent (n8n PRIMARY) —
    accent: "#EA4B71", // n8n official Primary Pink: the subject/highlight color
    brandPink: "#EA4B71", // alias of accent
    coral: "#ff7375", // softer coral, available but NOT the default accent
    accentDeep: "#F85D82", // n8n node-icon pink-red (dark)
    coralLegacy: "#FF6F5C", // n8n product legacy primary

    // — support (color-coding; n8n product palette) —
    orange: "#FF6900",
    purple: "#7F22FE",
    purpleSoft: "#A684FF",
    green: "#00C950",
    red: "#E7000B",
    blue: "#2B7FFF",

    // — component-specific —
    activeGreen: "#2FD08A", // "node executed" sketch border
    portStroke: "#5a5a5a", // node connector handle ring
    chatGreeting: "#D9D7CF",
    chatPlaceholder: "#7c7c80",
    chatThinking: "#b9b9bd",
    gridLight: "#3a3a3a",

    // — "other tool" light theme (comparison foil) —
    foilBg: "#ECEAE0",
    foilGrid: "#CFCCBE",
    foilSurface: "#FFFFFF",
    foilStroke: "#8A8A8A",
    foilText: "#1B2A4A",
  },

  /** Official n8n gradients — rare accents only, never for body content. */
  gradient: {
    hero: "linear-gradient(89.98deg, #FFB552 29.9%, #FF5873 71.24%, #B83DFF 96.05%)",
    ai: "linear-gradient(105deg, #5B60E8 0%, #AA7BEC 50%, #EC7B8E 100%)",
    cta: "linear-gradient(90deg, #FF9B26 29.28%, #EE4F27 67.8%)",
  },
} as const;

export type N8nTheme = typeof n8n;
