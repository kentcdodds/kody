import { importPackageAppRemix } from '#worker/package-app-remix-modules.ts'
import {
	remixPackageName,
	remixUiPackageName,
} from './package-app-remix-subpaths.ts'

/**
 * Platform-supplied Remix for package code.
 *
 * Optional convenience: package apps may import `remix/<subpath>` like the
 * origin UI does, and the platform — not an npm install at publish time —
 * supplies those modules at the version the rest of Kody ships. `@remix-run/ui`
 * primitives are supplied the same way so a package importing them still
 * shares the one vendored `@remix-run/component` runtime. The file set is
 * pre-bundled by `tools/build-worker-bundler-modules.ts`
 * (`package-app-remix.mjs`, loaded lazily from
 * `./node_modules/.kody-generated/` like the runtime bundler itself) and
 * mounted under `node_modules/` in the bundler's virtual file system, so
 * esbuild resolves `remix/router` and `@remix-run/ui/tabs` through the
 * vendored `package.json` exports exactly as it would a real install. The
 * bundler skips the npm install for any package whose
 * `node_modules/<name>/package.json` is already present, so a `remix` entry
 * in `package.json#dependencies` is inert and the platform version always
 * wins. Host dispatch and bundler options do not depend on Remix.
 */

const vendoredNodeModulesPrefix = 'node_modules/'
const vendoredRemixPathPrefixes = [
	`${vendoredNodeModulesPrefix}${remixPackageName}/`,
	`${vendoredNodeModulesPrefix}${remixUiPackageName}/`,
] as const

let platformRemixFilesPromise: Promise<PlatformRemixFiles> | null = null

export type PlatformRemixFiles = {
	remixVersion: string
	remixUiVersion: string
	/** Bundler virtual-FS entries keyed as `node_modules/<path>`. */
	files: Record<string, string>
}

export function loadPlatformRemixFiles(): Promise<PlatformRemixFiles> {
	platformRemixFilesPromise ??= importPackageAppRemix().then((module) => {
		const files: Record<string, string> = {}
		for (const [relativePath, content] of Object.entries(module.files)) {
			files[`${vendoredNodeModulesPrefix}${relativePath}`] = content
		}
		return {
			remixVersion: module.remixVersion,
			remixUiVersion: module.remixUiVersion,
			files,
		}
	})
	return platformRemixFilesPromise
}

/**
 * Adds the vendored `remix` and `@remix-run/ui` packages to a bundler file
 * set. The platform copies replace any `node_modules/remix/*` or
 * `node_modules/@remix-run/ui/*` file the package snapshot carries so server
 * and browser bundles always agree on one Remix version.
 */
export async function withPlatformRemixFiles(
	files: Record<string, string>,
): Promise<Record<string, string>> {
	const platformRemix = await loadPlatformRemixFiles()
	const merged: Record<string, string> = {}
	for (const [filePath, content] of Object.entries(files)) {
		if (isVendoredRemixPath(filePath)) continue
		merged[filePath] = content
	}
	return { ...merged, ...platformRemix.files }
}

export function isVendoredRemixPath(filePath: string) {
	return vendoredRemixPathPrefixes.some((prefix) => filePath.startsWith(prefix))
}
