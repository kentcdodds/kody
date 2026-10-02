import type git from 'isomorphic-git'
import type http from 'isomorphic-git/http/web'

export type IsomorphicGitModules = {
	git: typeof git
	http: typeof http
}

/**
 * Lazy access to isomorphic-git, loaded from the pre-bundled module in
 * `./node_modules/.kody-generated/` (built by
 * `tools/build-worker-bundler-modules.ts` into `packages/worker/.generated/`
 * and hardlinked here).
 *
 * Importing `isomorphic-git` directly — even via dynamic `import()` — gets
 * inlined into the single main worker module by wrangler. The generated
 * `.mjs` stays behind `import()` so Vite origin emits it as a hashed SSR
 * chunk and Wrangler sibling workers still match the `find_additional_modules`
 * rule. Either way it only loads when a git call actually runs.
 *
 * Note: `@cloudflare/shell` still depends on `isomorphic-git`, so platform /
 * origin may keep one copy of the library for shell. This module keeps our
 * repo/publish load path from adding a second inlined copy and drops the
 * library from workers that do not pull shell (notably runtime).
 */
export function importIsomorphicGitModules(): Promise<IsomorphicGitModules> {
	return import('./node_modules/.kody-generated/isomorphic-git.mjs')
}
