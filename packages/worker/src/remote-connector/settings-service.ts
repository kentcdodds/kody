import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'
import { decryptSecretValue, encryptSecretValue } from '#mcp/secrets/crypto.ts'
import {
	deleteRemoteConnectorSettingRow,
	getRemoteConnectorSettingRowById,
	getRemoteConnectorSettingRowByRef,
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
	kind: string
	instanceId: string
	enabled: boolean
	attached: boolean
	sharedSecret?: string | null
}

export function normalizeRemoteConnectorKind(kind: string) {
	return kind.trim().toLowerCase()
}

export function normalizeRemoteConnectorInstanceId(instanceId: string) {
	return instanceId.trim()
}

function toMetadata(
	row: RemoteConnectorSettingRow,
): RemoteConnectorSettingMetadata {
	return {
		id: row.id,
		kind: row.kind,
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
		kind: row.kind,
		instanceId: row.instance_id,
	}))
}

export async function safelyListAttachedRemoteConnectorRefs(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	try {
		return await listAttachedRemoteConnectorRefs(input)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.error(
			`[remote-connectors] failed to read attached connector refs for user ${input.userId}: ${detail}`,
		)
		return []
	}
}

export async function saveRemoteConnectorSetting(
	input: SaveRemoteConnectorSettingInput,
): Promise<RemoteConnectorSettingMetadata> {
	const kind = normalizeRemoteConnectorKind(input.kind)
	const instanceId = normalizeRemoteConnectorInstanceId(input.instanceId)
	if (!kind) {
		throw new Error('Connector kind is required.')
	}
	if (!instanceId) {
		throw new Error('Connector instance ID is required.')
	}

	const existing = input.id
		? await getRemoteConnectorSettingRowById({
				db: input.env.APP_DB,
				userId: input.userId,
				id: input.id,
			})
		: await getRemoteConnectorSettingRowByRef({
				db: input.env.APP_DB,
				userId: input.userId,
				kind,
				instanceId,
			})
	if (input.id && !existing) {
		throw new Error('Remote connector setting not found.')
	}

	if (input.id) {
		const refConflict = await getRemoteConnectorSettingRowByRef({
			db: input.env.APP_DB,
			userId: input.userId,
			kind,
			instanceId,
		})
		if (refConflict && refConflict.id !== existing?.id) {
			throw new Error(
				'A remote connector with this kind and instance ID exists.',
			)
		}
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
		kind,
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
	kind: string
	instanceId: string
}): Promise<Array<string>> {
	const kind = normalizeRemoteConnectorKind(input.kind)
	const instanceId = normalizeRemoteConnectorInstanceId(input.instanceId)
	if (!kind || !instanceId) return []

	const rows = await listRemoteConnectorSharedSecretRows({
		db: input.env.APP_DB,
		kind,
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
	kind: string
	instanceId: string
}) {
	const kind = normalizeRemoteConnectorKind(input.kind)
	const instanceId = normalizeRemoteConnectorInstanceId(input.instanceId)
	if (!kind || !instanceId) return false

	const rows = await listRemoteConnectorSharedSecretRows({
		db: input.env.APP_DB,
		kind,
		instanceId,
	})
	return rows.length > 0
}
