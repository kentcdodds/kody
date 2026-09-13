import { importPackageAppRemix } from '#worker/package-app-remix-modules.ts'
import { remixPackageName } from './package-app-remix-subpaths.ts'

/**
 * Platform-supplied Remix for package code.
 *
 * Package apps are hosted Remix mini-apps: they import `remix/<subpath>`
 * like the origin UI does, and the platform — not an npm install at publish
 * time — supplies those modules at the version the rest of Kody ships. The
 * file set is pre-bundled by `tools/build-worker-bundler-modules.ts`
 * (`package-app-remix.mjs`, loaded lazily from
 * `./node_modules/.kody-generated/` like the runtime bundler itself) and
 * mounted at `node_modules/remix/` in the bundler's virtual file system, so
 * esbuild resolves `remix/router` through the vendored `package.json`
 * exports exactly as it would a real install. The bundler skips the npm
 * install for any package whose `node_modules/<name>/package.json` is
 * already present, so a `remix` entry in `package.json#dependencies` is
 * inert and the platform version always wins.
 */

const vendoredRemixPathPrefix = `node_modules/${remixPackageName}/`

let platformRemixFilesPromise: Promise<PlatformRemixFiles> | null = null

export type PlatformRemixFiles = {
	remixVersion: string
	/** Bundler virtual-FS entries keyed as `node_modules/remix/<path>`. */
	files: Record<string, string>
}

export function loadPlatformRemixFiles(): Promise<PlatformRemixFiles> {
	platformRemixFilesPromise ??= importPackageAppRemix().then((module) => {
		const files: Record<string, string> = {}
		for (const [relativePath, content] of Object.entries(module.files)) {
			files[`${vendoredRemixPathPrefix}${relativePath}`] = content
		}
		return { remixVersion: module.remixVersion, files }
	})
	return platformRemixFilesPromise
}

/**
 * Adds the vendored `remix` package to a bundler file set. The platform copy
 * replaces any `node_modules/remix/*` file the package snapshot carries so
 * server and browser bundles always agree on one Remix version.
 */
export async function withPlatformRemixFiles(
	files: Record<string, string>,
): Promise<Record<string, string>> {
	const platformRemix = await loadPlatformRemixFiles()
	const merged: Record<string, string> = {}
	for (const [filePath, content] of Object.entries(files)) {
		if (filePath.startsWith(vendoredRemixPathPrefix)) continue
		merged[filePath] = content
	}
	return { ...merged, ...platformRemix.files }
}

export function isVendoredRemixPath(filePath: string) {
	return filePath.startsWith(vendoredRemixPathPrefix)
}
