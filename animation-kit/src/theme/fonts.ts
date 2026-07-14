/**
 * Font loading (side-effect module — import once from Root).
 * Excalifont is self-hosted (required for the whole hand-drawn look); Inter is
 * loaded from Google Fonts for the occasional clean-UI moment.
 */
import { loadFont as loadLocalFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// Hand-drawn primary — self-hosted, OFL-1.1. loadFont() internally blocks the
// render until the FontFace is ready, so text measures correctly.
loadLocalFont({
  family: "Excalifont",
  url: staticFile("fonts/Excalifont-Regular.woff2"),
  weight: "400",
  format: "woff2",
}).catch((err) => {
  // Non-fatal: falls back to the cursive stack in tokens.font.hand.
  // eslint-disable-next-line no-console
  console.error("Excalifont failed to load:", err);
});

// Clean UI font for rare non-hand-drawn moments. Best-effort; falls back to system-ui.
export const loadInterFont = async (): Promise<void> => {
  try {
    const mod = await import("@remotion/google-fonts/Inter");
    mod.loadFont("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Inter failed to load:", err);
  }
};
loadInterFont();
