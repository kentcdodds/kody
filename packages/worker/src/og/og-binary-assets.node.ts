import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'

const publicOgDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../public/og',
)

type OgBinaryAssetCache = {
	bricolageGrotesqueLatin700: ArrayBuffer
	wixMadeforTextLatin400: ArrayBuffer
	kodyPatternDarkDataUri: string
	kodyPatternLightDataUri: string
	kodyHeroDataUri: string
	kodyLogoDataUri: string
}

let cache: OgBinaryAssetCache | null = null

export type OgAssetsFetcher = { fetch: (request: Request) => Promise<Response> }

function readAssetFile(name: string): Uint8Array {
	return readFileSync(join(publicOgDir, name))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer
}

function bytesToPngDataUri(bytes: Uint8Array): string {
	return `data:image/png;base64,${bytesToBase64(bytes)}`
}

function ensureCache(): OgBinaryAssetCache {
	if (cache) return cache
	cache = {
		bricolageGrotesqueLatin700: toArrayBuffer(
			readAssetFile('bricolage-grotesque-latin-700.ttf'),
		),
		wixMadeforTextLatin400: toArrayBuffer(
			readAssetFile('wix-madefor-text-latin-400.ttf'),
		),
		kodyPatternDarkDataUri: bytesToPngDataUri(
			readAssetFile('kody-pattern-dark.png'),
		),
		kodyPatternLightDataUri: bytesToPngDataUri(
			readAssetFile('kody-pattern-light.png'),
		),
		kodyHeroDataUri: bytesToPngDataUri(readAssetFile('kody-hero.png')),
		kodyLogoDataUri: bytesToPngDataUri(readAssetFile('kody-logo.png')),
	}
	return cache
}

/** Test hook: clears the per-process OG binary asset cache. */
export function resetOgBinaryAssetsCache() {
	cache = null
}

export async function ensureOgBinaryAssetsReady(_input?: {
	assets?: OgAssetsFetcher
}): Promise<void> {
	ensureCache()
}

export function getBricolageGrotesqueLatin700FontData(): ArrayBuffer {
	return ensureCache().bricolageGrotesqueLatin700
}

export function getWixMadeforTextLatin400FontData(): ArrayBuffer {
	return ensureCache().wixMadeforTextLatin400
}

export function getKodyPatternDataUri(theme: 'light' | 'dark'): string {
	const loaded = ensureCache()
	return theme === 'light'
		? loaded.kodyPatternLightDataUri
		: loaded.kodyPatternDarkDataUri
}

export function getKodyHeroDataUri(): string {
	return ensureCache().kodyHeroDataUri
}

export function getKodyLogoDataUri(): string {
	return ensureCache().kodyLogoDataUri
}
