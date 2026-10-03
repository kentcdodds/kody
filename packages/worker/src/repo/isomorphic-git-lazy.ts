/**
 * Re-export the src-root loader so existing `#worker/repo/isomorphic-git-lazy`
 * and relative `./isomorphic-git-lazy.ts` imports keep working. The generated
 * `.mjs` import itself must live in `packages/worker/src/` (see
 * `isomorphic-git-load.ts`).
 */
export {
	loadIsomorphicGit,
	type IsomorphicGit,
} from '#worker/isomorphic-git-load.ts'
