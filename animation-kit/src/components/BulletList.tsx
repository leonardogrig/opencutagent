import React from "react";
import { SketchCircle } from "../sketch";
import { WordReveal } from "../animation";
import { tokens } from "../theme/tokens";
import { SEEDS } from "../theme/seeds";

/** A staggered list where each row has a hand-drawn bullet + word-revealed text. */
export const BulletList: React.FC<{
  items: string[];
  delay?: number;
  each?: number;
  size?: number;
  color?: string;
  accent?: string;
  gap?: number;
  style?: React.CSSProperties;
}> = ({
  items,
  delay = 0,
  each = 12,
  size = tokens.fontSize.body,
  color = tokens.color.ink,
  accent = tokens.color.accent,
  gap = 28,
  style,
}) => (
  <div style={{ display: "flex", flexDirection: "column", gap, ...style }}>
    {items.map((it, i) => {
      const d = delay + i * each;
      return (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            style={{ overflow: "visible", flexShrink: 0 }}
          >
            <SketchCircle
              cx={size / 2}
              cy={size / 2}
              r={size * 0.3}
              seed={SEEDS.bullet + i}
              stroke={accent}
              strokeWidth={tokens.stroke.thin}
              drawIn={{ delay: d, duration: 12 }}
            />
          </svg>
          <span style={{ fontFamily: tokens.font.hand, fontSize: size, color }}>
            <WordReveal text={it} delay={d + 4} />
          </span>
        </div>
      );
    })}
  </div>
);
