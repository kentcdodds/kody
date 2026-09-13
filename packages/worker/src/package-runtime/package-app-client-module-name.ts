/**
 * Naming contract for the fingerprinted browser module a package app's
 * `kody.app.client` compiles to. Shared by the bundle builder (which names
 * the artifact), the serve path (which recognises requests for it), and
 * publish checks (which keep the assets directory out of that namespace).
 */

export const clientModuleHashLength = 16

export function buildPackageAppClientModuleName(hash: string) {
	return `client.${hash}.js`
}

/**
 * Exactly the shape `buildPackageAppClientModuleName` produces (base64url
 * SHA-256 prefix of fixed length), so the serve path can recognise a client
 * module request without shadowing static assets such as
 * `client.production.js`.
 */
export const packageAppClientModuleNamePattern = new RegExp(
	`^client\\.[A-Za-z0-9_-]{${clientModuleHashLength}}\\.js$`,
)

/**
 * Root of `/_assets/` that the platform answers itself: the current publish's
 * version JSON, consulted by service workers and kits to discover
 * `clientModuleUrl` without a hash in their source.
 */
export const packageAppVersionAssetName = '__version.json'
