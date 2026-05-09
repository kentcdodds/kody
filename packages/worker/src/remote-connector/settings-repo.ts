import { type RemoteConnectorSettingRow } from './settings-types.ts'

export async function listRemoteConnectorSettingRows(input: {
	db: D1Database
	userId: string
}): Promise<Array<RemoteConnectorSettingRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT id, user_id, kind, instance_id, enabled, attached, encrypted_shared_secret, created_at, updated_at
			FROM remote_connector_settings
			WHERE user_id = ?
			ORDER BY kind ASC, instance_id ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRemoteConnectorSettingRow)
}

export async function listAttachedRemoteConnectorSettingRows(input: {
	db: D1Database
	userId: string
}): Promise<Array<RemoteConnectorSettingRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT id, user_id, kind, instance_id, enabled, attached, encrypted_shared_secret, created_at, updated_at
			FROM remote_connector_settings
			WHERE user_id = ? AND enabled = 1 AND attached = 1
			ORDER BY kind ASC, instance_id ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRemoteConnectorSettingRow)
}

export async function listRemoteConnectorSharedSecretRows(input: {
	db: D1Database
	userId: string
	kind: string
	instanceId: string
}): Promise<Array<RemoteConnectorSettingRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT id, user_id, kind, instance_id, enabled, attached, encrypted_shared_secret, created_at, updated_at
			FROM remote_connector_settings
			WHERE user_id = ? AND kind = ? AND instance_id = ? AND enabled = 1
				AND encrypted_shared_secret IS NOT NULL
			ORDER BY updated_at DESC`,
		)
		.bind(input.userId, input.kind, input.instanceId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRemoteConnectorSettingRow)
}

export async function getRemoteConnectorSettingRowById(input: {
	db: D1Database
	userId: string
	id: string
}): Promise<RemoteConnectorSettingRow | null> {
	const row = await input.db
		.prepare(
			`SELECT id, user_id, kind, instance_id, enabled, attached, encrypted_shared_secret, created_at, updated_at
			FROM remote_connector_settings
			WHERE user_id = ? AND id = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.id)
		.first<Record<string, unknown>>()
	return row ? mapRemoteConnectorSettingRow(row) : null
}

export async function getRemoteConnectorSettingRowByRef(input: {
	db: D1Database
	userId: string
	kind: string
	instanceId: string
}): Promise<RemoteConnectorSettingRow | null> {
	const row = await input.db
		.prepare(
			`SELECT id, user_id, kind, instance_id, enabled, attached, encrypted_shared_secret, created_at, updated_at
			FROM remote_connector_settings
			WHERE user_id = ? AND kind = ? AND instance_id = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.kind, input.instanceId)
		.first<Record<string, unknown>>()
	return row ? mapRemoteConnectorSettingRow(row) : null
}

export async function upsertRemoteConnectorSettingRow(input: {
	db: D1Database
	row: Omit<RemoteConnectorSettingRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO remote_connector_settings (
				id, user_id, kind, instance_id, enabled, attached, encrypted_shared_secret, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, kind, instance_id)
			DO UPDATE SET
				enabled = excluded.enabled,
				attached = excluded.attached,
				encrypted_shared_secret = excluded.encrypted_shared_secret,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.id,
			input.row.user_id,
			input.row.kind,
			input.row.instance_id,
			input.row.enabled ? 1 : 0,
			input.row.attached ? 1 : 0,
			input.row.encrypted_shared_secret,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function updateRemoteConnectorSettingRow(input: {
	db: D1Database
	row: Omit<RemoteConnectorSettingRow, 'created_at' | 'updated_at'> & {
		updated_at?: string
	}
}): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE remote_connector_settings
			SET kind = ?,
				instance_id = ?,
				enabled = ?,
				attached = ?,
				encrypted_shared_secret = ?,
				updated_at = ?
			WHERE user_id = ? AND id = ?`,
		)
		.bind(
			input.row.kind,
			input.row.instance_id,
			input.row.enabled ? 1 : 0,
			input.row.attached ? 1 : 0,
			input.row.encrypted_shared_secret,
			input.row.updated_at ?? now,
			input.row.user_id,
			input.row.id,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteRemoteConnectorSettingRow(input: {
	db: D1Database
	userId: string
	id: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`DELETE FROM remote_connector_settings WHERE user_id = ? AND id = ?`,
		)
		.bind(input.userId, input.id)
		.run()
	return (result.meta.changes ?? 0) > 0
}

function mapRemoteConnectorSettingRow(
	row: Record<string, unknown>,
): RemoteConnectorSettingRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		kind: String(row['kind']),
		instance_id: String(row['instance_id']),
		enabled: Boolean(Number(row['enabled'])),
		attached: Boolean(Number(row['attached'])),
		encrypted_shared_secret:
			row['encrypted_shared_secret'] == null
				? null
				: String(row['encrypted_shared_secret']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}
