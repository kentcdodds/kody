import { clientRouteAreaNameForPath } from '#client/lazy-route.tsx'

/**
 * Reads the build-time client preload manifest (written by
 * `tools/build-client-manifest.ts` into the assets bundle) so SSR can emit
 * `<link rel="modulepreload">` tags for the hashed chunks the entry — and the
 * current route's lazy area — will import. Without these hints, code
 * splitting adds a network round trip before hydration (the browser only
 * discovers chunk URLs after downloading the entry).
 */

const MANIFEST_ASSET_URL = 'https://assets.local/client-manifest.json'

type ClientPreloadManifest = {
	entry: Array<string>
	areas: Record<string, Array<string>>
}

type AssetsFetcher = { fetch: (request: Request) => Promise<Response> }

let manifestCache: {
	buildId: string
	manifest: ClientPreloadManifest | null
} | null = null

function isHrefArray(value: unknown): value is Array<string> {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) => typeof entry === 'string' && entry.startsWith('/assets/'),
		)
	)
}

function parseManifest(value: unknown): ClientPreloadManifest | null {
	if (typeof value !== 'object' || value === null) return null
	const { entry, areas } = value as { entry?: unknown; areas?: unknown }
	if (!isHrefArray(entry)) return null
	if (typeof areas !== 'object' || areas === null) return null
	const parsedAreas: Record<string, Array<string>> = {}
	for (const [name, hrefs] of Object.entries(areas)) {
		if (!isHrefArray(hrefs)) return null
		parsedAreas[name] = hrefs
	}
	return { entry, areas: parsedAreas }
}

async function loadManifest(
	assets: AssetsFetcher,
	buildId: string,
): Promise<ClientPreloadManifest | null> {
	if (manifestCache?.buildId === buildId) return manifestCache.manifest
	let manifest: ClientPreloadManifest | null = null
	try {
		const response = await assets.fetch(new Request(MANIFEST_ASSET_URL))
		if (response.ok) {
			manifest = parseManifest(await response.json())
		}
	} catch {
		// Missing or malformed manifest just means no preload hints.
	}
	// Only cache a usable manifest: a transient assets fetch failure must not
	// pin "no hints" for the whole isolate lifetime.
	if (manifest) {
		manifestCache = { buildId, manifest }
	}
	return manifest
}

/** Test hook: clears the per-isolate manifest cache. */
export function resetClientPreloadManifestCache() {
	manifestCache = null
}

/**
 * Module preload hrefs for the given request pathname: the entry's static
 * import closure plus, when the path is served by a lazy route area, that
 * area's chunk and unique dependencies. Empty in dev (unversioned assets) and
 * when the manifest is unavailable.
 */
export async function getClientModulePreloadHrefs(input: {
	assets: AssetsFetcher | undefined
	buildId: string
	pathname: string
}): Promise<Array<string>> {
	const { assets, buildId, pathname } = input
	if (buildId === 'dev' || !assets) return []
	const manifest = await loadManifest(assets, buildId)
	if (!manifest) return []
	const areaName = clientRouteAreaNameForPath(pathname)
	const areaHrefs = areaName ? (manifest.areas[areaName] ?? []) : []
	return [...manifest.entry, ...areaHrefs]
}
