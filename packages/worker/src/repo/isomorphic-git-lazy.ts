import type git from 'isomorphic-git'
import type http from 'isomorphic-git/http/web'

export type IsomorphicGit = { git: typeof git; http: typeof http }

let memo: Promise<IsomorphicGit> | null = null

/**
 * isomorphic-git builds large lookup tables when its module evaluates, which
 * showed up as the biggest single third-party item in the origin Worker
 * startup profile. Every git operation runs inside an async repo call, so the
 * library is loaded on first use and cached for the isolate. Import this
 * helper instead of `isomorphic-git` directly; one static import anywhere on
 * the startup path makes esbuild evaluate the library eagerly again.
 */
export function loadIsomorphicGit(): Promise<IsomorphicGit> {
	memo ??= Promise.all([
		import('isomorphic-git'),
		import('isomorphic-git/http/web'),
	])
		.then(([gitModule, httpModule]) => ({
			git: gitModule.default,
			http: httpModule.default,
		}))
		.catch((error: unknown) => {
			memo = null
			throw error
		})
	return memo
}
