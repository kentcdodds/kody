---
id: package_apps
title: Package apps
summary:
  Give a package a hosted HTTP and browser surface. Covers the default app shape
  after an integration smoke test, session handoff to the `*.kody.run`
  subdomain, smoke tests with packageAppFetch, absolute asset URLs, the
  platform-built browser client (`kody.app.client`) and static assets directory
  (`kody.app.assets`), the same-origin proxy, lean forks, compiled clients, and
  listing verification.
category: platform
---

# Package apps

Use this doc when authoring or debugging a package **app**, a community fork of
an app, or a hosted-app load. Package shape, README / AGENTS.md, Intent, and
export JSDoc stay in [Package authoring](./package-authoring.md)
(`package_authoring:guide`). Proving the integration first stays in
[Integration bootstrap](./integration-bootstrap.md)
(`integration_bootstrap:guide`).

Open a heading with `search({ entity: "package_apps:guide#asset-urls" })` (or
another slug below) when you need one recipe.

## After an integration smoke test

Once `integration_bootstrap` proves the integration works — or integration and
secret state are already clear enough to verify quickly — go straight to the
app. Do not spelunk the local repo first unless you specifically need repo
conventions, shared helpers, or an existing package to extend.

1. Discover integration and secret state with `search`. Read full integration
   metadata only when you need exact names, hosts, or the API base URL.
2. Verify the required connection exists. For OAuth, confirm the integration
   name, required hosts, and API base URL match the app you are about to build
   (tokens live on the connection). For secret-backed auth, confirm the secret
   names and allowed hosts match.
3. Run one cheap authenticated smoke test in `execute` — a small read-only
   request such as `GET /me`, `GET /viewer`, or `GET /v1/me`.
4. If it passes, build the app as a saved package with
   `package.json#kody.app.entry`. Keep human `README.md` (including `## Intent`)
   and agent `AGENTS.md` aligned with the person's goal. Keep provider API calls
   and durable coordination in package-owned backend modules.
5. Save with `packageSave` (or push through the git lane), reopen the hosted
   package URL, and iterate there instead of pasting large inline HTML blobs
   back into model context.

### Default app shape

For non-trivial or integration-backed apps, prefer this split:

- **app entry** — a Worker-style fetch surface declared by
  `package.json#kody.app.entry`
- **browser client** — one TypeScript/JSX entry declared by
  `package.json#kody.app.client`; Kody bundles it for the browser on publish and
  serves it as a fingerprinted module (see
  [Browser client and static assets](#browser-client-and-static-assets))
- **static assets** — an optional directory declared by
  `package.json#kody.app.assets`, served as-is
- **exports** — reusable modules and callable default exports declared in
  `package.json#exports`
- **durable data** — `packageStorage()` for the shared package bucket
- **internal backend modules / Durable Objects / facets** — app-internal
  realtime and coordination details (integration lookups, provider calls,
  validation, mutations), not the persistence mechanism
- **inline HTML renders** — fine for a quick prototype, not the default pattern

## Session handoff

Production-hosted apps live at
`https://{username}.kody.run/packages/<package-name>/…`. Opening the app from
the signed-in kody.codes origin (**Open app**, the publish `hosted_app_url`, or
the equivalent package page control) attaches a short-lived session, then the
subdomain loads. Plan QA around that path: signed-in origin first, then confirm
the app on `*.kody.run/packages/…`.

`packageAppFetch` exercises the fetch handler without that browser session. Use
it for handler smoke tests. Use the handed-off URL for cookies, layout, OAuth
redirects, and websocket facets.

## Smoke with packageAppFetch

After publish, call `packageAppFetch` with the path, method, and body the
handler needs. Confirm `{ status, headers, body, truncated }` and any
`packageStorage()` side effects. Read
[Package app fetch](../use/package-app-fetch.md) for the call shape.

Typical first probe:

```json
{
	"package_id": "550e8400-e29b-41d4-a716-446655440000",
	"path": "/"
}
```

Check status, content-type, and a small HTML or JS snippet in `body`. When
`truncated` is `true`, the handler ran; the MCP body is a size-capped sample
(about 100 KB). Side effects are real.

Copy-paste starting points land on `test_hints.app` after
`packagePublishExternalPush`.

## Interactive UI QA

Confirm the real user flow in a browser that already has the session, or in a
local harness that serves the **same** published client and assets:

1. Open the app from kody.codes so the handoff attaches, **or** serve the
   published entry, HTML, and asset routes locally with the same `appBasePath` /
   `hostedUrl` join the Worker uses.
2. Click, type, and submit the way a person would.
3. Confirm layout, redirects, and any websocket facet on that same client.
4. Then ping the owner.

`packageAppFetch` stays the handler smoke. Interactive QA is the handed-off
browser or that local harness.

## Large binaries

`packageAppFetch` is the lightweight smoke: status, headers, and a small body
sample. For a large download (WASM, WAD, video, zip), use a full download path —
`curl` against the handed-off or local harness URL, or the streamed app route
that serves those bytes — and confirm length, content-type, and that the file
opens in the client.

Treat `truncated: true` as “the handler answered,” then finish the proof on the
full stream.

## Asset URLs

Build every in-app asset URL, link, redirect, share/email URL, and OAuth
callback from `packageContext.appBasePath` plus `hostedUrl` (or
`new URL(path, origin)` with a trailing-slash-safe origin). Kody strips the
mount before the handler runs, so the fetch sees `/<path>` only. Absolute
`/audio/123` links leave the mount; mount-prefixed URLs stay under
`/packages/<package-name>/…` (or `/@username/packages/<package-name>/…` when
served inline).

```ts
import { packageContext } from 'kody:runtime'

function appUrl(path: string) {
	if (!packageContext?.hostedUrl) {
		throw new Error('This module must run as a package app.')
	}
	const relative = path.replace(/^\/+/, '')
	const mount = packageContext.appBasePath.endsWith('/')
		? packageContext.appBasePath
		: `${packageContext.appBasePath}/`
	return new URL(`${mount}${relative}`, packageContext.hostedUrl)
}

const sprite = appUrl('assets/sprite.png')
const callback = appUrl('oauth/callback')
```

`hostedUrl` is the public mount URL. `appBasePath` is the origin-relative mount
(`/packages/<package-name>` on a subdomain). Both come from the current serving
username and package name leaf, including after a rename or fork. When you pass
a relative path to `new URL(path, origin)`, give `origin` a trailing slash so
`assets/sprite.png` stays under the mount.

Files the platform serves for you (the bundled browser client and the
`kody.app.assets` directory) live under `packageContext.assetBasePath`; see the
next section.

## Browser client and static assets

Declare a browser entry and Kody compiles it on publish, so the repo holds
TypeScript source instead of checked-in `.js`.

### Minimal recipe

Three files plus an optional directory. This is the layout `create-package-app`
(package-app-kit) scaffolds, so keep it: Worker code under `src/`, browser code
under `src/client/`, static files under `public/`.

`package.json`:

```json
{
	"name": "@you/counter",
	"exports": { ".": "./src/index.ts" },
	"kody": {
		"id": "counter",
		"description": "Counter with a platform-built browser client",
		"app": {
			"entry": "./src/app.ts",
			"client": "./src/client/index.ts",
			"assets": "./public"
		}
	}
}
```

`src/app.ts` (Worker fetch handler; renders the page). Runtime config rides on
`<html>` data attributes rendered from `packageContext`: `data-app-base` (the
mount), `data-client-module` (the fingerprinted module URL), and
`data-pak-config` (any JSON your client needs):

```ts
import { packageContext } from 'kody:runtime'

export default {
	async fetch() {
		const { appBasePath, assetBasePath, clientModuleUrl } = packageContext ?? {}
		const pakConfig = JSON.stringify({ theme: 'dark' })
		return new Response(
			`<!doctype html>
<html lang="en"
	data-app-base="${appBasePath}"
	data-client-module="${clientModuleUrl}"
	data-pak-config='${pakConfig}'>
<head>
	<meta charset="utf-8" />
	<link rel="stylesheet" href="${assetBasePath}/styles.css" />
</head>
<body>
	<button id="inc" type="button">Clicked 0 times</button>
	<script type="module" src="${clientModuleUrl}"></script>
</body>
</html>`,
			{ headers: { 'content-type': 'text/html; charset=utf-8' } },
		)
	},
}
```

`src/client/index.ts` (browser; TypeScript is fine, relative imports are
inlined):

```ts
const config = JSON.parse(document.documentElement.dataset.pakConfig ?? '{}')
let count = 0
const button = document.querySelector<HTMLButtonElement>('#inc')!
button.addEventListener('click', () => {
	count += 1
	button.textContent = `Clicked ${count} time${count === 1 ? '' : 's'}`
})
console.log('theme', config.theme)
```

`public/styles.css` (optional `assets` directory, served as-is).

### Two graphs, not one

`kody.app.entry` and `kody.app.client` are **separate module graphs**. The
Worker bundle rewrites `kody:` imports into runtime proxies and runs in an
isolate; the client bundle targets the browser. Publish fails when the Worker
graph imports the client entry (directly or through a helper), or when both
fields point at the same file. Shared helpers imported from both sides are fine
— keep them free of `kody:` and DOM APIs. The Worker renders the
`<script type="module">` tag; the two sides talk over fetch or the realtime
facet.

Browser-only packages (`@remix-run/ui`, a component library, a DOM polyfill)
therefore never reach the Worker bundle as long as the Worker graph does not
import them. To keep them out of the client bundle too, declare them as
[externals](#import-maps-and-externals) and resolve them with an import map.

### What each field does

- `entry` — the Worker fetch handler (unchanged).
- `client` — one `.ts`, `.tsx`, `.js`, or `.jsx` file bundled for the
  **browser** (ESM, `es2022`, relative imports and `package.json` npm
  dependencies inlined). The output is served at
  `<appBasePath>/_assets/client.<hash>.js` with
  `Cache-Control: private, max-age=31536000, immutable` (browser-cached for a
  year; `private` because the owner's session gates every package-app response);
  the hash changes with the content, so never hardcode the file name. Use the
  object form `{ "entry": "./src/client/index.ts", "externals": [...] }` when
  the page supplies an [import map](#import-maps-and-externals).
- `assets` — a subdirectory of static files served as-is at
  `<appBasePath>/_assets/<path inside the directory>` with a content type
  inferred from the extension (`.css`, `.png`, `.wasm`, `.woff2`, …), a
  commit-scoped `ETag`, and `Cache-Control: private, max-age=300`. No TypeScript
  compile, no bundling. `__version.json` is reserved at the root of `/_assets/`
  (see [Service worker precache](#service-worker-precache)).

### Stable `packageContext` fields

These names are part of the package-app contract and stay stable; kits and
scaffolders can depend on them.

- `packageContext.clientModuleUrl` — absolute URL of the current fingerprinted
  client module (`<hostedUrl>/_assets/client.<hash>.js`), or `null` when the
  manifest declares no `client`. Drop it straight into
  `<script type="module" src="…">` and `data-client-module`.
- `packageContext.assetBasePath` — origin-relative `<appBasePath>/_assets`,
  mount-aware like `appBasePath`. Join `assets` files onto it
  (`${assetBasePath}/styles.css`).

`/_assets/*` is reserved: the platform answers it before the fetch handler runs,
and the handler never sees those paths. A client hash from an older publish
returns 404 rather than a stale module, so always render the URL from
`packageContext`.

### Browser-safe graph

The client graph must be browser-safe. Publish fails, naming the file, when the
client (or anything it imports) pulls in `kody:runtime`, a `kody:@…` package
import, `cloudflare:*`, or `node:*`; keep those in `entry` and expose data over
fetch or the realtime facet. `import './styles.css'` is rejected too — put CSS
in the assets directory and link it. Full `https://` URL imports stay external
and load in the browser as written.

### Import maps and externals

By default every bare import is inlined from `package.json#dependencies`, and a
bare import the bundler cannot resolve fails publish. To let the **page** decide
where a package comes from (an import map pointing at a CDN, a shared kit
bundle, or a file in `assets`), declare it under `client.externals`:

```json
{
	"kody": {
		"app": {
			"entry": "./src/app.ts",
			"client": {
				"entry": "./src/client/index.ts",
				"externals": ["@remix-run/ui", "preact"]
			},
			"assets": "./public"
		}
	}
}
```

Externals are bare specifiers only (no relative paths, URLs, or `kody:` /
`cloudflare:` / `node:` schemes); each covers its subpaths (`preact` also covers
`preact/hooks`). The bundled module keeps them as
`import … from "@remix-run/ui"` and the page maps them:

```ts
const importMap = JSON.stringify({
	imports: {
		'@remix-run/ui': `${assetBasePath}/vendor/ui.js`,
		preact: 'https://esm.sh/preact@10',
	},
})
// in the HTML head, before the module script
`<script type="importmap">${importMap}</script>`
```

Undeclared bare imports that survive bundling still fail publish; the error
names the specifier and points here.

### Service worker precache

`clientModuleUrl` is content-addressed and immutable, so a service worker can
precache it on install and serve it from cache forever. **Never hardcode the
hash in the worker's source** — it changes on every publish. Discover the URL at
runtime instead; the platform gives you two ways:

- `<html data-client-module="…">`, rendered by your fetch handler from
  `packageContext.clientModuleUrl` (the page reads it and posts it to the
  worker, as in the recipe above).
- `GET <assetBasePath>/__version.json` — served by the platform, never cached
  (`Cache-Control: private, no-cache`), always the current publish:

```json
{
	"clientModuleUrl": "https://you.kody.run/packages/counter/_assets/client.83T6UIqNQEvueSq_.js",
	"assetBasePath": "/packages/counter/_assets",
	"publishedCommit": "0f3c…"
}
```

Ship the worker script from the `assets` directory and register it with the
slash-terminated app mount as its scope. JavaScript served from `/_assets/`
carries `Service-Worker-Allowed: <appBasePath>/`, which permits that broader
scope. The trailing slash matters: scope matching is a string-prefix check, so a
scope of `/packages/app` would also claim the sibling mount
`/packages/app-secret`; `/packages/app/` cannot.

```ts
// in the page (src/client/index.ts)
const { appBase } = document.documentElement.dataset
navigator.serviceWorker.register(`${appBase}/_assets/sw.js`, {
	scope: `${appBase}/`,
})
```

```js
// public/sw.js — no hash anywhere: read the current module URL on install.
self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const version = await (
				await fetch(new URL('_assets/__version.json', self.registration.scope))
			).json()
			const cache = await caches.open(`app-${version.publishedCommit}`)
			if (version.clientModuleUrl) await cache.add(version.clientModuleUrl)
		})(),
	)
})
```

Scope boundary: the bare mount URL (`hostedUrl`, `/packages/app` with no
trailing slash — where the handoff lands) sits outside a `/packages/app/` scope,
so the worker controls every page under the mount but not a document loaded at
that exact URL. Link and redirect to slash-terminated paths inside the app
(`${appBase}/`, `${appBase}/settings`) so the pages people spend time on are
controlled; the root visit still gets the module straight from the platform with
its immutable cache header.

Static `assets` paths are not fingerprinted (they carry a commit-scoped `ETag`
and a five-minute max-age), so precache them keyed by `publishedCommit` and drop
old caches on activate.

Checked-in browser-ready `.js` served from the fetch handler with an explicit
`Content-Type` still works; `client` is the pit-of-success path for source you
want compiled.

## Same-origin proxy

When the browser needs third-party bytes reliably (WASM, media, a vendor
script), add an app route that streams the upstream body from the Worker. The
page then fetches a same-origin `appUrl('…')` instead of a foreign host.

```ts
export default {
	async fetch(request: Request) {
		const path = new URL(request.url).pathname
		if (path === '/vendor/engine.wasm') {
			const upstream = await fetch('https://cdn.example.com/engine.wasm')
			return new Response(upstream.body, {
				status: upstream.status,
				headers: {
					'content-type':
						upstream.headers.get('content-type') ?? 'application/wasm',
				},
			})
		}
		return new Response('ok')
	},
}
```

Point the client at `appUrl('vendor/engine.wasm')`. The Worker holds the
upstream `fetch`; the browser stays on the package-app origin.

## Lean forks

Keep the package source cheap to `communityFork`: modest raw assets in the repo
(icons, small sprites, HTML/JS). Serve heavy runtime payloads from a CDN or a
streamed [same-origin app route](#same-origin-proxy). Forks copy default-branch
HEAD; a smaller tree finishes faster and stays under isolate limits.

A fork that dies on memory or CPU returns a capability error that the listing
was unchanged. Lean the tree, then fork again.

## Compiled clients

This section is about third-party compiled engines, not the `kody.app.client`
bundle above. When the app ships a compiled engine (WASM plus JS glue), read the
**shipped** glue and match its startup contract. Typical Emscripten-style glue
accepts `Module.arguments` plus a normal `run()`, and `wasmBinary` or
`instantiateWasm` when you supply the bytes:

```js
const Module = {
	arguments: ['--fullscreen'],
	wasmBinary: engineBytes,
}

document.querySelector('#engine-script').addEventListener('load', () => {
	Module.run?.()
})
```

Load a one-shot engine script **once** per page life (a single `<script>`
element, or one dynamic import). After a failed boot, recover with a full page
reload when the glue is not re-entrant.

## Fork failures

When `communityFork` or one-click install fails, read the **capability error
text** first, then the run or delivery logs on [Activity](../use/activity.md)
(`runs` domain). Match the next step to that failure:

- “too large to finish forking” — slim the listing source
  ([Lean forks](#lean-forks)), then retry
- repo `docs` or check failures — add README / AGENTS.md or fix the named check,
  then publish
- secret or host approval — send the owner the approval URL, then smoke-test

The error text is the source of truth for which of those paths you are on.

## Listing verification

After `communityPublish` (or `packageUpdate` with
`changes.visibility: "public"`), call `communityGet` with the listing id and
confirm the card matches intent:

| Field           | Confirm                                                            |
| --------------- | ------------------------------------------------------------------ |
| `license`       | The license string you meant to show                               |
| `pinned_commit` | The commit you just published                                      |
| `description`   | Short tagline (`kody.description`)                                 |
| `tags`          | Search keywords                                                    |
| `category`      | `integrations`, `examples`, `productivity`, `apps`, or `utilities` |
| `name`          | Scoped package name (`@username/leaf`)                             |
| `public_url`    | `/@username/{package-name}` (share this URL with people)           |
| `version`       | `package.json#version` when you set one                            |

Share `public_url` with humans. Hygiene before going public stays in
[Package authoring](./package-authoring.md#personal-details-hygiene-before-going-public).
