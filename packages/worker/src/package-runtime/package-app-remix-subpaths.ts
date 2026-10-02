/**
 * Remix subpaths the platform supplies to package code as the vendored
 * `remix` package (see `tools/build-worker-bundler-modules.ts`, which
 * pre-bundles them into `package-app-remix.mjs`, and
 * `#worker/package-runtime/package-app-remix.ts`, which injects them into
 * every package bundle as `node_modules/remix/*`). `@remix-run/ui`
 * primitives ride the same lane below as `node_modules/@remix-run/ui/*`.
 *
 * The list is the Workers-safe part of the `remix` meta-package: everything
 * that runs on Web APIs (`Request`, `Response`, streams, Web Crypto) plus
 * `node:async_hooks` / `node:zlib`, which the package-app isolate provides
 * through `nodejs_compat`. Subpaths that need a Node process, a filesystem,
 * a TCP database driver, or a dev server (`assets`, `cli`, `fs`,
 * `node-fetch-server`, `session-storage/fs`, `data-table/sqlite`, the `hmr`
 * family, `test`, …) are deliberately absent: a package that imports one of
 * them fails publish with the bundler's unresolved-bare-import error, which
 * names the specifier.
 *
 * Keep this list sorted; the generator asserts every entry exists in the
 * installed `remix` package's `exports` map.
 */
export const packageAppRemixSubpaths = [
	'assert',
	'auth',
	'component',
	'component/jsx-dev-runtime',
	'component/jsx-runtime',
	'component/server',
	'cookie',
	'data-schema',
	'data-schema/checks',
	'data-schema/coerce',
	'data-schema/form-data',
	'data-schema/lazy',
	'data-table',
	'data-table/migrations',
	'data-table/operators',
	'data-table/sql-helpers',
	'fetch-proxy',
	'file-storage',
	'file-storage/memory',
	'form-data-parser',
	'headers',
	'headers/accept',
	'headers/accept-encoding',
	'headers/accept-language',
	'headers/cache-control',
	'headers/content-disposition',
	'headers/content-range',
	'headers/content-type',
	'headers/cookie',
	'headers/if-match',
	'headers/if-none-match',
	'headers/if-range',
	'headers/range',
	'headers/raw-headers',
	'headers/set-cookie',
	'headers/vary',
	'html-template',
	'lazy-file',
	'middleware/async-context',
	'middleware/auth',
	'middleware/compression',
	'middleware/cop',
	'middleware/cors',
	'middleware/csrf',
	'middleware/form-data',
	'middleware/logger',
	'middleware/method-override',
	'middleware/session',
	'mime',
	'multipart-parser',
	'multiple-import-maps-polyfill',
	'response/compress',
	'response/file',
	'response/html',
	'response/redirect',
	'route-pattern',
	'route-pattern/href',
	'route-pattern/join',
	'route-pattern/match',
	'route-pattern/specificity',
	'router',
	'routes',
	'session',
	'session-storage/cookie',
	'session-storage/memory',
	'spa',
	'tar-parser',
] as const

export type PackageAppRemixSubpath = (typeof packageAppRemixSubpaths)[number]

/** The bare package name package code imports Remix from (`remix/<subpath>`). */
export const remixPackageName = 'remix'

/**
 * `@remix-run/ui` primitive subpaths the platform vendors alongside `remix`
 * (same lane as `packageAppRemixSubpaths`). Remix 3.0.0 dropped its styled
 * components; the headless primitives moved to this separate package, which
 * publish rejects as an npm dependency — an installed copy would drag in a
 * second `@remix-run/component` runtime. Vendoring it in the same code-split
 * build as `remix/component` keeps one shared component runtime.
 *
 * Keep this list sorted; the generator asserts every entry exists in the
 * installed `@remix-run/ui` package's `exports` map.
 */
export const packageAppRemixUiSubpaths = [
	'accordion',
	'anchor',
	'animation',
	'combobox',
	'listbox',
	'menu',
	'popover',
	'select',
	'tabs',
	'toggle',
] as const

export type PackageAppRemixUiSubpath =
	(typeof packageAppRemixUiSubpaths)[number]

/** The bare package name package code imports UI primitives from. */
export const remixUiPackageName = '@remix-run/ui'
