/**
 * Load isomorphic-git (and `@cloudflare/shell/git`'s `createGit`) from the
 * deferred additional module. Specifier must stay
 * `./node_modules/.kody-generated/…` relative to `packages/worker/src` so
 * Wrangler matches the ESModule rule (same trap as oauth-provider /
 * local-execute-runtime-support / worker-bundler). Callers under `repo/` must
 * not import the `.mjs` with a `../` path — that inlines the module into the
 * main entry.
 */

import  { type createGit } from '@cloudflare/shell/git'
import type git from 'isomorphic-git'
import type http from 'isomorphic-git/http/web'

export type IsomorphicGit = {
	git: typeof git
	http: typeof http
	createGit: typeof createGit
}

let memo: Promise<IsomorphicGit> | null = null

/**
 * isomorphic-git builds large lookup tables when its module evaluates. Every
 * git operation runs inside an async repo call, so the library loads on first
 * use and is cached for the isolate.
 *
 * Wrangler inlines ordinary `import('isomorphic-git')` and
 * `import('@cloudflare/shell/git')` into the worker main module (bytes count
 * toward the startup budget even when evaluation is deferred). Load the
 * pre-bundled additional module instead. Import this helper; never import
 * those packages on the startup path.
 */
export function loadIsomorphicGit(): Promise<IsomorphicGit> {
	memo ??= (
		import('./node_modules/.kody-generated/isomorphic-git.mjs') as Promise<IsomorphicGit>
	).catch((error: unknown) => {
		memo = null
		throw error
	})
	return memo
}
