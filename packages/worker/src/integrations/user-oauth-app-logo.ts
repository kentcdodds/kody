import { toHex } from '@kody-internal/shared/hex.ts'
import { routes } from '#universal/routes.ts'
import { getOauthAppBySlug } from './repo.ts'
import {
	processPlatformOauthAppLogo,
	type PlatformOauthAppLogoContentType,
} from './platform-app-logo.ts'
import { type UserOauthApp } from './types.ts'

export const userOauthAppLogoR2KeyPrefix = 'user-oauth-app-logos/'
const userOauthAppLogoCacheControl = 'private, max-age=31536000, immutable'

export type UserOauthAppLogoSource = 'upload' | 'favicon'

/**
 * Relative serving path for a user-lane OAuth app logo. Uses the same
 * public route as platform logos; the handler resolves the signed-in
 * user's app after a platform miss. `v` is the content hash.
 */
export function buildUserOauthAppLogoPath(app: {
	slug: string
	logoKey: string | null
}): string | null {
	if (!app.logoKey) return null
	const contentTag = /\/([0-9a-f]{16})[^/]*$/.exec(app.logoKey)?.[1]
	return routes.integrationLogo.href(
		{ integrationSlug: app.slug },
		contentTag ? { searchParams: { v: contentTag } } : undefined,
	)
}

export function buildUserOauthAppLogoPaths(app: {
	slug: string
	logoKey?: string | null
	logoSource?: UserOauthAppLogoSource | null
}): { logoPath: string | null; autoLogoPath: string | null } {
	const path = buildUserOauthAppLogoPath({
		slug: app.slug,
		logoKey: app.logoKey ?? null,
	})
	if (!path || !app.logoSource) {
		return { logoPath: null, autoLogoPath: null }
	}
	if (app.logoSource === 'upload') {
		return { logoPath: path, autoLogoPath: null }
	}
	return { logoPath: null, autoLogoPath: path }
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

export async function setUserOauthAppLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	userId: string
	slug: string
	sourceBytes: Uint8Array | null
	source: UserOauthAppLogoSource
	faviconSourceHost?: string | null
}): Promise<UserOauthApp> {
	const app = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: input.slug,
	})
	if (!app) {
		throw new Error(`OAuth app "${input.slug}" was not found.`)
	}
	// Favicon fill is async; a user upload that lands while we are fetching
	// must win. Re-read happens here so the write itself is the guard.
	if (
		input.source === 'favicon' &&
		app.logoSource === 'upload' &&
		app.logoKey
	) {
		return app
	}
	const previousKey = app.logoKey

	let nextKey: string | null = null
	let nextContentType: PlatformOauthAppLogoContentType | null = null
	let nextSource: UserOauthAppLogoSource | null = null
	let nextFaviconHost: string | null = null
	if (input.sourceBytes) {
		const processed = await processPlatformOauthAppLogo(input.sourceBytes)
		const contentHash = (await sha256Hex(processed.bytes)).slice(0, 16)
		nextKey = `${userOauthAppLogoR2KeyPrefix}${input.userId}/${app.slug}/${contentHash}.${extensionForContentType(processed.contentType)}`
		nextContentType = processed.contentType
		nextSource = input.source
		nextFaviconHost =
			input.source === 'favicon' ? (input.faviconSourceHost ?? null) : null
		await input.env.COMMUNITY_ASSETS.put(nextKey, processed.bytes, {
			httpMetadata: {
				contentType: processed.contentType,
				cacheControl: userOauthAppLogoCacheControl,
			},
			customMetadata: {
				userId: input.userId,
				userAppSlug: app.slug,
				logoSource: input.source,
				contentHash,
			},
		})
	}

	await input.db
		.prepare(
			`UPDATE user_oauth_apps
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND slug = ?`,
		)
		.bind(
			nextKey,
			nextContentType,
			nextSource,
			nextFaviconHost,
			new Date().toISOString(),
			input.userId,
			app.slug,
		)
		.run()

	if (previousKey && previousKey !== nextKey) {
		try {
			await input.env.COMMUNITY_ASSETS.delete(previousKey)
		} catch (error) {
			console.error(
				'user-oauth-app-logo-previous-delete-failed',
				previousKey,
				error,
			)
		}
	}

	const saved = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: app.slug,
	})
	if (!saved) {
		throw new Error(`OAuth app "${app.slug}" disappeared during logo update.`)
	}
	return saved
}

export async function deleteUserOauthAppLogoAsset(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string | null
}) {
	if (!input.logoKey) return
	if (!input.logoKey.startsWith(userOauthAppLogoR2KeyPrefix)) return
	try {
		await input.env.COMMUNITY_ASSETS.delete(input.logoKey)
	} catch (error) {
		console.error('user-oauth-app-logo-delete-failed', input.logoKey, error)
	}
}

export async function getUserOauthAppLogoObject(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string
}): Promise<R2ObjectBody | null> {
	if (!input.logoKey.startsWith(userOauthAppLogoR2KeyPrefix)) return null
	return await input.env.COMMUNITY_ASSETS.get(input.logoKey)
}
