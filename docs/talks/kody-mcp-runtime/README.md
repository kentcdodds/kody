# Kody as MCP personal runtime

Slidev deck for a talk about **what Kody proves about MCP**: capability
discovery, deterministic composition, secrets/UI, and reusable artifacts—not
model inference.

## Thesis

**MCP becomes valuable when it becomes your environment.** Kody exposes a small
tool surface (`search`, `execute`, `open_generated_ui`) that lets an agent
discover capabilities, run real work in a sandbox, and surface dashboards or
forms when secrets and approvals matter.

## Primary story (Kent-specific)

Center the narrative on **Cursor Cloud Agents + GitHub PR observability**:

- A **saved generated UI** (Cursor Agent PR Dashboard) that polls Cursor and
  GitHub with secret-backed fetches.
- **Saved skills** that wrap the same APIs for scripted checks: open PRs from
  agents, agent status overview, follow-up on an agent.

That stack is “personal infrastructure”: not a one-off chat, but software you
reopen and reuse.

## Demo mix

| Kind                                  | What                                          | Notes                                                                                                                  |
| ------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Live (public-safe)**                | `search` → `execute`                          | e.g. `meta_list_capabilities` or a read-only capability that needs no secrets. Shows the loop without exposing tokens. |
| **Screenshot / recording**            | Cursor PR dashboard                           | Drop PNGs or a short clip under `public/demo/` and reference them from slides (see placeholders in `slides.md`).       |
| **Screenshot / recording** (optional) | Tesla Energy Live or other private dashboards | Same folder; blur or crop if needed.                                                                                   |

## Run locally

From the repository root (after `npm install`):

```bash
npm run dev:talks
```

Or from this package:

```bash
npm run dev
```

Build static output:

```bash
npm run build
```

## Look and feel

- **Colors:** `themeConfig.primary` in `slides.md` drives links, markers, and
  accents. `uno.config.ts` replaces flat `bg-main` with a light teal/cyan
  gradient (and a deep green-tinted gradient in dark mode). `style.css` adds
  heading, list, table, and blockquote tinting from `--slidev-theme-primary`.
- **Light / dark:** `colorSchema: auto` follows `prefers-color-scheme`. Use
  Slidev’s built-in theme control or press **`d`**; after that, Slidev stores a
  preference in `localStorage` under `slidev-color-schema` (`auto` / `light` /
  `dark`). To force a single mode only, set `colorSchema` to `light` or `dark`
  in headmatter.
- **Slide change:** `defaults.transition: slide-left` uses Slidev’s built-in
  horizontal slide: **forward** uses `slide-left`, **backward** uses
  `slide-right` (see [animations](https://sli.dev/guide/animations.html)).
  Timing and easing come from `--slidev-transition-duration` and
  `--slidev-slide-easing` in `style.css`. For a cross-fade, use `fade` or
  `fade-out` instead.
- **Deck CSS:** `style.css` is global (accent colors and transition duration).

## Assets

`public/demo/cursor-pr-dashboard.png` is a **tiny placeholder** so
`slidev build` resolves the image path. Replace it with a real screenshot before
you present. Optionally add `tesla-energy.png` and reference it from a new
slide.
