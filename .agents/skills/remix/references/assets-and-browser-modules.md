# Assets and Browser Modules

## What This Covers

How to serve browser scripts and styles from source. Read this when the task
involves:

- Configuring `createAssetServer` (`mounts`, `allowFiles`, `denyFiles`,
  fingerprinting, compiler options)
- Choosing between `staticFiles()` for already-built files and
  `createAssetServer()` for source assets that need import rewriting, preloads,
  or fingerprinted URLs
- Generating script URLs or `<link rel="modulepreload">` tags for a client entry
- Keeping server-only files out of the browser via `deny` rules

For routing the URL namespace itself, see `routing-and-controllers.md`. For
client entry hydration, see `hydration-frames-navigation.md`.

## When To Reach For It

Use `remix/assets` when the app serves browser JavaScript, TypeScript, or CSS
from source files. This is the right tool for client entrypoints, browser-only
helpers, styles under `app/assets/`, and monorepo code that should be compiled
and served under a public URL namespace.

Use `staticFiles()` for files that already exist on disk exactly as they should
be served. Use `createAssetServer()` for source scripts or styles that need
rewriting, dependency scanning, preloads, sourcemaps, or fingerprinted URLs.

## Default Pattern

```typescript
import * as path from 'node:path'

import { createAssetServer } from 'remix/assets'
import { createRouter } from 'remix/router'

let assetServer = createAssetServer({
	rootDir: path.resolve(import.meta.dirname, '..'),
	mounts: {
		app: 'app',
		packages: '../packages',
	},
	allowFiles: ['app/assets/**', '../packages/**'],
	denyFiles: ['app/**/*.server.*'],
	target: { es: '2020', chrome: '109', safari: '16.4' },
	sourceMaps: process.env.NODE_ENV === 'development' ? 'external' : undefined,
	minify: process.env.NODE_ENV === 'production',
	scripts: {
		define: {
			'process.env.NODE_ENV': JSON.stringify(
				process.env.NODE_ENV ?? 'development',
			),
		},
	},
})

let router = createRouter()

router.get('/assets/*path', ({ request }) => {
	return assetServer.fetch(request)
})
```

## Rules

- Treat `allowFiles` and `denyFiles` as the security boundary for
  browser-reachable source files.
- Add a `denyFiles` list for server-only modules such as `*.server.*`, private
  config, or other files that should never be exposed.
- Set `rootDir` explicitly in monorepos so relative paths resolve from the
  intended project root.
- `mounts` maps a public URL directory to a filesystem directory and preserves
  the path beneath each root. Omit it to use
  `{ app: 'app', npm: 'node_modules' }`.
- Kody's origin website does not use `createAssetServer`. Hydration URLs come
  from Pitlane `?assets=` imports under Vite.
- CSS files are compiled and served alongside scripts. Local CSS `@import` rules
  are rewritten and fingerprinted with the same asset server routing rules.

## Rendering HTML

Browser scripts resolve their imports through import maps. Use
`getScriptEntry()` to get one entry's public `href`, its `importMap`, and its
`preloads`, then render `<ImportMap value={importMap} />` from `remix/ui/server`
**before** the `<link rel="modulepreload">` tags and the module `<script>`.

```tsx
import { ImportMap } from 'remix/ui/server'

let { href, importMap, preloads } = await assetServer.getScriptEntry(
	'app/assets/entry.ts',
)

// in the document component's <head>
;<>
	<ImportMap value={importMap} />
	{preloads.map((preloadHref) => (
		<link key={preloadHref} rel="modulepreload" href={preloadHref} />
	))}
	<script type="module" src={href}></script>
</>
```

`<ImportMap>` merges the entry map with mappings from blocking client entries so
the initial document carries one complete import map. `getImportMap()` combines
maps for several entries. Statically imported modules get import-map entries;
modules behind dynamic `import()` are fetched when the import runs.

When resolving hydrated client entries during server rendering, pass the source
entry ID from `clientEntry(import.meta.url, ...)` to `getScriptEntry()` inside
`resolveClientEntry` and return its `importMap` alongside `href`, `exportName`,
and `preloads`. Keep export-name resolution in that render helper, and avoid
hard-coding public asset URLs in source-owned component modules.

Browsers without native support for multiple import maps (needed by client
entries discovered after load and by HMR) use
`remix/multiple-import-maps-polyfill`: load entries with `importModule()` in
`run({ loadModule })`, return `[]` from `processClientEntryPreloads` after
`preloadShim(preloads)` when `detectMultipleImportMapSupport()` is false, and
set `hmr.moduleImporter: 'remix/multiple-import-maps-polyfill'` on the asset
server.

Inspect what the asset server would serve with
`remix assets inspect <url-or-file>` or `assetServer.getAssetDetails()`.

## Development vs Deployment

In development:

- Keep `watch` enabled so source changes are picked up without restarting the
  server
- Prefer stable URLs with normal revalidation
- Enable source maps when debugging browser code

In deployment:

- Set `watch: false`
- Use `fingerprint: true` for long-lived immutable caching. Fingerprints hash
  the final emitted bytes, so there is no build id to rotate
- If you persist `files.cache` across restarts, set `files.cacheKey` (for
  example the deploy's commit SHA) so transformed outputs are reused for the
  same build and never mixed between builds

Fingerprinting assumes files on disk are stable and requires `watch: false`.

Custom browser HMR events carry their payload under a `data` record keyed per
tool (`{ type: 'update', data: { 'my-tool@1': { timestamp, updates } } }`). The
standard `createBrowserHmrChannel()` integration needs no app code.

## Useful Compiler Options

- `minify` for production minification of scripts and styles
- `sourceMaps` for `'external'` or `'inline'` source maps for scripts and styles
- `sourceMapSourcePaths` for `'url'` or `'absolute'` source map paths
- `target` as an object for shared browser targets and script-only ECMAScript
  output, such as `{ es: '2020', chrome: '109', safari: '16.4' }`
- `scripts.define` to replace globals such as `process.env.NODE_ENV`
- `scripts.external` to leave specific script imports untouched

Do not nest shared compiler options under `scripts`. Use top-level `minify`,
`sourceMaps`, `sourceMapSourcePaths`, and `target` so they apply to styles as
well as scripts.

## Lifecycle

If the asset server is long-lived and watching the file system, call
`await assetServer.close()` when shutting down dev servers or disposing tests.
