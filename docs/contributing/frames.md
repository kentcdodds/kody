# Remix frames

Remix 3 `<Frame>` lets a page embed a server-rendered HTML fragment and reload
it without full navigation (`frame.reload()`). Kody routes frame fetches through
the same handler as the parent page so auth and user scoping stay consistent.

## Naming

- **`name`** (client): app-wide unique frame id passed to `<Frame name={...}>`.
  Register it once in `frame-registry.ts` via `registerFrame(name, ...)`.
  Duplicate names throw at module load.
- **`src`** (client): the page URL that serves the fragment. Always build with
  `routes.<routeKey>.href(...)` (the `kody-custom/no-literal-frame-src` lint
  rule enforces this).

## Registry and handlers

1. Add `packages/worker/src/app/frames/<name>.ts` calling `registerFrame` with
   `route: routes.<key>` (the route object) and a `render` function that returns
   fragment HTML (usually `renderToString` of a server component).
2. Import the module from `frame-registrations.ts`.
3. In the route handler, before `renderAppPage`:

```ts
const frameResponse = await handleFrameRequest(
	request,
	env,
	new URL(request.url).pathname,
)
if (frameResponse) return frameResponse
```

Passing the request pathname (rather than a fixed `href()`) lets the frame match
parameterized routes via `pathnameMatchesFrameRoute`.

`handleFrameRequest` checks `x-remix-target` (see `frame-constants.ts`), and
falls back to the `__frame` query param when a proxy kept the URL and dropped
the header. When that target matches a frame registered for the pathname, it
returns bare fragment HTML with `Cache-Control: no-store`. Otherwise it returns
`null` and the handler falls through to the full page.

Frame fetches must not reuse the cached document for `src`. Anonymous HTML is
cached by URL (browser, Worker `caches.default`, Cloudflare), and none of those
keys include `x-remix-target`. The client therefore fetches
`frameFetchUrl(src, target)`, which appends `__frame=<name>`, and both the
Worker cache and `resolveAppPageCacheControl` refuse to store or serve a
document for a request that carries the header or that param. Inserting a cached
`<!doctype html>` response into the frame redraws the shell, including the same
frame, so the page nests copies of itself.

SSR inlines frames via the same registry: `ssr-render.tsx` calls
`resolveRegisteredFrameHtml` inside `resolveFrame`. Unknown targets throw during
SSR (fail loud in dev).

## Target header contract

- Constant: `REMIX_FRAME_TARGET_HEADER` (`x-remix-target`) in
  `frame-constants.ts`.
- Client `entry.tsx` `resolveFrame(src, options)` sets the header to
  `options.target` (the frame `name`) when fetching `src`, and `frameFetchUrl`
  adds `__frame=<name>` so the request misses the document cache. Non-GET frame
  navigations forward `options.method` and `options.formData`. The resolver
  returns the `Response` so Remix can read redirects and the body. A named-frame
  body that starts with `<!doctype` or `<html` is rejected instead of rendered
  into that frame (a document would nest another shell). Document
  soft-navigations reload the top frame through the same resolver with no
  `target`; a full document is the page and is rendered.
- Server `handleFrameRequest` reads the header, then `__frame`, and selects the
  registered frame. The visible page URL is unchanged: `src` on `<Frame>` stays
  the route `href()`.

## Auth scoping

Frames that render user-scoped data must derive auth from the **same `Request`**
as the full page — use `loadResolvedRequestAuth`, `readAuthenticatedAppUser`, or
the same loader helpers the page handler uses. Never read user state from global
module variables.

## Client typed routes

Client code imports `routes` from `#universal/routes.ts`. The route table is
plain data from `remix/routes`; Vite resolves it via the root `package.json`
`imports` map.

Example (`client/routes/community.tsx`):

```tsx
<Frame name={COMMUNITY_LISTINGS_TARGET} src={frameSrc} />
```

Leave `fallback` off for this frame so SSR and client navigation wait for
listings before first paint. A loading fallback that reused the empty-state copy
flashed "no results" while the query finished.

`COMMUNITY_LISTINGS_TARGET` lives in `community-frame-constants.ts` alongside
the server-side `registerFrame` call in `frames/community-listings.ts`.

## Progressive enhancement

Ordinary same-origin clicks and submits stay on Kody's client router. Forms and
anchors that opt into Remix frame navigation use `data-rmx-target`,
`data-rmx-src`, or `data-rmx-document`. The client router leaves those alone so
Remix can reload a named frame (or force a full document submit) through
`resolveFrame`.

The community search form is the first opted-in surface: it is a GET form to
`routes.community` with `data-rmx-target={COMMUNITY_LISTINGS_TARGET}` and
`data-rmx-history="push"`. Login, billing, OAuth, and passkey forms stay on the
client router.
