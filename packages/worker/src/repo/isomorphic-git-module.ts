/**
 * Entry for the deferred isomorphic-git additional module. Bundled by
 * `tools/build-worker-bundler-modules.ts` into
 * `node_modules/.kody-generated/isomorphic-git.mjs`. Loaders must import that
 * generated specifier (see `isomorphic-git-load.ts`) — a bare
 * `import('isomorphic-git')` or `@cloudflare/shell/git` is inlined into
 * Wrangler main and blows the platform/runtime startup byte budget.
 */
export { default as git } from 'isomorphic-git'
export { default as http } from 'isomorphic-git/http/web'
export { createGit } from '@cloudflare/shell/git'
