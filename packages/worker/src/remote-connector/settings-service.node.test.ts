import { expect, test } from 'vitest'
import { remoteConnectorSharedSecretMatches } from './resolve-remote-connector-secret.ts'
import {
	deleteRemoteConnectorSetting,
	listAttachedRemoteConnectorRefs,
	listRemoteConnectorSettings,
	listRemoteConnectorSettingsWithSharedSecrets,
	saveRemoteConnectorSetting,
} from './settings-service.ts'
import { type RemoteConnectorSettingRow } from './settings-types.ts'

function createRemoteConnectorSettingsTestDb() {
	const rows = new Map<string, RemoteConnectorSettingRow>()

	function clone(row: RemoteConnectorSettingRow) {
		return { ...row }
	}

	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalizedQuery.includes('from remote_connector_settings') &&
								normalizedQuery.includes('where user_id = ? and id = ?')
							) {
								const [userId, id] = params as Array<string>
								const row = rows.get(id)
								return row && row.user_id === userId ? (clone(row) as T) : null
							}
							if (
								normalizedQuery.includes('from remote_connector_settings') &&
								normalizedQuery.includes(
									'where user_id = ? and kind = ? and instance_id = ?',
								)
							) {
								const [userId, kind, instanceId] = params as Array<string>
								const row =
									Array.from(rows.values()).find(
										(candidate) =>
											candidate.user_id === userId &&
											candidate.kind === kind &&
											candidate.instance_id === instanceId,
									) ?? null
								return row ? (clone(row) as T) : null
							}
							return null
						},
						async all<T>() {
							if (
								normalizedQuery.includes('from remote_connector_settings') &&
								normalizedQuery.includes('where user_id = ? and enabled = 1')
							) {
								const [userId] = params as Array<string>
								const results = Array.from(rows.values())
									.filter(
										(row) =>
											row.user_id === userId && row.enabled && row.attached,
									)
									.sort(
										(left, right) =>
											left.kind.localeCompare(right.kind) ||
											left.instance_id.localeCompare(right.instance_id),
									)
									.map(clone)
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								normalizedQuery.includes('from remote_connector_settings') &&
								normalizedQuery.includes(
									'where user_id = ? and kind = ? and instance_id = ? and enabled = 1',
								)
							) {
								const [userId, kind, instanceId] = params as Array<string>
								const results = Array.from(rows.values())
									.filter(
										(row) =>
											row.user_id === userId &&
											row.kind === kind &&
											row.instance_id === instanceId &&
											row.enabled &&
											row.encrypted_shared_secret,
									)
									.sort((left, right) =>
										right.updated_at.localeCompare(left.updated_at),
									)
									.map(clone)
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								normalizedQuery.includes('from remote_connector_settings') &&
								normalizedQuery.includes('where user_id = ?')
							) {
								const [userId] = params as Array<string>
								const results = Array.from(rows.values())
									.filter((row) => row.user_id === userId)
									.sort(
										(left, right) =>
											left.kind.localeCompare(right.kind) ||
											left.instance_id.localeCompare(right.instance_id),
									)
									.map(clone)
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async run() {
							if (
								normalizedQuery.startsWith(
									'insert into remote_connector_settings',
								)
							) {
								const [
									id,
									userId,
									kind,
									instanceId,
									enabled,
									attached,
									encryptedSharedSecret,
									createdAt,
									updatedAt,
								] = params as Array<string | number | null>
								const existing =
									Array.from(rows.values()).find(
										(row) =>
											row.user_id === userId &&
											row.kind === kind &&
											row.instance_id === instanceId,
									) ?? null
								rows.set(existing?.id ?? String(id), {
									id: existing?.id ?? String(id),
									user_id: String(userId),
									kind: String(kind),
									instance_id: String(instanceId),
									enabled: Boolean(Number(enabled)),
									attached: Boolean(Number(attached)),
									encrypted_shared_secret:
										encryptedSharedSecret == null
											? null
											: String(encryptedSharedSecret),
									created_at: existing?.created_at ?? String(createdAt),
									updated_at: String(updatedAt),
								})
								return { meta: { changes: 1 } }
							}
							if (
								normalizedQuery.startsWith(
									'delete from remote_connector_settings',
								)
							) {
								const [userId, id] = params as Array<string>
								const row = rows.get(id)
								if (!row || row.user_id !== userId) {
									return { meta: { changes: 0 } }
								}
								rows.delete(id)
								return { meta: { changes: 1 } }
							}
							if (
								normalizedQuery.startsWith(
									'update remote_connector_settings set',
								)
							) {
								const [
									kind,
									instanceId,
									enabled,
									attached,
									encryptedSharedSecret,
									updatedAt,
									userId,
									id,
								] = params as Array<string | number | null>
								const existing = rows.get(String(id))
								if (!existing || existing.user_id !== userId) {
									return { meta: { changes: 0 } }
								}
								rows.set(String(id), {
									...existing,
									kind: String(kind),
									instance_id: String(instanceId),
									enabled: Boolean(Number(enabled)),
									attached: Boolean(Number(attached)),
									encrypted_shared_secret:
										encryptedSharedSecret == null
											? null
											: String(encryptedSharedSecret),
									updated_at: String(updatedAt),
								})
								return { meta: { changes: 1 } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return db
}

function createEnv(db = createRemoteConnectorSettingsTestDb()) {
	return {
		APP_DB: db,
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env
}

test('remote connector settings are generic and do not echo plaintext secrets', async () => {
	const env = createEnv()
	const saved = await saveRemoteConnectorSetting({
		env,
		userId: 'user-1',
		kind: ' Lights ',
		instanceId: ' home ',
		enabled: true,
		attached: true,
		sharedSecret: 'lights-secret',
	})

	expect(saved).toMatchObject({
		kind: 'lights',
		instanceId: 'home',
		enabled: true,
		attached: true,
		hasSharedSecret: true,
	})
	expect(saved).not.toHaveProperty('sharedSecret')
	expect(JSON.stringify(saved)).not.toContain('lights-secret')

	const connectors = await listRemoteConnectorSettings({
		env,
		userId: 'user-1',
	})
	expect(connectors).toHaveLength(1)
	expect(connectors[0]).not.toHaveProperty('sharedSecret')
	expect(JSON.stringify(connectors)).not.toContain('lights-secret')
	await expect(
		listRemoteConnectorSettingsWithSharedSecrets({
			env,
			userId: 'user-1',
		}),
	).resolves.toEqual([
		{
			...connectors[0],
			sharedSecret: 'lights-secret',
		},
	])
	await expect(
		listAttachedRemoteConnectorRefs({ env, userId: 'user-1' }),
	).resolves.toEqual([{ kind: 'lights', instanceId: 'home' }])
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-1',
			kind: 'lights',
			instanceId: 'home',
			sharedSecret: 'lights-secret',
		}),
	).resolves.toBe(true)
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-1',
			kind: 'lights',
			instanceId: 'home',
			sharedSecret: 'wrong-secret',
		}),
	).resolves.toBe(false)

	const updated = await saveRemoteConnectorSetting({
		env,
		userId: 'user-1',
		id: saved.id,
		kind: 'lights',
		instanceId: 'home',
		enabled: true,
		attached: false,
		sharedSecret: '',
	})
	expect(updated.hasSharedSecret).toBe(true)
	await expect(
		listAttachedRemoteConnectorRefs({ env, userId: 'user-1' }),
	).resolves.toEqual([])
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-1',
			kind: 'lights',
			instanceId: 'home',
			sharedSecret: 'lights-secret',
		}),
	).resolves.toBe(true)

	await expect(
		deleteRemoteConnectorSetting({ env, userId: 'user-1', id: saved.id }),
	).resolves.toBe(true)
	await expect(
		listRemoteConnectorSettings({ env, userId: 'user-1' }),
	).resolves.toEqual([])
})

test('renames an existing remote connector setting by id', async () => {
	const env = createEnv()
	const saved = await saveRemoteConnectorSetting({
		env,
		userId: 'user-1',
		kind: 'lights',
		instanceId: 'home',
		enabled: true,
		attached: true,
		sharedSecret: 'lights-secret',
	})

	const renamed = await saveRemoteConnectorSetting({
		env,
		userId: 'user-1',
		id: saved.id,
		kind: 'roku',
		instanceId: 'living-room',
		enabled: true,
		attached: true,
		sharedSecret: '',
	})

	expect(renamed).toMatchObject({
		id: saved.id,
		kind: 'roku',
		instanceId: 'living-room',
		hasSharedSecret: true,
	})
	await expect(
		listAttachedRemoteConnectorRefs({ env, userId: 'user-1' }),
	).resolves.toEqual([{ kind: 'roku', instanceId: 'living-room' }])
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-1',
			kind: 'roku',
			instanceId: 'living-room',
			sharedSecret: 'lights-secret',
		}),
	).resolves.toBe(true)
})

test('disabled connector settings do not authenticate connector hello', async () => {
	const env = createEnv()
	await saveRemoteConnectorSetting({
		env,
		userId: 'user-1',
		kind: 'roku',
		instanceId: 'living-room',
		enabled: false,
		attached: true,
		sharedSecret: 'roku-secret',
	})

	await expect(
		listAttachedRemoteConnectorRefs({ env, userId: 'user-1' }),
	).resolves.toEqual([])
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-1',
			kind: 'roku',
			instanceId: 'living-room',
			sharedSecret: 'roku-secret',
		}),
	).resolves.toBe(false)
})

test('connector names are explicit, formatted, and globally unique per user', async () => {
	const env = createEnv()
	await expect(
		saveRemoteConnectorSetting({
			env,
			userId: 'user-1',
			kind: 'lights',
			instanceId: '',
			enabled: true,
			attached: true,
			sharedSecret: 'secret',
		}),
	).rejects.toThrow('Connector name is required.')
	await expect(
		saveRemoteConnectorSetting({
			env,
			userId: 'user-1',
			kind: 'lights',
			instanceId: 'Living Room',
			enabled: true,
			attached: true,
			sharedSecret: 'secret',
		}),
	).rejects.toThrow('Connector name must use lowercase letters')

	await saveRemoteConnectorSetting({
		env,
		userId: 'user-1',
		kind: 'lights',
		instanceId: 'home',
		enabled: true,
		attached: true,
		sharedSecret: 'lights-secret',
	})
	await expect(
		saveRemoteConnectorSetting({
			env,
			userId: 'user-1',
			kind: 'roku',
			instanceId: 'home',
			enabled: true,
			attached: true,
			sharedSecret: 'roku-secret',
		}),
	).rejects.toThrow('A remote connector with this name already exists.')
})

test('connector hello secrets are scoped to the user_id of the ingress', async () => {
	const env = createEnv()
	await saveRemoteConnectorSetting({
		env,
		userId: 'user-aaa',
		kind: 'lights',
		instanceId: 'home',
		enabled: true,
		attached: true,
		sharedSecret: 'aaa-secret',
	})
	await saveRemoteConnectorSetting({
		env,
		userId: 'user-bbb',
		kind: 'lights',
		instanceId: 'home',
		enabled: true,
		attached: true,
		sharedSecret: 'bbb-secret',
	})

	// Each user's secret only authenticates that user's connector even when
	// (kind, instanceId) collide.
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-aaa',
			kind: 'lights',
			instanceId: 'home',
			sharedSecret: 'aaa-secret',
		}),
	).resolves.toBe(true)
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-aaa',
			kind: 'lights',
			instanceId: 'home',
			sharedSecret: 'bbb-secret',
		}),
	).resolves.toBe(false)
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-bbb',
			kind: 'lights',
			instanceId: 'home',
			sharedSecret: 'bbb-secret',
		}),
	).resolves.toBe(true)
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-bbb',
			kind: 'lights',
			instanceId: 'home',
			sharedSecret: 'aaa-secret',
		}),
	).resolves.toBe(false)
})
