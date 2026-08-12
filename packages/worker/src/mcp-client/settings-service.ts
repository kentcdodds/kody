import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	isValidMcpServerName,
	mcpServerAuthorizationHeaders,
	normalizeMcpServerBearerToken,
	normalizeMcpServerName,
	validateMcpServerUrl,
	type McpServerRef,
} from '@kody-internal/shared/mcp-servers.ts'
import { getCanonicalAppBaseUrl } from '#worker/app-base-url.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { createMcpClientHubClient } from './hub-client.ts'
import {
	deleteMcpServerSettingRow,
	getMcpServerSettingRowById,
	getMcpServerSettingRowByName,
	insertMcpServerSettingRow,
	listEnabledMcpServerSettingRows,
	listMcpServerSettingRows,
	updateMcpServerSettingRow,
} from './settings-repo.ts'
import {
	type McpServerSettingMetadata,
	type McpServerSettingRow,
} from './settings-types.ts'
import { type McpServerConnectResult } from './types.ts'

export const mcpServerOAuthCallbackPath = '/account/mcp-servers/oauth/callback'

export function buildMcpServerOAuthCallbackUrl(baseUrl: string) {
	const origin = baseUrl.trim().replace(/\/+$/, '')
	return `${origin}${mcpServerOAuthCallbackPath}`
}

/**
 * Stable OAuth client origin + callback for user-added MCP servers.
 *
 * Prefer the configured canonical `APP_BASE_URL` (not the request host) so
 * dynamic client registration always advertises one allowlistable redirect URI
 * during dual-host domain migrations.
 */
export function resolveMcpServerOAuthClientUrls(input: {
	env: { APP_BASE_URL?: string | null; PACKAGE_APP_BASE_URL?: string | null }
	requestUrl?: string | URL | null
}) {
	const clientOrigin = getCanonicalAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	return {
		clientOrigin,
		callbackUrl: buildMcpServerOAuthCallbackUrl(clientOrigin),
	}
}

function toMetadata(row: McpServerSettingRow): McpServerSettingMetadata {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		enabled: row.enabled,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export async function listMcpServerSettings(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<McpServerSettingMetadata>> {
	const rows = await listMcpServerSettingRows({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows.map(toMetadata)
}

export async function listEnabledMcpServerRefs(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<McpServerRef>> {
	const rows = await listEnabledMcpServerSettingRows({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows.map((row) => ({
		serverId: row.id,
		name: row.name,
	}))
}

export const enabledMcpServerRefsCacheTtlMs = 30_000
export const enabledMcpServerRefsCacheLimit = 200

function createEnabledMcpServerRefsCache() {
	return new PromiseLruCache<ReadonlyArray<McpServerRef>>({
		ttlMs: enabledMcpServerRefsCacheTtlMs,
		limit: enabledMcpServerRefsCacheLimit,
	})
}

let enabledMcpServerRefsCache = createEnabledMcpServerRefsCache()

/**
 * Short-TTL per-user cache over {@link listEnabledMcpServerRefs} for hot
 * invocation paths (capability-registry / runtime metadata assembly, which
 * otherwise pay this D1 read on every run). Mutations in this module
 * invalidate eagerly, so the same-isolate staleness after add / enable /
 * delete is zero; other isolates converge within the TTL — the same bound
 * the MCP hub and remote-connector snapshot caches already use. Settings UI
 * reads should keep using the uncached functions.
 */
export function listEnabledMcpServerRefsCached(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<ReadonlyArray<McpServerRef>> {
	return enabledMcpServerRefsCache.getOrCreate({
		cacheKey: input.userId,
		create: async () => Object.freeze(await listEnabledMcpServerRefs(input)),
	})
}

function invalidateEnabledMcpServerRefsCache(input: { userId: string }) {
	enabledMcpServerRefsCache.delete(input.userId)
}

export function clearEnabledMcpServerRefsCacheForTests() {
	enabledMcpServerRefsCache = createEnabledMcpServerRefsCache()
}

function validateNameOrThrow(name: string) {
	const normalized = normalizeMcpServerName(name)
	if (!normalized) {
		throw new Error('Server name is required.')
	}
	if (!isValidMcpServerName(normalized)) {
		throw new Error(
			'Server name must use lowercase letters, numbers, and dashes; start and end with a letter or number; and be at most 64 characters.',
		)
	}
	return normalized
}

export async function addMcpServer(input: {
	env: Env
	userId: string
	name: string
	url: string
	baseUrl: string
	/**
	 * Optional static credential for servers that authenticate with a bearer
	 * token (or other Authorization scheme) instead of OAuth. Never stored in
	 * D1 — only forwarded into the hub DO's Agents SDK server options.
	 */
	bearerToken?: string | null
}): Promise<{
	setting: McpServerSettingMetadata
	connection: McpServerConnectResult
}> {
	const name = validateNameOrThrow(input.name)
	const urlValidation = validateMcpServerUrl(input.url)
	if (!urlValidation.ok || !urlValidation.url) {
		throw new Error(urlValidation.error ?? 'Server URL is invalid.')
	}
	const tokenValidation = normalizeMcpServerBearerToken(input.bearerToken)
	if (!tokenValidation.ok) {
		throw new Error(tokenValidation.error ?? 'Bearer token is invalid.')
	}
	const headers = mcpServerAuthorizationHeaders(tokenValidation.authorization)
	const existing = await getMcpServerSettingRowByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (existing) {
		throw new Error('An MCP server with this name already exists.')
	}

	const now = new Date().toISOString()
	const row = {
		id: crypto.randomUUID(),
		user_id: input.userId,
		name,
		url: urlValidation.url,
		enabled: true,
		created_at: now,
		updated_at: now,
	} satisfies McpServerSettingRow

	const hub = createMcpClientHubClient({
		env: input.env,
		userId: input.userId,
	})
	let connection: McpServerConnectResult
	try {
		connection = await hub.addServer({
			serverId: row.id,
			name,
			url: urlValidation.url,
			callbackUrl: buildMcpServerOAuthCallbackUrl(input.baseUrl),
			...(headers ? { headers } : {}),
		})
	} catch (error) {
		const message = getErrorMessage(error)
		throw new Error(`Unable to connect to MCP server: ${message}`)
	}
	try {
		await insertMcpServerSettingRow({ db: input.env.APP_DB, row })
	} catch (error) {
		// Roll back the hub registration so a failed insert does not leave
		// orphaned connection state (or OAuth data) with no D1 record to
		// manage it.
		await hub.removeServer({ serverId: row.id }).catch(() => {})
		throw error
	}
	invalidateEnabledMcpServerRefsCache({ userId: input.userId })
	return {
		setting: toMetadata(row),
		connection,
	}
}

export async function setMcpServerEnabled(input: {
	env: Env
	userId: string
	id: string
	enabled: boolean
}): Promise<McpServerSettingMetadata> {
	const existing = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	if (!existing) {
		throw new Error('MCP server setting not found.')
	}
	const now = new Date().toISOString()
	const row = {
		...existing,
		enabled: input.enabled,
		updated_at: now,
	} satisfies McpServerSettingRow
	const updated = await updateMcpServerSettingRow({
		db: input.env.APP_DB,
		row,
	})
	if (!updated) {
		throw new Error('MCP server setting not found.')
	}
	invalidateEnabledMcpServerRefsCache({ userId: input.userId })
	return toMetadata(row)
}

export async function deleteMcpServer(input: {
	env: Env
	userId: string
	id: string
}): Promise<boolean> {
	const existing = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	if (!existing) return false
	const hub = createMcpClientHubClient({
		env: input.env,
		userId: input.userId,
	})
	await hub.removeServer({ serverId: input.id })
	const deleted = await deleteMcpServerSettingRow({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	invalidateEnabledMcpServerRefsCache({ userId: input.userId })
	return deleted
}

export async function getMcpServerSettingById(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	id: string
}): Promise<McpServerSettingMetadata | null> {
	const row = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	return row ? toMetadata(row) : null
}
