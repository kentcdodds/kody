import { type PostalMime } from './email/postal-mime-module.ts'

/**
 * Load postal-mime from the deferred additional module. Specifier must stay
 * `./node_modules/.kody-generated/…` relative to `packages/worker/src` so
 * Wrangler matches the ESModule rule (same trap as `isomorphic-git-load.ts`).
 * Callers under `email/` must not import the `.mjs` with a `../` path — that
 * inlines the module into the main entry.
 *
 * Use `import type` (never `import { type … }`) for postal-mime types:
 * `verbatimModuleSyntax` keeps an inline-type import as a side-effect import,
 * which puts the package back on the startup entry.
 */

export type PostalMimeParser = typeof PostalMime

let memo: Promise<PostalMimeParser> | null = null

/**
 * Every MIME parse is already async (inbound delivery, attachment reads), so
 * the parser loads on first use and is cached for the isolate.
 */
export function loadPostalMime(): Promise<PostalMimeParser> {
	memo ??= import('./node_modules/.kody-generated/postal-mime.mjs').then(
		(module) => module.PostalMime,
		(error: unknown) => {
			memo = null
			throw error
		},
	)
	return memo
}
