# 0049: Do not move the origin website to Pitlane Vite

- **Status:** accepted
- **Date:** 2026-09-04

## Context

[Pitlane's Cloudflare deploy guide](https://pitlane.tools/deploy/cloudflare)
composes `@pitlane/dev`'s `remix()` Vite plugin with `@cloudflare/vite-plugin`
so `vite dev` runs SSR inside workerd, `vite build` emits `dist/client` +
`dist/ssr`, and `wrangler deploy` ships that shape. The prompt to adopt it is
agent friction on `npm run dev` (esbuild watcher + wrangler reload loops).

Kody's origin website is not that template. SSR lives in the origin Worker
(`origin-handler.ts` → Remix `renderToStream`), the browser bundle is a separate
esbuild write into `packages/worker/public/` (`/client-entry.js` plus hashed
`*-area-*.js` chunks), and local/production fleets are four scripts orchestrated
by `wrangler-env.ts`. Hydration is a hardcoded `/client-entry.js#AppRoot`
registry, not Pitlane's `clientEntry(import.meta.url, …)` transform.
`@pitlane/dev@0.6` peers `remix@^3.0.0-rc.1`; this repo is on
`remix@3.0.0-beta.10`.

## Decision

Do not adopt Pitlane Vite (`@pitlane/dev` + `@cloudflare/vite-plugin`) as the
origin website's build or local-dev authority. Keep the esbuild client pipeline
and `wrangler-env.ts` multi-worker `wrangler dev`. A client-only esbuild→Vite
swap that still writes `packages/worker/public/` is the same no unless the
revisit conditions below are met — it would not fix the local-server friction.

## Consequences

Agent local-dev pain stays a Wrangler problem (overlay-FS watch loops, assets
races, generated-module watches, `X_LOCAL_EXPLORER`, multi-config Miniflare),
not a website-bundler problem. Production client output, Sentry maps, and the
preload manifest stay on the existing esbuild metafile contract.

**Revisit-if** all of these are true: Remix is already on an `@pitlane/dev`
supported prerelease for another reason; `wrangler-env.ts` (generated
platform/runtime configs, Cloudflare API mock, persist paths,
`CLOUDFLARE_ENV=test` watch disables) can be expressed as Vite
`auxiliaryWorkers` without losing those behaviors; and we are ready to rewrite
hydration, area-chunk naming, and `client-manifest.json` off the
`/client-entry.js` contract. Until then, fix Wrangler/dev orchestration — do not
cut the website over.
