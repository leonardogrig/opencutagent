import React from "react";

/**
 * Maps a list to staggered delays. The render callback receives (item, delay,
 * index) so children can offset their own animation by `delay`.
 *
 * <Stagger items={rows} each={4} delay={10}>
 *   {(row, d) => <RiseIn delay={d}>{row}</RiseIn>}
 * </Stagger>
 */
export function Stagger<T>({
  items,
  each = 4,
  delay = 0,
  children,
}: {
  items: T[];
  each?: number;
  delay?: number;
  children: (item: T, delay: number, index: number) => React.ReactNode;
}): React.ReactElement {
  return (
    <>
      {items.map((item, i) => (
        <React.Fragment key={i}>{children(item, delay + i * each, i)}</React.Fragment>
      ))}
    </>
  );
}
