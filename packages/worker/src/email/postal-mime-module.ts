/**
 * Entry for the deferred postal-mime additional module. Bundled by
 * `tools/build-worker-bundler-modules.ts` into
 * `node_modules/.kody-generated/postal-mime.mjs`. Loaders must import that
 * generated specifier (see `postal-mime-load.ts`) — a bare
 * `import('postal-mime')` is inlined into Wrangler main and counts toward the
 * platform/runtime startup byte budget.
 */
export { default as PostalMime } from 'postal-mime'
