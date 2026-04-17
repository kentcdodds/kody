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

type RepoSourceSupportBinding = 'APP_DB' | 'ARTIFACTS' | 'REPO_SESSION'

export type RepoSourceSupportStatus =
	| {
			ok: true
			missingBindings: Array<RepoSourceSupportBinding>
			reason: null
	  }
	| {
			ok: false
			missingBindings: Array<RepoSourceSupportBinding>
			reason: string
	  }

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
}) {
	if (!getRepoSourceSupportStatus({ db: input.db, env: input.env }).ok) {
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

export function getRepoSourceSupportStatus(input: {
	db: D1Database | null | undefined
	env: Env
}): RepoSourceSupportStatus {
	const missingBindings: Array<RepoSourceSupportBinding> = []
	if (typeof input.db?.prepare !== 'function') {
		missingBindings.push('APP_DB')
	}
	if (!envHasArtifactsBinding(input.env)) {
		missingBindings.push('ARTIFACTS')
	}
	if (!envHasRepoSessionBinding(input.env)) {
		missingBindings.push('REPO_SESSION')
	}
	if (missingBindings.length === 0) {
		return {
			ok: true,
			missingBindings,
			reason: null,
		}
	}
	const bindingLabel = missingBindings.length === 1 ? 'binding' : 'bindings'
	return {
		ok: false,
		missingBindings,
		reason: `Repo-backed source support is unavailable in this environment. Missing required ${bindingLabel}: ${missingBindings.join(', ')}.`,
	}
}

function envHasArtifactsBinding(env: Env) {
	return (
		typeof (env as Env & { ARTIFACTS?: unknown }).ARTIFACTS === 'object' &&
		(env as Env & { ARTIFACTS?: unknown }).ARTIFACTS != null
	)
}

function envHasRepoSessionBinding(env: Env) {
	return (
		typeof (env as Env & { REPO_SESSION?: unknown }).REPO_SESSION ===
			'object' &&
		(env as Env & { REPO_SESSION?: unknown }).REPO_SESSION != null
	)
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
