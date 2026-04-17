import {
	CAPABILITY_EMBEDDING_MODEL,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { buildUiArtifactEmbedText } from '#mcp/ui-artifacts-embed.ts'
import { parseUiArtifactParameters } from '#mcp/ui-artifact-parameters.ts'
import {
	listUiArtifactsByUserId,
	uiArtifactVectorId,
} from '#mcp/ui-artifacts-repo.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { listAppSecretsByAppIds } from '#mcp/secrets/service.ts'
import { hasSavedAppBackend, resolveSavedAppSource } from '#worker/repo/app-source.ts'

const upsertBatchSize = 16

async function listAllVisibleUiArtifacts(env: Env) {
	const rows = await env.APP_DB.prepare(
		`SELECT DISTINCT user_id FROM ui_artifacts WHERE hidden = 0`,
	).all<{ user_id: string }>()
	const userIds = (rows.results ?? []).map((row) => row.user_id).filter(Boolean)
	const artifacts = await Promise.all(
		userIds.map((userId) =>
			listUiArtifactsByUserId(env.APP_DB, userId, {
				hidden: false,
			}),
		),
	)
	return artifacts.flat()
}

async function resolveUiArtifactBackendStatus(input: {
	baseUrl: string
	env: Env
	row: UiArtifactRow
}) {
	try {
		const source = await resolveSavedAppSource({
			env: input.env,
			baseUrl: input.baseUrl,
			artifact: input.row,
		})
		return hasSavedAppBackend(source)
	} catch {
		return false
	}
}

export async function reindexUiArtifactVectors(env: Env): Promise<{
	upserted: number
}> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0 }
	}

	const rows = await listAllVisibleUiArtifacts(env)
	if (rows.length === 0) {
		return { upserted: 0 }
	}

	const baseUrl = env.APP_BASE_URL?.trim() || 'http://internal.invalid'
	const backendStatusById = new Map(
		await Promise.all(
			rows.map(async (row) => [
				row.id,
				await resolveUiArtifactBackendStatus({
					baseUrl,
					env,
					row,
				}),
			]),
		),
	)
	const appSecretsByAppId = new Map<
		string,
		Array<{ name: string; description: string }>
	>()
	const rowsByUser = new Map<string, Array<(typeof rows)[number]>>()
	for (const row of rows) {
		const current = rowsByUser.get(row.user_id) ?? []
		current.push(row)
		rowsByUser.set(row.user_id, current)
	}
	for (const [userId, userRows] of rowsByUser) {
		const grouped = await listAppSecretsByAppIds({
			env,
			userId,
			appIds: userRows.map((row) => row.id),
		})
		for (const [appId, secrets] of grouped) {
			appSecretsByAppId.set(
				appId,
				secrets.map((secret) => ({
					name: secret.name,
					description: secret.description,
				})),
			)
		}
	}

	let upserted = 0
	for (let offset = 0; offset < rows.length; offset += upsertBatchSize) {
		const batch = rows.slice(offset, offset + upsertBatchSize)
		const texts = batch.map((row) => {
			const secrets = appSecretsByAppId.get(row.id) ?? []
			const secretText =
				secrets.length > 0
					? `\nAvailable app secrets:\n${secrets
							.map((secret) => `${secret.name}: ${secret.description}`)
							.join('\n')}`
					: ''
			return `${buildUiArtifactEmbedText({
				title: row.title,
				description: row.description,
				hasServerCode: backendStatusById.get(row.id) ?? false,
				parameters: parseUiArtifactParameters(row.parameters),
			})}${secretText}`
		})
		const result = (await env.AI.run(CAPABILITY_EMBEDDING_MODEL, {
			text: texts,
			pooling: 'mean',
		})) as { data?: Array<Array<number>> }
		const vectors = result.data
		if (!vectors || vectors.length !== batch.length) {
			throw new Error('Workers AI embedding batch size mismatch for saved apps')
		}
		await index.upsert(
			batch.map((row, index_) => ({
				id: uiArtifactVectorId(row.id),
				values: vectors[index_]!,
				metadata: { kind: 'ui_artifact', userId: row.user_id },
			})),
		)
		upserted += batch.length
	}

	return { upserted }
}
