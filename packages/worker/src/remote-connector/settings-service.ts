import {
	isValidRemoteConnectorName,
	normalizeRemoteConnectorInstanceId,
	type RemoteConnectorRef,
} from '@kody-internal/shared/remote-connectors.ts'
import { decryptSecretValue, encryptSecretValue } from '#mcp/secrets/crypto.ts'
import {
	deleteRemoteConnectorSettingRow,
	getRemoteConnectorSettingRowById,
	listAttachedRemoteConnectorSettingRows,
	listRemoteConnectorSettingRows,
	listRemoteConnectorSharedSecretRows,
	updateRemoteConnectorSettingRow,
	upsertRemoteConnectorSettingRow,
} from './settings-repo.ts'
import {
	type RemoteConnectorSettingMetadata,
	type RemoteConnectorSettingRow,
	type RemoteConnectorSettingWithSharedSecret,
} from './settings-types.ts'

type RemoteConnectorSettingsEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>

export type SaveRemoteConnectorSettingInput = {
	env: RemoteConnectorSettingsEnv
	userId: string
	id?: string | null
	instanceId: string
	enabled: boolean
	attached: boolean
	sharedSecret?: string | null
}

function toMetadata(
	row: RemoteConnectorSettingRow,
): RemoteConnectorSettingMetadata {
	return {
		id: row.id,
		instanceId: row.instance_id,
		enabled: row.enabled,
		attached: row.attached,
		hasSharedSecret: Boolean(row.encrypted_shared_secret),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export async function listRemoteConnectorSettings(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<RemoteConnectorSettingMetadata>> {
	const rows = await listRemoteConnectorSettingRows({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows.map(toMetadata)
}

export async function listRemoteConnectorSettingsWithSharedSecrets(input: {
	env: RemoteConnectorSettingsEnv
	userId: string
}): Promise<Array<RemoteConnectorSettingWithSharedSecret>> {
	const rows = await listRemoteConnectorSettingRows({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return Promise.all(
		rows.map(async (row) => ({
			...toMetadata(row),
			sharedSecret: row.encrypted_shared_secret
				? await decryptSecretValue(input.env, row.encrypted_shared_secret)
				: '',
		})),
	)
}

export async function listAttachedRemoteConnectorRefs(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<RemoteConnectorRef>> {
	const rows = await listAttachedRemoteConnectorSettingRows({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows.map((row) => ({
		instanceId: row.instance_id,
	}))
}

export async function saveRemoteConnectorSetting(
	input: SaveRemoteConnectorSettingInput,
): Promise<RemoteConnectorSettingMetadata> {
	const instanceId = normalizeRemoteConnectorInstanceId(input.instanceId)
	if (!instanceId) {
		throw new Error('Connector name is required.')
	}
	if (!isValidRemoteConnectorName(instanceId)) {
		throw new Error(
			'Connector name must use lowercase letters, numbers, and dashes; start and end with a letter or number; and be at most 64 characters.',
		)
	}

	const nameConflict = (
		await listRemoteConnectorSettingRows({
			db: input.env.APP_DB,
			userId: input.userId,
		})
	).find((row) => row.instance_id === instanceId && row.id !== input.id)
	if (nameConflict) {
		throw new Error('A remote connector with this name already exists.')
	}

	const existing = input.id
		? await getRemoteConnectorSettingRowById({
				db: input.env.APP_DB,
				userId: input.userId,
				id: input.id,
			})
		: null
	if (input.id && !existing) {
		throw new Error('Remote connector setting not found.')
	}

	const sharedSecret = input.sharedSecret?.trim() ?? ''
	const encryptedSharedSecret = sharedSecret
		? await encryptSecretValue(input.env, sharedSecret)
		: (existing?.encrypted_shared_secret ?? null)
	if (!encryptedSharedSecret) {
		throw new Error('Connector shared secret is required.')
	}

	const now = new Date().toISOString()
	const row = {
		id: existing?.id ?? crypto.randomUUID(),
		user_id: input.userId,
		instance_id: instanceId,
		enabled: input.enabled,
		attached: input.attached,
		encrypted_shared_secret: encryptedSharedSecret,
		created_at: existing?.created_at ?? now,
		updated_at: now,
	} satisfies RemoteConnectorSettingRow

	if (input.id) {
		const updated = await updateRemoteConnectorSettingRow({
			db: input.env.APP_DB,
			row,
		})
		if (!updated) {
			throw new Error('Remote connector setting not found.')
		}
	} else {
		await upsertRemoteConnectorSettingRow({
			db: input.env.APP_DB,
			row,
		})
	}
	return toMetadata(row)
}

export async function deleteRemoteConnectorSetting(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	id: string
}) {
	return deleteRemoteConnectorSettingRow({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
}

export async function listRemoteConnectorSharedSecretsForRef(input: {
	env: RemoteConnectorSettingsEnv
	userId: string
	instanceId: string
}): Promise<Array<string>> {
	const instanceId = normalizeRemoteConnectorInstanceId(input.instanceId)
	if (!instanceId) return []

	const rows = await listRemoteConnectorSharedSecretRows({
		db: input.env.APP_DB,
		userId: input.userId,
		instanceId,
	})
	const secrets: Array<string> = []
	for (const row of rows) {
		if (!row.encrypted_shared_secret) continue
		secrets.push(
			await decryptSecretValue(input.env, row.encrypted_shared_secret),
		)
	}
	return secrets
}

export async function hasRemoteConnectorSharedSecretForRef(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	instanceId: string
}) {
	const instanceId = normalizeRemoteConnectorInstanceId(input.instanceId)
	if (!instanceId) return false

	const rows = await listRemoteConnectorSharedSecretRows({
		db: input.env.APP_DB,
		userId: input.userId,
		instanceId,
	})
	return rows.length > 0
}
