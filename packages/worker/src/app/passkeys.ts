export type PasskeyRow = {
	id: string
	aaguid: string
	public_key: string
	user_id: number
	webauthn_user_handle: string
	counter: number
	device_type: string
	backed_up: number
	transports: string | null
	name: string
	created_at: string
	last_used_at: string | null
}

const passkeySelectColumns = `id, aaguid, public_key, user_id, webauthn_user_handle, counter,
				device_type, backed_up, transports, name, created_at, last_used_at`

export async function listPasskeysForUser(db: D1Database, userId: number) {
	const result = await db
		.prepare(
			`SELECT ${passkeySelectColumns}
			 FROM passkeys
			 WHERE user_id = ?
			 ORDER BY created_at DESC, id DESC`,
		)
		.bind(userId)
		.all<PasskeyRow>()
	return result.results
}

export async function findPasskeyById(db: D1Database, id: string) {
	return db
		.prepare(
			`SELECT ${passkeySelectColumns}
			 FROM passkeys
			 WHERE id = ?`,
		)
		.bind(id)
		.first<PasskeyRow>()
}

export async function createPasskey(
	db: D1Database,
	input: {
		id: string
		aaguid: string
		publicKey: string
		userId: number
		webauthnUserId: string
		counter: number
		deviceType: string
		backedUp: boolean
		transports: string | null
		name: string
	},
) {
	await db
		.prepare(
			`INSERT INTO passkeys (
				id, aaguid, public_key, user_id, webauthn_user_handle, counter,
				device_type, backed_up, transports, name
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.aaguid,
			input.publicKey,
			input.userId,
			input.webauthnUserId,
			input.counter,
			input.deviceType,
			input.backedUp ? 1 : 0,
			input.transports,
			input.name,
		)
		.run()
}

export async function updatePasskeyCounter(
	db: D1Database,
	id: string,
	counter: number,
) {
	await db
		.prepare(
			`UPDATE passkeys
			 SET counter = ?, last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
			 WHERE id = ?`,
		)
		.bind(counter, id)
		.run()
}

/** Ownership is enforced in the WHERE clause: cross-user renames are no-ops. */
export async function renamePasskeyForUser(
	db: D1Database,
	id: string,
	userId: number,
	name: string,
) {
	const result = await db
		.prepare(
			`UPDATE passkeys
			 SET name = ?, updated_at = CURRENT_TIMESTAMP
			 WHERE id = ? AND user_id = ?`,
		)
		.bind(name, id, userId)
		.run()
	return (result.meta?.changes ?? 0) > 0
}

/** Ownership is enforced in the WHERE clause: cross-user deletes are no-ops. */
export async function deletePasskeyForUser(
	db: D1Database,
	id: string,
	userId: number,
) {
	const result = await db
		.prepare(`DELETE FROM passkeys WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run()
	return (result.meta?.changes ?? 0) > 0
}
