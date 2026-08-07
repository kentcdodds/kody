/**
 * Loads immutable OG fonts and art from the ASSETS binding at render time.
 * These bytes used to ship as base64 string constants in the worker bundle;
 * fetching them on demand keeps cold-start isolates smaller when no OG image
 * is rendered.
 */

const OG_ASSET_URLS = {
	bricolageGrotesqueLatin700:
		'https://assets.local/og/bricolage-grotesque-latin-700.ttf',
	wixMadeforTextLatin400:
		'https://assets.local/og/wix-madefor-text-latin-400.ttf',
	kodyPatternDark: 'https://assets.local/og/kody-pattern-dark.png',
	kodyPatternLight: 'https://assets.local/og/kody-pattern-light.png',
	kodyHero: 'https://assets.local/og/kody-hero.png',
	kodyLogo: 'https://assets.local/og/kody-logo.png',
} as const

export type OgAssetsFetcher = { fetch: (request: Request) => Promise<Response> }

type OgBinaryAssetCache = {
	bricolageGrotesqueLatin700: ArrayBuffer
	wixMadeforTextLatin400: ArrayBuffer
	kodyPatternDarkDataUri: string
	kodyPatternLightDataUri: string
	kodyHeroDataUri: string
	kodyLogoDataUri: string
}

let cache: OgBinaryAssetCache | null = null
let loadPromise: Promise<void> | null = null

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer
}

function bytesToPngDataUri(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return `data:image/png;base64,${btoa(binary)}`
}

async function fetchAssetBytes(
	assets: OgAssetsFetcher,
	url: string,
): Promise<Uint8Array> {
	const response = await assets.fetch(new Request(url))
	if (!response.ok) {
		throw new Error(`OG asset fetch failed: ${url} (${response.status})`)
	}
	return new Uint8Array(await response.arrayBuffer())
}

async function loadOgBinaryAssets(
	assets: OgAssetsFetcher,
): Promise<OgBinaryAssetCache> {
	const [
		bricolageGrotesqueLatin700,
		wixMadeforTextLatin400,
		kodyPatternDark,
		kodyPatternLight,
		kodyHero,
		kodyLogo,
	] = await Promise.all([
		fetchAssetBytes(assets, OG_ASSET_URLS.bricolageGrotesqueLatin700),
		fetchAssetBytes(assets, OG_ASSET_URLS.wixMadeforTextLatin400),
		fetchAssetBytes(assets, OG_ASSET_URLS.kodyPatternDark),
		fetchAssetBytes(assets, OG_ASSET_URLS.kodyPatternLight),
		fetchAssetBytes(assets, OG_ASSET_URLS.kodyHero),
		fetchAssetBytes(assets, OG_ASSET_URLS.kodyLogo),
	])

	return {
		bricolageGrotesqueLatin700: toArrayBuffer(bricolageGrotesqueLatin700),
		wixMadeforTextLatin400: toArrayBuffer(wixMadeforTextLatin400),
		kodyPatternDarkDataUri: bytesToPngDataUri(kodyPatternDark),
		kodyPatternLightDataUri: bytesToPngDataUri(kodyPatternLight),
		kodyHeroDataUri: bytesToPngDataUri(kodyHero),
		kodyLogoDataUri: bytesToPngDataUri(kodyLogo),
	}
}

function requireCache(): OgBinaryAssetCache {
	if (!cache) {
		throw new Error('OG binary assets are not loaded')
	}
	return cache
}

/** Test hook: clears the per-isolate OG binary asset cache. */
export function resetOgBinaryAssetsCache() {
	cache = null
	loadPromise = null
}

/** Fetch and cache OG fonts and art. Requires the ASSETS binding. */
export async function ensureOgBinaryAssetsReady(input: {
	assets: OgAssetsFetcher | undefined
}): Promise<void> {
	if (cache) return
	if (!input.assets) {
		throw new Error('OG binary assets require an ASSETS binding')
	}
	if (!loadPromise) {
		loadPromise = loadOgBinaryAssets(input.assets)
			.then((loaded) => {
				cache = loaded
			})
			.catch((error) => {
				loadPromise = null
				throw error
			})
	}
	await loadPromise
}

export function getBricolageGrotesqueLatin700FontData(): ArrayBuffer {
	return requireCache().bricolageGrotesqueLatin700
}

export function getWixMadeforTextLatin400FontData(): ArrayBuffer {
	return requireCache().wixMadeforTextLatin400
}

export function getKodyPatternDataUri(theme: 'light' | 'dark'): string {
	const loaded = requireCache()
	return theme === 'light'
		? loaded.kodyPatternLightDataUri
		: loaded.kodyPatternDarkDataUri
}

export function getKodyHeroDataUri(): string {
	return requireCache().kodyHeroDataUri
}

export function getKodyLogoDataUri(): string {
	return requireCache().kodyLogoDataUri
}
