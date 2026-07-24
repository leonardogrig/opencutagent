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

## Custom styles (user-made)

Drop a package folder into the runtime workspace's `styles/` directory
(`~/.opencutagent/animation-kit/styles/<id>/` by default) and it appears in the panel next to
the shipped styles. Kit updates never touch folders they didn't ship. A shipped style with the
same id wins over a workspace copy.

## Shipped styles

- `excalidraw/` — hand-drawn dark whiteboard, violet accent (the default). Skill-only package:
  it styles the shared engine components directly.
- `n8n/` — the same hand-drawn engine in n8n's brand: pink `#EA4B71` accent, sketchy square
  workflow nodes + connectors with data pulses, the AI-builder chat. Ships components under
  `src/`. Note: the n8n name, logo geometry (`n8nLogoPaths.ts`), and brand palette belong to
  n8n; the agent only renders the logo when explicitly asked.
