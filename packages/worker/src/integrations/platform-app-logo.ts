import { toHex } from '@kody-internal/shared/hex.ts'
import { processCommunityIcon } from '#worker/community/community-icon.ts'
import {
	getPlatformOauthAppBySlug,
	type PlatformOauthApp,
} from './platform-apps.ts'

const platformOauthAppLogoR2KeyPrefix = 'platform-oauth-app-logos/'
const platformOauthAppLogoCacheControl = 'public, max-age=31536000, immutable'
const maxPlatformOauthAppLogoSourceBytes = 1_000_000

export type PlatformOauthAppLogoContentType =
	| 'image/png'
	| 'image/jpeg'
	| 'image/webp'

type ProcessedPlatformOauthAppLogo = {
	bytes: Uint8Array
	contentType: PlatformOauthAppLogoContentType
}

/**
 * Relative serving path for a platform app logo. The `v` parameter carries
 * the content hash from the R2 key so the immutable cache busts on upload.
 */
export function buildPlatformOauthAppLogoPath(app: {
	slug: string
	logoKey: string | null
}): string | null {
	if (!app.logoKey) return null
	const contentTag = /\/([0-9a-f]{16})[^/]*$/.exec(app.logoKey)?.[1]
	return `/integrations/logos/${encodeURIComponent(app.slug)}${
		contentTag ? `?v=${contentTag}` : ''
	}`
}

/**
 * Detects the upload format from magic bytes. SVG is accepted as *input*
 * only: it is sanitized and rasterized to PNG by `processCommunityIcon`, so
 * an active image format is never stored or served.
 */
export function sniffPlatformOauthAppLogoFormat(
	bytes: Uint8Array,
): 'svg' | 'png' | 'jpeg' | 'webp' | null {
	if (bytes.byteLength < 4) return null
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'png'
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
	if (
		bytes.byteLength >= 16 &&
		String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
		String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
	) {
		return 'webp'
	}
	try {
		const head = new TextDecoder('utf-8', { fatal: true })
			.decode(bytes.slice(0, 1024))
			.trimStart()
		if (head.startsWith('<')) return 'svg'
	} catch {
		return null
	}
	return null
}

export async function processPlatformOauthAppLogo(
	sourceBytes: Uint8Array,
): Promise<ProcessedPlatformOauthAppLogo> {
	if (
		sourceBytes.byteLength === 0 ||
		sourceBytes.byteLength > maxPlatformOauthAppLogoSourceBytes
	) {
		throw new Error(
			`Platform app logos must be between 1 byte and ${maxPlatformOauthAppLogoSourceBytes} bytes.`,
		)
	}
	const format = sniffPlatformOauthAppLogoFormat(sourceBytes)
	if (!format) {
		throw new Error('Platform app logos must be SVG, PNG, JPEG, or WebP.')
	}
	const path = (
		{
			svg: 'community-icon.svg',
			png: 'community-icon.png',
			jpeg: 'community-icon.jpeg',
			webp: 'community-icon.webp',
		} as const
	)[format]
	const processed = await processCommunityIcon({ path, sourceBytes })
	return {
		bytes: processed.bytes,
		contentType: processed.contentType,
	}
}

function extensionForContentType(contentType: PlatformOauthAppLogoContentType) {
	switch (contentType) {
		case 'image/png':
			return 'png'
		case 'image/jpeg':
			return 'jpg'
		case 'image/webp':
			return 'webp'
		default: {
			const unreachable: never = contentType
			throw new Error(`Unsupported logo content type: ${unreachable}`)
		}
	}
}

async function sha256Hex(bytes: Uint8Array) {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	const digest = await crypto.subtle.digest('SHA-256', copy)
	return toHex(new Uint8Array(digest))
}

/**
 * Upload (sourceBytes) or clear (null) the operator logo for a platform app.
 * Assets are operator-owned like the app row itself: content-hashed keys in
 * COMMUNITY_ASSETS, immutable cache headers, previous asset deleted after a
 * successful column update.
 */
export async function setPlatformOauthAppLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	slug: string
	sourceBytes: Uint8Array | null
}): Promise<PlatformOauthApp> {
	const app = await getPlatformOauthAppBySlug({
		db: input.db,
		slug: input.slug,
		includeDisabled: true,
	})
	if (!app) {
		throw new Error(`Platform OAuth app "${input.slug}" was not found.`)
	}
	const previousKey = app.logoKey

	let nextKey: string | null = null
	let nextContentType: PlatformOauthAppLogoContentType | null = null
	if (input.sourceBytes) {
		const processed = await processPlatformOauthAppLogo(input.sourceBytes)
		const contentHash = (await sha256Hex(processed.bytes)).slice(0, 16)
		nextKey = `${platformOauthAppLogoR2KeyPrefix}${app.slug}/${contentHash}.${extensionForContentType(processed.contentType)}`
		nextContentType = processed.contentType
		await input.env.COMMUNITY_ASSETS.put(nextKey, processed.bytes, {
			httpMetadata: {
				contentType: processed.contentType,
				cacheControl: platformOauthAppLogoCacheControl,
			},
			customMetadata: {
				platformAppSlug: app.slug,
				contentHash,
			},
		})
	}

	await input.db
		.prepare(
			`UPDATE platform_oauth_apps
			SET logo_key = ?, logo_content_type = ?, updated_at = ?
			WHERE slug = ?`,
		)
		.bind(nextKey, nextContentType, new Date().toISOString(), app.slug)
		.run()

	if (previousKey && previousKey !== nextKey) {
		try {
			await input.env.COMMUNITY_ASSETS.delete(previousKey)
		} catch (error) {
			console.error(
				'platform-oauth-app-logo-previous-delete-failed',
				previousKey,
				error,
			)
		}
	}

	const saved = await getPlatformOauthAppBySlug({
		db: input.db,
		slug: app.slug,
		includeDisabled: true,
	})
	if (!saved) {
		throw new Error(
			`Platform OAuth app "${app.slug}" disappeared during logo update.`,
		)
	}
	return saved
}

/** Deletes the logo asset when a platform app row is removed. */
export async function deletePlatformOauthAppLogoAsset(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string | null
}) {
	if (!input.logoKey) return
	if (!input.logoKey.startsWith(platformOauthAppLogoR2KeyPrefix)) return
	try {
		await input.env.COMMUNITY_ASSETS.delete(input.logoKey)
	} catch (error) {
		console.error('platform-oauth-app-logo-delete-failed', input.logoKey, error)
	}
}

export async function getPlatformOauthAppLogoObject(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string
}): Promise<R2ObjectBody | null> {
	if (!input.logoKey.startsWith(platformOauthAppLogoR2KeyPrefix)) return null
	return await input.env.COMMUNITY_ASSETS.get(input.logoKey)
}
