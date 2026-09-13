/**
 * Remix subpaths the platform supplies to package code as the vendored
 * `remix` package (see `tools/build-worker-bundler-modules.ts`, which
 * pre-bundles them into `package-app-remix.mjs`, and
 * `#worker/package-runtime/package-app-remix.ts`, which injects them into
 * every package bundle as `node_modules/remix/*`).
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
	'ui',
	'ui/accordion',
	'ui/accordion/primitives',
	'ui/anchor',
	'ui/animation',
	'ui/breadcrumbs',
	'ui/button',
	'ui/checkbox',
	'ui/combobox',
	'ui/combobox/primitives',
	'ui/input',
	'ui/jsx-dev-runtime',
	'ui/jsx-runtime',
	'ui/listbox',
	'ui/menu',
	'ui/menu/primitives',
	'ui/popover',
	'ui/radio',
	'ui/select',
	'ui/select/primitives',
	'ui/server',
	'ui/tabs',
	'ui/tabs/primitives',
	'ui/toggle',
	'ui/toggle/primitives',
] as const

export type PackageAppRemixSubpath = (typeof packageAppRemixSubpaths)[number]

/** The bare package name package code imports Remix from (`remix/<subpath>`). */
export const remixPackageName = 'remix'

/**
 * Whether a bare specifier names Remix (`remix` or `remix/<subpath>`). Used
 * to decide the package-app runtime when `kody.app.runtime` is not declared
 * and to keep `@remix-run/*` out of `package.json#dependencies`.
 */
export function isRemixSpecifier(specifier: string) {
	return (
		specifier === remixPackageName ||
		specifier.startsWith(`${remixPackageName}/`)
	)
}
