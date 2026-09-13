/**
 * Lazy access to the platform-supplied `remix` file set for package bundles
 * (see `#worker/package-runtime/package-app-remix.ts`), pre-bundled by
 * `tools/build-worker-bundler-modules.ts` into `packages/worker/.generated/`
 * and hardlinked under `./node_modules/.kody-generated/`.
 *
 * Same deferred lane as `#worker/worker-bundler-modules.ts`, and for the same
 * reason: the ~0.5 MB of serialized Remix modules must only load when a
 * package bundle is actually built, never on isolate cold start. The relative
 * `./node_modules/.kody-generated/` specifier is what the
 * `find_additional_modules` rule in each `wrangler.jsonc` matches, so this
 * loader has to live directly under `src/` next to the bundler loader.
 */
export function importPackageAppRemix(): Promise<{
	remixVersion: string
	files: Record<string, string>
}> {
	return import('./node_modules/.kody-generated/package-app-remix.mjs')
}
