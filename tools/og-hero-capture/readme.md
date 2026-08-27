# OG hero capture (agents orbit)

Rebuild `packages/worker/public/og/kody-hero.png` from the live agents
composition without the fragile “key the light-gray marketing PNG” path.

## Why

`kody-base.webp` deliberately leaves white shirt / shoe / eye areas transparent
so the page background shows through. Keying a pre-composited light-gray PNG
punched holes in those areas and ate chip borders / shadows. Capturing the UI
on a chroma screen after flattening designed transparency is more reliable.

## Steps

1. Serve this folder together with `packages/worker/public` (icons + paths), or
   open `index.html` via a static server that can resolve the icon URLs.
2. Screenshot `#stage` at 2× (Playwright / Chrome).
3. Chroma-key `#ff00ff` (magenta) with a soft fringe + despeckle.
4. Crop to content, pad square, resize to 520×520, write
   `packages/worker/public/og/kody-hero.png`.

`kody-base-og-flat.png` is `kody-base` with interior transparent “white”
cutouts filled white so dark OG cards stay opaque.
