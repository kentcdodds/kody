import { type z } from 'zod'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { getAppRowById, listAppRowsByUserId } from '#worker/apps/repo.ts'
import { type AppRecord } from '#worker/apps/types.ts'
import {
	type repoOpenSessionInputSchema,
	type repoResolvedTargetSchema,
	type repoTargetSchema,
} from './repo-shared.ts'

type RepoTarget = z.infer<typeof repoTargetSchema>
type RepoOpenSessionInput = z.infer<typeof repoOpenSessionInputSchema>
type RepoResolvedTarget = z.infer<typeof repoResolvedTargetSchema>

async function requireOwnedEntitySource(input: {
	db: D1Database
	userId: string
	sourceId: string
}): Promise<EntitySourceRow> {
	const source = await getEntitySourceById(input.db, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error('Repo source was not found for this user.')
	}
	return source
}

function toResolvedSourceTarget(source: EntitySourceRow): RepoResolvedTarget {
	return {
		kind: 'source',
		source_id: source.id,
		entity_kind: source.entity_kind,
		entity_id: source.entity_id,
	}
}

async function requireAppByName(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<AppRecord> {
	const trimmedName = input.name.trim()
	const rows = await listAppRowsByUserId(input.db, input.userId)
	const matches = rows.filter((row) => row.title === trimmedName)
	if (matches.length === 0) {
		throw new Error(`Saved app "${trimmedName}" was not found.`)
	}
	if (matches.length > 1) {
		const appIds = matches.map((row) => row.id).join(', ')
		throw new Error(
			`Saved app title "${trimmedName}" is ambiguous for this user. Use app_id instead. Matching app ids: ${appIds}.`,
		)
	}
	const match = matches[0]
	if (!match) {
		throw new Error(`Saved app "${trimmedName}" was not found.`)
	}
	return match
}

async function requireAppTarget(input: {
	db: D1Database
	userId: string
	target: Extract<RepoTarget, { kind: 'app' }>
}): Promise<{ source: EntitySourceRow; resolvedTarget: RepoResolvedTarget }> {
	const app =
		'app_id' in input.target
			? await getAppRowById(input.db, input.userId, input.target.app_id)
			: await requireAppByName({
					db: input.db,
					userId: input.userId,
					name: input.target.name,
				})
	if (!app) {
		const missingId =
			'app_id' in input.target ? input.target.app_id : input.target.name
		throw new Error(`Saved app "${missingId}" was not found.`)
	}
	const source = await requireOwnedEntitySource({
		db: input.db,
		userId: input.userId,
		sourceId: app.sourceId,
	})
	return {
		source,
		resolvedTarget: toResolvedAppTarget(app, source.id),
	}
}

function toResolvedAppTarget(
	app: Pick<AppRecord, 'id' | 'title' | 'sourceId'>,
	sourceId?: string,
): RepoResolvedTarget {
	return {
		kind: 'app',
		source_id: sourceId ?? app.sourceId,
		app_id: app.id,
		title: app.title,
	}
}

export async function resolveRepoSourceReference(input: {
	db: D1Database
	userId: string
	args: Pick<RepoOpenSessionInput, 'source_id' | 'target'>
}): Promise<{ source: EntitySourceRow; resolvedTarget: RepoResolvedTarget }> {
	if (input.args.source_id) {
		const source = await requireOwnedEntitySource({
			db: input.db,
			userId: input.userId,
			sourceId: input.args.source_id,
		})
		return {
			source,
			resolvedTarget: toResolvedSourceTarget(source),
		}
	}
	if (!input.args.target) {
		throw new Error('Repo source identity is required.')
	}
	return requireAppTarget({
		db: input.db,
		userId: input.userId,
		target: input.args.target,
	})
}

export async function resolveRepoTargetFromSource(input: {
	db: D1Database
	userId: string
	sourceId: string
}): Promise<RepoResolvedTarget> {
	const source = await requireOwnedEntitySource({
		db: input.db,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	switch (source.entity_kind) {
		case 'app': {
			const app = await getAppRowById(input.db, input.userId, source.entity_id)
			if (!app) {
				return toResolvedSourceTarget(source)
			}
			return toResolvedAppTarget(app, source.id)
		}
	}
	return toResolvedSourceTarget(source)
}
