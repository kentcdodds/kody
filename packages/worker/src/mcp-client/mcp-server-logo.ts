import { toHex } from '@kody-internal/shared/hex.ts'
import { routes } from '#universal/routes.ts'
import {
	processPlatformOauthAppLogo,
	type PlatformOauthAppLogoContentType,
} from '#worker/integrations/platform-app-logo.ts'
import { getMcpServerSettingRowById } from './settings-repo.ts'
import { type McpServerLogoSource } from './settings-types.ts'

export const mcpServerLogoR2KeyPrefix = 'user-mcp-server-logos/'
const mcpServerLogoCacheControl = 'private, no-store'

/**
 * Relative serving path for a user-added MCP server favicon. `v` is the
 * content hash so a re-fetch busts the private cache key.
 */
export function buildMcpServerLogoPath(server: {
	id: string
	logoKey: string | null
}): string | null {
	if (!server.logoKey) return null
	const contentTag = /\/([0-9a-f]{16})[^/]*$/.exec(server.logoKey)?.[1]
	return routes.accountMcpServerLogo.href(
		{ serverId: server.id },
		contentTag ? { searchParams: { v: contentTag } } : undefined,
	)
}

export function buildMcpServerAutoLogoPath(server: {
	id: string
	logoKey?: string | null
}): string | null {
	return buildMcpServerLogoPath({
		id: server.id,
		logoKey: server.logoKey ?? null,
	})
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

export async function setMcpServerLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	userId: string
	serverId: string
	sourceBytes: Uint8Array
	source: McpServerLogoSource
	faviconSourceHost: string
}): Promise<void> {
	const existing = await getMcpServerSettingRowById({
		db: input.db,
		userId: input.userId,
		id: input.serverId,
	})
	if (!existing) return
	const previousKey = existing.logo_key
	const processed = await processPlatformOauthAppLogo(input.sourceBytes)
	const contentHash = (await sha256Hex(processed.bytes)).slice(0, 16)
	const nextKey = `${mcpServerLogoR2KeyPrefix}${input.userId}/${existing.id}/${contentHash}.${extensionForContentType(processed.contentType)}`
	await input.env.COMMUNITY_ASSETS.put(nextKey, processed.bytes, {
		httpMetadata: {
			contentType: processed.contentType,
			cacheControl: mcpServerLogoCacheControl,
		},
		customMetadata: {
			userId: input.userId,
			mcpServerId: existing.id,
			logoSource: input.source,
			contentHash,
		},
	})

	const updated = await input.db
		.prepare(
			`UPDATE mcp_server_settings
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND id = ?`,
		)
		.bind(
			nextKey,
			processed.contentType,
			input.source,
			input.faviconSourceHost,
			new Date().toISOString(),
			input.userId,
			existing.id,
		)
		.run()

	if ((updated.meta.changes ?? 0) === 0) {
		try {
			await input.env.COMMUNITY_ASSETS.delete(nextKey)
		} catch (error) {
			console.error(
				'mcp-server-logo-raced-favicon-delete-failed',
				nextKey,
				error,
			)
		}
		return
	}

	if (previousKey && previousKey !== nextKey) {
		try {
			await input.env.COMMUNITY_ASSETS.delete(previousKey)
		} catch (error) {
			console.error(
				'mcp-server-logo-previous-delete-failed',
				previousKey,
				error,
			)
		}
	}
}

export async function deleteMcpServerLogoAsset(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string | null
}) {
	if (!input.logoKey) return
	if (!input.logoKey.startsWith(mcpServerLogoR2KeyPrefix)) return
	try {
		await input.env.COMMUNITY_ASSETS.delete(input.logoKey)
	} catch (error) {
		console.error('mcp-server-logo-delete-failed', input.logoKey, error)
	}
}

export async function getMcpServerLogoObject(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string
}): Promise<R2ObjectBody | null> {
	if (!input.logoKey.startsWith(mcpServerLogoR2KeyPrefix)) return null
	return await input.env.COMMUNITY_ASSETS.get(input.logoKey)
}
