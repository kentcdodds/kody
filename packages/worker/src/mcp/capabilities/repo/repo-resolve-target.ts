import { type z } from 'zod'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
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

async function requirePackageTarget(input: {
	db: D1Database
	userId: string
	target: Extract<RepoTarget, { kind: 'package' }>
}): Promise<{ source: EntitySourceRow; resolvedTarget: RepoResolvedTarget }> {
	const savedPackage =
		'package_id' in input.target
			? await getSavedPackageById(input.db, {
					userId: input.userId,
					packageId: input.target.package_id,
				})
			: await getSavedPackageByKodyId(input.db, {
					userId: input.userId,
					kodyId: input.target.kody_id,
				})
	if (!savedPackage) {
		const missingId =
			'package_id' in input.target
				? input.target.package_id
				: input.target.kody_id
		throw new Error(`Saved package "${missingId}" was not found.`)
	}
	const source = await requireOwnedEntitySource({
		db: input.db,
		userId: input.userId,
		sourceId: savedPackage.sourceId,
	})
	return {
		source,
		resolvedTarget: {
			kind: 'package',
			source_id: source.id,
			package_id: savedPackage.id,
			kody_id: savedPackage.kodyId,
			name: savedPackage.name,
		},
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
	return requirePackageTarget({
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
		case 'package': {
			const savedPackage = await getSavedPackageById(input.db, {
				userId: input.userId,
				packageId: source.entity_id,
			})
			if (!savedPackage) {
				return toResolvedSourceTarget(source)
			}
			return {
				kind: 'package',
				source_id: source.id,
				package_id: savedPackage.id,
				kody_id: savedPackage.kodyId,
				name: savedPackage.name,
			}
		}
	}
	return toResolvedSourceTarget(source)
}
