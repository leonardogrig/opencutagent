import React from "react";
import { n8n } from "./theme";
import { N8N_LOGO_VIEWBOX, N8N_MARK_PATH, N8N_TEXT_PATHS } from "./n8nLogoPaths";

type Variant = "brand" | "white" | "coral" | "mono";

const PRESETS: Record<Variant, { mark: string; text: string }> = {
  brand: { mark: n8n.color.brandPink, text: n8n.color.inkWhite }, // official dark-bg lockup
  white: { mark: n8n.color.inkWhite, text: n8n.color.inkWhite },
  coral: { mark: n8n.color.accent, text: n8n.color.inkWhite },
  mono: { mark: n8n.color.ink, text: n8n.color.ink },
};

/**
 * The official n8n logo (viewBox 296x80), recolorable. `brand` = the true
 * dark-bg lockup (pink mark + white wordmark). Respect clear-space >= 4x and
 * min width ~100px per the brand guidelines. Use ONLY when the user explicitly
 * asks for the logo — the style's default is NO logo/watermark.
 */
export const N8nLogo: React.FC<{
  width?: number;
  variant?: Variant;
  markColor?: string;
  textColor?: string;
  opacity?: number;
  /** Render only the connected-nodes mark (no wordmark). */
  markOnly?: boolean;
  style?: React.CSSProperties;
}> = ({ width = 240, variant = "brand", markColor, textColor, opacity = 1, markOnly = false, style }) => {
  const preset = PRESETS[variant];
  const mc = markColor ?? preset.mark;
  const tc = textColor ?? preset.text;
  const aspect = markOnly ? 152 / 80 : 296 / 80;
  const height = width / aspect;
  return (
    <svg
      width={width}
      height={height}
      viewBox={markOnly ? "0 0 152 80" : N8N_LOGO_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ opacity, ...style }}
    >
      <path d={N8N_MARK_PATH} fill={mc} fillRule="evenodd" clipRule="evenodd" />
      {!markOnly
        ? N8N_TEXT_PATHS.map((d, i) => (
            <path key={i} d={d} fill={tc} fillRule="evenodd" clipRule="evenodd" />
          ))
        : null}
    </svg>
  );
};
