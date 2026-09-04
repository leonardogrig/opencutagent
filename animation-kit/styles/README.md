# Animation styles — self-contained packages

A **style** is everything that defines one visual language for the animation agent: a design
guide it follows, plus (optionally) components and a theme built for that look. Each style is
ONE folder in here — adding a style = dropping a folder in, removing it = deleting the folder.
Nothing else registers it: the server discovers styles by scanning this directory, and the
panel's Style dropdown mirrors that list.

## Package layout

```
styles/<id>/
  style.json    REQUIRED  identity: { "id", "name", "description", "default"? }
  SKILL.md      REQUIRED  the agent's design guide + a "Learnings log" section it appends to
  src/          optional  style-specific React components / theme (TypeScript, compiled with
                          the kit; import the engine via ../../../src/...)
```

- `style.json` — `id` must equal the folder name; `name`/`description` feed the panel dropdown;
  at most one style ships `"default": true`.
- `SKILL.md` — injected into the agent's system prompt on every chat turn, so keep it focused:
  the aesthetic, the non-negotiables, the components to use, look-and-feel defaults. End with a
  **Learnings log** section: the agent appends user-taught rules there, and the runtime workspace
  copy of this file is NEVER overwritten by kit updates (the log survives).
- `src/` — export everything from `src/index.ts`. Job scenes import it as
  `../../../styles/<id>/src`. Build on the shared engine (`src/sketch`, `src/theme`,
  `src/animation`, `src/components`) instead of duplicating it; a theme overlay that spreads the
  engine `tokens` and overrides colors (see `n8n/src/theme.ts`) keeps the package tiny. Style
  code is type-checked with the kit (`npm run typecheck`), so a style must compile.

Keep packages code-only: no npm dependencies of their own (the kit's package.json is shared) and
no static assets that need `public/` — inline SVG paths instead (see `n8n/src/n8nLogoPaths.ts`).
A style may ship its own fonts, but only INLINED as data: URIs in `src/fontdata/*.ts` (add the
`.woff2` under `styles/<id>/fonts/` and an entry to `scripts/inline-fonts.mjs`), loaded through
the engine's `loadInlineFont` — a render must never make a font request.

## Custom styles (user-made)

Drop a package folder into the runtime workspace's `styles/` directory
(`~/.opencutagent/animation-kit/styles/<id>/` by default) and it appears in the panel next to
the shipped styles. Kit updates never touch folders they didn't ship. A shipped style with the
same id wins over a workspace copy.

## Shipped styles

- `excalidraw/` — hand-drawn dark whiteboard, violet accent (the default). Skill-only package:
  it styles the shared engine components directly.
- `n8n/` ("n8n sketch") — the same hand-drawn engine in n8n's older brand look: pink `#EA4B71`
  accent, sketchy square workflow nodes + connectors with data pulses, the AI-builder chat. Ships
  components under `src/`. Note: the n8n name, logo geometry (`n8nLogoPaths.ts`), and brand
  palette belong to n8n; the agent only renders the logo when explicitly asked.
- `n8n-brand/` — n8n's 2026 brand system, crisp and NOT hand-drawn: one signature pink
  (`#FF91AC`) with the full pink/grey ramps, five graphic modes (Neutral light/dark, Maker, Pink
  light/dark) resolved through a `BrandCanvas` context, grotesk headlines + mono capsule labels
  (EK Baumer is named first in the font stacks; the bundled OFL stand-ins Inter Tight + Geist Mono
  are inlined under `src/fontdata/`, regenerated from `fonts/*.woff2` by
  `node scripts/inline-fonts.mjs`), the product dot grid, capsules (chain/stack), emboss plates,
  cards, pixel glyphs, the pink-wash transition and a reconstructed `+++` mark (logo only when
  asked). The whole system lives in `src/theme.ts`; components never hardcode a value.
  `examples/Showcase.tsx` exercises every component (four pages, 1920x1080, 360 frames): copy it
  into a job folder to see the style, or use it as the QA scene after changing a component.
- `leo/` ("Leo (pixel presenter)") — a 16-bit pixel-art likeness of the creator (square jaw,
  black curls, thin wide frames, stubble, black tee; a `hair="cap"` variant) who talks along with
  the narration. NOT hand-drawn. The 56x64 sprite is authored as a char grid in `src/sprite.ts`
  (one letter per pixel, `src/palette.ts` is the only place a colour lives) and rendered as
  merged SVG rects at an integer scale, so it is crisp at any canvas size with zero assets.
  Lip sync is word-timed (`src/lipsync.ts`: a viseme per syllable from its vowel, landed on each
  word's onset; the server writes every job's `words.json` for it), idle life is seeded
  (`src/motion.ts`: blinks, breath, talking bob, glances). Components: `Leo`, `LeoCorner` (stream
  cam placement, the default), `PixelPanel`. Personal to the user; not a general-purpose style.
- `n8n-ui/` ("n8n interface") — the REAL n8n app (v2.35.7 dark theme) recreated pixel-exact for
  tutorials, NOT hand-drawn: sidebar, Overview, workflow editor chrome, canvas nodes/edges with
  real integration logos and n8n's own node glyphs, node picker, node details view, executions,
  AI Assistant, data tables, plus a macOS cursor with click rings. Measured from the live app's
  DOM and resolved design tokens at 125% zoom: the app is laid out in a 1536x864 CSS-px `UiFrame`
  auto-scaled to the job canvas. Icons (69 logos, 80 node glyphs, 360+ UI glyphs) are inlined
  as data/SVG in `src/iconfiles.ts` + `src/iconData.ts`; the node catalogue (~125 types) lives in
  `src/nodeCatalog.ts`. `examples/Showcase.tsx` is a complete tutorial beat (Overview -> build a
  workflow -> execute). The user attaches a workflow screenshot and the agent rebuilds it node
  for node. Note: the n8n name, logo and the integration logos belong to their owners; this
  style exists for the user's n8n channel tutorials.
