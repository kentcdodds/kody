import { buildSavedPackageEmbedText } from './embed.ts'
import { buildPackageSearchProjection } from './manifest.ts'
import {
	deleteSavedPackage,
	getSavedPackageById,
	insertSavedPackage,
	updateSavedPackage,
} from './repo.ts'
import { loadPackageSourceBySourceId } from './source.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
	type SavedPackageRow,
} from './types.ts'
import {
	deleteSavedPackageVector,
	upsertSavedPackageVector,
} from './vectorize.ts'
import { deleteJobRow, listJobRowsByUserId } from '#worker/jobs/repo.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-client.ts'
import {
	rebuildPublishedPackageArtifacts,
} from '#worker/package-runtime/published-bundle-artifacts.ts'

function serializeTags(tags: Array<string>) {
	return JSON.stringify(tags)
}

function toSavedPackageInsertRow(input: {
	packageId: string
	userId: string
	sourceId: string
	manifest: AuthoredPackageJson
}): Omit<SavedPackageRow, 'created_at' | 'updated_at'> {
	const projection = buildPackageSearchProjection(input.manifest)
	return {
		id: input.packageId,
		user_id: input.userId,
		name: projection.name,
		kody_id: projection.kodyId,
		description: projection.description,
		tags_json: serializeTags(projection.tags),
		search_text: projection.searchText,
		source_id: input.sourceId,
		has_app: projection.hasApp ? 1 : 0,
	}
}

export async function refreshSavedPackageProjection(input: {
	env: Env
	baseUrl: string
	userId: string
	packageId: string
	sourceId: string
}) {
	const loaded = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	const row = toSavedPackageInsertRow({
		packageId: input.packageId,
		userId: input.userId,
		sourceId: input.sourceId,
		manifest: loaded.manifest,
	})
	const existing = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (existing) {
		await updateSavedPackage(input.env.APP_DB, {
			userId: input.userId,
			packageId: input.packageId,
			name: row.name,
			kodyId: row.kody_id,
			description: row.description,
			tagsJson: row.tags_json,
			searchText: row.search_text,
			sourceId: row.source_id,
			hasApp: row.has_app === 1,
		})
	} else {
		await insertSavedPackage(input.env.APP_DB, row)
	}
	await upsertSavedPackageVector(input.env, {
		packageId: input.packageId,
		userId: input.userId,
		embedText: buildSavedPackageEmbedText(loaded.manifest),
	})
	const refreshedAt = new Date().toISOString()
	await rebuildPublishedPackageArtifacts({
		env: input.env,
		userId: input.userId,
		source: loaded.source,
		savedPackage: {
			id: input.packageId,
			userId: input.userId,
			name: row.name,
			kodyId: row.kody_id,
			description: row.description,
			tags: JSON.parse(row.tags_json) as Array<string>,
			searchText: row.search_text ?? null,
			sourceId: row.source_id,
			hasApp: row.has_app === 1,
			createdAt: existing?.createdAt ?? refreshedAt,
			updatedAt: refreshedAt,
		},
		manifest: loaded.manifest,
		files: loaded.files,
		buildAppBundle: async ({ entryPoint }) => {
			const { buildKodyAppBundle } = await import(
				'#worker/package-runtime/module-graph.ts'
			)
			return await buildKodyAppBundle({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceFiles: loaded.files,
				entryPoint,
				cacheKey: null,
			})
		},
		buildModuleBundle: async ({ entryPoint }) => {
			const { buildKodyModuleBundle } = await import(
				'#worker/package-runtime/module-graph.ts'
			)
			return await buildKodyModuleBundle({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceFiles: loaded.files,
				entryPoint,
			})
		},
	})
	const { syncPackageJobsForPackage } = await import('#worker/jobs/service.ts')
	await syncPackageJobsForPackage({
		env: input.env,
		userId: input.userId,
		baseUrl: input.baseUrl,
		packageId: input.packageId,
		sourceId: input.sourceId,
		manifest: loaded.manifest,
	})
	await syncJobManagerAlarm({
		env: input.env,
		userId: input.userId,
	})
	return {
		record:
			existing ??
			({
				id: row.id,
				userId: row.user_id,
				name: row.name,
				kodyId: row.kody_id,
				description: row.description,
				tags: JSON.parse(row.tags_json) as Array<string>,
				searchText: row.search_text ?? null,
				sourceId: row.source_id,
				hasApp: row.has_app === 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			} satisfies SavedPackageRecord),
		manifest: loaded.manifest,
		files: loaded.files,
	}
}

export async function deleteSavedPackageProjection(input: {
	env: Env
	userId: string
	packageId: string
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (savedPackage) {
		const existingRows = await listJobRowsByUserId(
			input.env.APP_DB,
			input.userId,
		)
		const packageRows = existingRows.filter(
			(row) => row.source_id === savedPackage.sourceId,
		)
		for (const row of packageRows) {
			await deleteJobRow(input.env.APP_DB, input.userId, row.id)
		}
	}
	await deleteSavedPackage(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	await deleteSavedPackageVector(input.env, input.packageId)
	await syncJobManagerAlarm({
		env: input.env,
		userId: input.userId,
	})
}
