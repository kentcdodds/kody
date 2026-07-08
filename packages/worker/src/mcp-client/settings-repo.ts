import { type McpServerSettingRow } from './settings-types.ts'

const selectColumns = 'id, user_id, name, url, enabled, created_at, updated_at'

export async function listMcpServerSettingRows(input: {
	db: D1Database
	userId: string
}): Promise<Array<McpServerSettingRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT ${selectColumns}
			FROM mcp_server_settings
			WHERE user_id = ?
			ORDER BY name ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapMcpServerSettingRow)
}

export async function listEnabledMcpServerSettingRows(input: {
	db: D1Database
	userId: string
}): Promise<Array<McpServerSettingRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT ${selectColumns}
			FROM mcp_server_settings
			WHERE user_id = ? AND enabled = 1
			ORDER BY name ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapMcpServerSettingRow)
}

export async function getMcpServerSettingRowById(input: {
	db: D1Database
	userId: string
	id: string
}): Promise<McpServerSettingRow | null> {
	const row = await input.db
		.prepare(
			`SELECT ${selectColumns}
			FROM mcp_server_settings
			WHERE user_id = ? AND id = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.id)
		.first<Record<string, unknown>>()
	return row ? mapMcpServerSettingRow(row) : null
}

export async function getMcpServerSettingRowByName(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<McpServerSettingRow | null> {
	const row = await input.db
		.prepare(
			`SELECT ${selectColumns}
			FROM mcp_server_settings
			WHERE user_id = ? AND name = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<Record<string, unknown>>()
	return row ? mapMcpServerSettingRow(row) : null
}

export async function insertMcpServerSettingRow(input: {
	db: D1Database
	row: Omit<McpServerSettingRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO mcp_server_settings (
				id, user_id, name, url, enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.row.id,
			input.row.user_id,
			input.row.name,
			input.row.url,
			input.row.enabled ? 1 : 0,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function updateMcpServerSettingRow(input: {
	db: D1Database
	row: Omit<McpServerSettingRow, 'created_at' | 'updated_at'> & {
		updated_at?: string
	}
}): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE mcp_server_settings
			SET name = ?,
				url = ?,
				enabled = ?,
				updated_at = ?
			WHERE user_id = ? AND id = ?`,
		)
		.bind(
			input.row.name,
			input.row.url,
			input.row.enabled ? 1 : 0,
			input.row.updated_at ?? now,
			input.row.user_id,
			input.row.id,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteMcpServerSettingRow(input: {
	db: D1Database
	userId: string
	id: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(`DELETE FROM mcp_server_settings WHERE user_id = ? AND id = ?`)
		.bind(input.userId, input.id)
		.run()
	return (result.meta.changes ?? 0) > 0
}

function mapMcpServerSettingRow(
	row: Record<string, unknown>,
): McpServerSettingRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		name: String(row['name']),
		url: String(row['url']),
		enabled: Boolean(Number(row['enabled'])),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}
