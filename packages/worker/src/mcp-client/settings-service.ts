import {
	isValidMcpServerName,
	normalizeMcpServerName,
	validateMcpServerUrl,
	type McpServerRef,
} from '@kody-internal/shared/mcp-servers.ts'
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
}): Promise<{
	setting: McpServerSettingMetadata
	connection: McpServerConnectResult
}> {
	const name = validateNameOrThrow(input.name)
	const urlValidation = validateMcpServerUrl(input.url)
	if (!urlValidation.ok || !urlValidation.url) {
		throw new Error(urlValidation.error ?? 'Server URL is invalid.')
	}
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
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
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
	return deleteMcpServerSettingRow({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
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
