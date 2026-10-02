import {
	importIsomorphicGitModules,
	type IsomorphicGitModules,
} from '#worker/isomorphic-git-modules.ts'

export type IsomorphicGit = IsomorphicGitModules

let memo: Promise<IsomorphicGit> | null = null

/**
 * isomorphic-git builds large lookup tables when its module evaluates, which
 * showed up as the biggest single third-party item in the origin Worker
 * startup profile. Every git operation runs inside an async repo call, so the
 * library is loaded on first use and cached for the isolate.
 *
 * Prefer this helper over importing `isomorphic-git` (or the generated
 * additional module) directly. The bytes live in
 * `./node_modules/.kody-generated/isomorphic-git.mjs` — see
 * `#worker/isomorphic-git-modules.ts` — so they stay off the main startup
 * entry; one static import of the npm package anywhere on the startup path
 * makes wrangler inline those bytes again.
 */
export function loadIsomorphicGit(): Promise<IsomorphicGit> {
	memo ??= importIsomorphicGitModules().catch((error: unknown) => {
		memo = null
		throw error
	})
	return memo
}
