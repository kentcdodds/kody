import {
	buildEntityRepoId,
	getArtifactsBinding,
	type ArtifactNamespaceBinding,
} from './artifacts.ts'
import {
	getEntitySourceByEntity,
	insertEntitySource,
	updateEntitySource,
} from './entity-sources.ts'
import { type EntityKind, type EntitySourceRow } from './types.ts'

function buildEntitySourceRow(input: {
	id?: string
	userId: string
	entityKind: EntityKind
	entityId: string
	repoId?: string
	publishedCommit?: string | null
	indexedCommit?: string | null
	manifestPath?: string
	sourceRoot?: string
	now?: string
}): EntitySourceRow {
	const now = input.now ?? new Date().toISOString()
	return {
		id: input.id ?? crypto.randomUUID(),
		user_id: input.userId,
		entity_kind: input.entityKind,
		entity_id: input.entityId,
		repo_id:
			input.repoId ??
			buildEntityRepoId({
				entityKind: input.entityKind,
				entityId: input.entityId,
			}),
		published_commit: input.publishedCommit ?? null,
		indexed_commit: input.indexedCommit ?? null,
		manifest_path: input.manifestPath ?? 'kody.json',
		source_root: input.sourceRoot ?? '/',
		created_at: now,
		updated_at: now,
	}
}

export async function ensureEntitySource(input: {
	db: D1Database
	env: Env
	id?: string
	userId: string
	entityKind: EntityKind
	entityId: string
	repoId?: string
	manifestPath?: string
	sourceRoot?: string
	requirePersistence?: boolean
}) {
	const hasDbPrepare = hasAppDbBinding(input.db)
	const hasArtifactsAccess = hasArtifactsAccessConfig(input.env)
	if (!hasDbPrepare || hasArtifactsAccess === false) {
		if (input.requirePersistence) {
			throw new Error(
				`Repo-backed source persistence requires ${missingPersistenceRequirements({
					hasDbPrepare,
					hasArtifactsAccess,
				}).join(' and ')}.`,
			)
		}
		return buildEntitySourceRow({
			id: input.id,
			userId: input.userId,
			entityKind: input.entityKind,
			entityId: input.entityId,
			repoId: input.repoId,
			manifestPath: input.manifestPath,
			sourceRoot: input.sourceRoot,
		})
	}
	const existing = await getEntitySourceByEntity(input.db, {
		userId: input.userId,
		entityKind: input.entityKind,
		entityId: input.entityId,
	})
	if (existing) return existing
	const row = buildEntitySourceRow({
		id: input.id,
		userId: input.userId,
		entityKind: input.entityKind,
		entityId: input.entityId,
		repoId: input.repoId,
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
	})
	await createArtifactsRepoIfMissing(input.env, row.repo_id)
	await insertEntitySource(input.db, row)
	return row
}

function hasAppDbBinding(db: D1Database | null | undefined) {
	return typeof db?.prepare === 'function'
}

function hasArtifactsAccessConfig(env: Env) {
	try {
		void getArtifactsBinding(env)
		return true
	} catch {
		return false
	}
}

function missingPersistenceRequirements(input: {
	hasDbPrepare: boolean
	hasArtifactsAccess: boolean
}) {
	const missing: Array<string> = []
	if (!input.hasDbPrepare) {
		missing.push('APP_DB')
	}
	if (!input.hasArtifactsAccess) {
		missing.push('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN')
	}
	return missing
}

export async function createArtifactsRepoIfMissing(
	env: Env,
	repoId: string,
	binding: ArtifactNamespaceBinding = getArtifactsBinding(env),
) {
	const existing = await binding.get(repoId)
	if (existing.status === 'ready') return existing.repo
	if (existing.status === 'importing' || existing.status === 'forking') {
		throw new Error(
			`Artifacts repo "${repoId}" is ${existing.status}. Retry after ${existing.retryAfter}s.`,
		)
	}
	const created = await binding.create(repoId, { readOnly: false })
	const getResult = await binding.get(created.name)
	if (getResult.status !== 'ready') {
		throw new Error(
			`Artifacts repo "${created.name}" is ${getResult.status} after create.`,
		)
	}
	return getResult.repo
}

export async function setEntityPublishedCommit(input: {
	db: D1Database
	userId: string
	sourceId: string
	publishedCommit: string | null
	indexedCommit?: string | null
}) {
	return updateEntitySource(input.db, {
		id: input.sourceId,
		userId: input.userId,
		publishedCommit: input.publishedCommit,
		...(input.indexedCommit !== undefined
			? { indexedCommit: input.indexedCommit }
			: {}),
	})
}
