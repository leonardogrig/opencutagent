/**
 * Font loading (side-effect module — import once from Root).
 *
 * Both faces are INLINED as data: URIs (src/theme/fontdata, regenerate with
 * `node scripts/inline-fonts.mjs`) rather than fetched. A font REQUEST is the
 * most common way a long render dies: @remotion/fonts' loadFont() blocks the
 * frame with a delayRender() it never times out itself, so a request that
 * stalls — a recycled browser tab, Remotion's static server under six
 * concurrent 4K tabs, an offline machine reaching fonts.gstatic.com — trips the
 * global frame timeout and kills the whole render. Seen live: "Loading font
 * Excalifont ... not cleared after 118000ms" at frame 3270 of 5990. A data: URI
 * cannot stall.
 *
 * The loader below is hand-rolled for the same reason: it retries, it asks
 * Remotion to retry the FRAME if the handle ever times out, and it ALWAYS
 * releases the handle. One frame in a fallback typeface beats a dead render.
 */
import { continueRender, delayRender } from "remotion";
import { EXCALIFONT_WOFF2 } from "./fontdata/excalifont";
import { INTER_WOFF2 } from "./fontdata/inter";

/** Per-attempt clock. Must stay well under Remotion's frame timeout. */
const ATTEMPT_TIMEOUT_MS = 10000;
const ATTEMPTS = 3;
/** If the handle times out anyway, Remotion re-renders the frame in a fresh page. */
const FRAME_RETRIES = 2;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

type LocalFont = {
  family: string;
  src: string;
  weight?: string;
  format?: string;
};

/** Exported so style packages can load their own inlined faces the same safe way. */
export async function loadInlineFont({ family, src, weight, format = "woff2" }: LocalFont): Promise<void> {
  const handle = delayRender(`Loading font ${family}`, {
    timeoutInMilliseconds: ATTEMPT_TIMEOUT_MS * ATTEMPTS + 15000,
    retries: FRAME_RETRIES,
  });
  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const face = new FontFace(family, `url('${src}') format('${format}')`, { weight });
        await withTimeout(face.load(), ATTEMPT_TIMEOUT_MS, `Loading ${family}`);
        document.fonts.add(face);
        return;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`${family} load attempt ${attempt}/${ATTEMPTS} failed:`, err);
      }
    }
    // eslint-disable-next-line no-console
    console.error(`${family} could not be loaded; rendering with the fallback stack.`);
  } finally {
    // NEVER cancelRender here: a fallback typeface beats a dead render.
    continueRender(handle);
  }
}

// Hand-drawn primary — required for the whole look. Falls back to the cursive
// stack in tokens.font.hand if it somehow cannot be loaded.
loadInlineFont({ family: "Excalifont", src: EXCALIFONT_WOFF2, weight: "400" });

// Clean UI face for the rare non-hand-drawn moment (tokens.font.ui).
// Variable font: one file covers the weights the components ask for.
loadInlineFont({ family: "Inter", src: INTER_WOFF2, weight: "100 900" });
