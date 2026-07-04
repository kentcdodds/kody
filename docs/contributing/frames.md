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
   `routePathname: routes.<key>.href()` and a `render` function that returns
   fragment HTML (usually `renderToString` of a server component).
2. Import the module from `frame-registrations.ts`.
3. In the route handler, before `renderAppPage`:

```ts
const frameResponse = await handleFrameRequest(request, env, routes.foo.href())
if (frameResponse) return frameResponse
```

`handleFrameRequest` checks `x-remix-target` (see `frame-constants.ts`). When
the header matches a frame registered for that pathname, it returns bare
fragment HTML with `Cache-Control: no-store`. Otherwise it returns `null` and
the handler falls through to the full page.

SSR inlines frames via the same registry: `ssr-render.tsx` calls
`resolveRegisteredFrameHtml` inside `resolveFrame`. Unknown targets throw during
SSR (fail loud in dev).

## Target header contract

- Constant: `REMIX_FRAME_TARGET_HEADER` (`x-remix-target`) in
  `frame-constants.ts`.
- Client `entry.tsx` `resolveFrame` sets the header to the frame `name` when
  fetching `src`.
- Server `handleFrameRequest` reads the header and selects the registered frame.

## Auth scoping

Frames that render user-scoped data must derive auth from the **same `Request`**
as the full page — use `loadResolvedRequestAuth`, `readAuthenticatedAppUser`, or
the same loader helpers the page handler uses. Never read user state from global
module variables.

## Client typed routes

Client code imports `routes` from `#app/routes.ts` (included in
`tsconfig-client.json`). The route table is isomorphic plain data from
`remix/routes`; esbuild bundles it via the root `package.json` `imports` map.

Example (`client/routes/community.tsx`):

```tsx
<Frame name={COMMUNITY_LISTINGS_TARGET} src={frameSrc} />
```

`COMMUNITY_LISTINGS_TARGET` lives in `community-frame-constants.ts` alongside
the server-side `registerFrame` call in `frames/community-listings.ts`.
