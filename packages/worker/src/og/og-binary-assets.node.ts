import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import {
	landingOrbitAgents,
	type LandingOrbitAgentIcon,
} from '#universal/landing-agent-orbit.ts'
import { type OgTheme } from '#worker/og/palette.ts'

const publicOgDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../public/og',
)

const AGENT_ICON_IDS = landingOrbitAgents.map((agent) => agent.icon)

type AgentIconDataUris = Record<
	LandingOrbitAgentIcon,
	{ light: string; dark: string }
>

type OgBinaryAssetCache = {
	bricolageGrotesqueLatin700: ArrayBuffer
	wixMadeforTextLatin400: ArrayBuffer
	kodyPatternDarkDataUri: string
	kodyPatternLightDataUri: string
	kodyLanternBaseDataUri: string
	kodyDiscordDataUri: string
	kodyLogoDataUri: string
	agentIconDataUris: AgentIconDataUris
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

function loadAgentIconDataUris(): AgentIconDataUris {
	const agentIconDataUris = {} as AgentIconDataUris
	for (const icon of AGENT_ICON_IDS) {
		agentIconDataUris[icon] = {
			light: bytesToPngDataUri(
				readAssetFile(join('agent-icons', 'light', `${icon}.png`)),
			),
			dark: bytesToPngDataUri(
				readAssetFile(join('agent-icons', 'dark', `${icon}.png`)),
			),
		}
	}
	return agentIconDataUris
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
		kodyLanternBaseDataUri: bytesToPngDataUri(
			readAssetFile('kody-lantern-base.png'),
		),
		kodyDiscordDataUri: bytesToPngDataUri(readAssetFile('kody-discord.png')),
		kodyLogoDataUri: bytesToPngDataUri(readAssetFile('kody-logo.png')),
		agentIconDataUris: loadAgentIconDataUris(),
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

export function getKodyLanternBaseDataUri(): string {
	return ensureCache().kodyLanternBaseDataUri
}

export function getLandingAgentIconDataUri(
	icon: LandingOrbitAgentIcon,
	theme: OgTheme,
): string {
	return ensureCache().agentIconDataUris[icon][theme]
}

export function getKodyDiscordDataUri(): string {
	return ensureCache().kodyDiscordDataUri
}

export function getKodyLogoDataUri(): string {
	return ensureCache().kodyLogoDataUri
}
