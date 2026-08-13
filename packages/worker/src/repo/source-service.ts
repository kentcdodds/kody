import { waitUntil } from 'cloudflare:workers'
import {
	buildEntityRepoId,
	hasArtifactsAccess,
	ensureArtifactRepoReady,
	type ArtifactBootstrapAccess,
} from './artifacts.ts'
import { ensureArtifactsRepoPushSubscription } from './artifacts-push-subscriptions.ts'
import {
	getEntitySourceByEntity,
	insertEntitySource,
	updateEntitySource,
} from './entity-sources.ts'
import { type EntityKind, type EntitySourceRow } from './types.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

export type EnsuredEntitySource = EntitySourceRow & {
	bootstrapAccess?: ArtifactBootstrapAccess | null
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
		manifest_path:
			input.manifestPath ??
			(input.entityKind === 'package' || input.entityKind === 'repo'
				? 'package.json'
				: 'kody.json'),
		source_root: input.sourceRoot ?? '/',
		last_external_check_at: null,
		external_check_until: null,
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
	/** Request-scoped phase timings; omitted when the caller does not collect. */
	serverTiming?: Array<ServerTimingEntry>
}): Promise<EnsuredEntitySource> {
	const hasDbPrepare = hasAppDbBinding(input.db)
	const hasArtifactsAccessResult = hasArtifactsAccess(input.env)
	if (!hasDbPrepare || hasArtifactsAccessResult === false) {
		if (input.requirePersistence) {
			throw new Error(
				`Repo-backed source persistence requires ${missingPersistenceRequirements(
					{
						hasDbPrepare,
						hasArtifactsAccess: hasArtifactsAccessResult,
					},
				).join(' and ')}.`,
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
	if (existing) {
		const repoReady = await pushServerTiming(
			input.serverTiming,
			'artifacts-repo-ready',
			() => ensureArtifactRepoReady(input.env, existing.repo_id),
		)
		const source = repoReady.recreated
			? {
					...existing,
					published_commit: null,
					indexed_commit: null,
					bootstrapAccess: repoReady.bootstrapAccess,
				}
			: existing
		if (repoReady.recreated) {
			await updateEntitySource(input.db, {
				id: existing.id,
				userId: existing.user_id,
				publishedCommit: null,
				indexedCommit: null,
			})
		}
		scheduleArtifactsRepoPushSubscription({
			env: input.env,
			userId: existing.user_id,
			sourceId: existing.id,
			repoName: existing.repo_id,
		})
		return source
	}
	const row = buildEntitySourceRow({
		id: input.id,
		userId: input.userId,
		entityKind: input.entityKind,
		entityId: input.entityId,
		repoId: input.repoId,
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
	})
	const repoReady = await pushServerTiming(
		input.serverTiming,
		'artifacts-repo-ready',
		() => ensureArtifactRepoReady(input.env, row.repo_id),
	)
	await pushServerTiming(input.serverTiming, 'entity-source-insert', () =>
		insertEntitySource(input.db, row),
	)
	scheduleArtifactsRepoPushSubscription({
		env: input.env,
		userId: row.user_id,
		sourceId: row.id,
		repoName: row.repo_id,
	})
	return {
		...row,
		bootstrapAccess: repoReady.recreated ? repoReady.bootstrapAccess : null,
	}
}

function scheduleArtifactsRepoPushSubscription(input: {
	env: Env
	userId: string
	sourceId: string
	repoName: string
}) {
	// Best-effort; also runs from the repo.created consumer. Do not await —
	// listing queues/subscriptions is not on the source-creation hot path.
	waitUntil(ensureArtifactsRepoPushSubscription(input))
}

function hasAppDbBinding(db: D1Database | null | undefined) {
	return typeof db?.prepare === 'function'
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
