/**
 * esbuild entry for the deferred isomorphic-git additional module.
 * Bundles the library + web HTTP client into one `.mjs` that
 * `#worker/isomorphic-git-modules.ts` loads via `import()`.
 */
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'

export { git, http }
