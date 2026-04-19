import { z } from 'zod'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	getMcpSkillByNameInput,
	listMcpSkillsByUserId,
} from '#mcp/skills/mcp-skills-repo.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import {
	getJobRowById,
	listJobRowsByUserId,
	type JobRow,
} from '#worker/jobs/repo.ts'
import {
	repoOpenSessionInputSchema,
	repoResolvedTargetSchema,
	repoTargetSchema,
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

async function requireSkillTarget(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<{ source: EntitySourceRow; resolvedTarget: RepoResolvedTarget }> {
	const skill = await getMcpSkillByNameInput(input.db, input.userId, input.name)
	if (!skill) {
		throw new Error(`Saved skill "${input.name}" was not found.`)
	}
	if (!skill.source_id) {
		throw new Error(`Saved skill "${skill.name}" has no repo-backed source.`)
	}
	const source = await requireOwnedEntitySource({
		db: input.db,
		userId: input.userId,
		sourceId: skill.source_id,
	})
	return {
		source,
		resolvedTarget: toResolvedSkillTarget(skill),
	}
}

function toResolvedSkillTarget(skill: McpSkillRow): RepoResolvedTarget {
	return {
		kind: 'skill',
		source_id: skill.source_id,
		skill_id: skill.id,
		name: skill.name,
	}
}

async function requireJobByName(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<JobRow> {
	const trimmedName = input.name.trim()
	if (!trimmedName) {
		throw new Error('Job name must not be empty.')
	}
	const rows = await listJobRowsByUserId(input.db, input.userId)
	const matches = rows.filter((row) => row.name === trimmedName)
	if (matches.length === 0) {
		throw new Error(`Saved job "${trimmedName}" was not found.`)
	}
	if (matches.length > 1) {
		const jobIds = matches.map((row) => row.id).join(', ')
		throw new Error(
			`Saved job name "${trimmedName}" is ambiguous for this user. Use job_id instead. Matching job ids: ${jobIds}.`,
		)
	}
	const match = matches[0]
	if (!match) {
		throw new Error(`Saved job "${trimmedName}" was not found.`)
	}
	return match
}

async function requireJobTarget(input: {
	db: D1Database
	userId: string
	target: Extract<RepoTarget, { kind: 'job' }>
}): Promise<{ source: EntitySourceRow; resolvedTarget: RepoResolvedTarget }> {
	const job =
		'job_id' in input.target
			? await getJobRowById(input.db, input.userId, input.target.job_id)
			: await requireJobByName({
					db: input.db,
					userId: input.userId,
					name: input.target.name,
				})
	if (!job) {
		const missingId =
			'job_id' in input.target ? input.target.job_id : input.target.name
		throw new Error(`Saved job "${missingId}" was not found.`)
	}
	const source = await requireOwnedEntitySource({
		db: input.db,
		userId: input.userId,
		sourceId: job.source_id,
	})
	return {
		source,
		resolvedTarget: {
			kind: 'job',
			source_id: source.id,
			job_id: job.id,
			name: job.name,
		},
	}
}

async function requireAppTarget(input: {
	db: D1Database
	userId: string
	appId: string
}): Promise<{ source: EntitySourceRow; resolvedTarget: RepoResolvedTarget }> {
	const app = await getUiArtifactById(input.db, input.userId, input.appId)
	if (!app) {
		throw new Error(`Saved app "${input.appId}" was not found.`)
	}
	if (!app.sourceId) {
		throw new Error(`Saved app "${app.id}" has no repo-backed source.`)
	}
	const source = await requireOwnedEntitySource({
		db: input.db,
		userId: input.userId,
		sourceId: app.sourceId,
	})
	return {
		source,
		resolvedTarget: toResolvedAppTarget(app),
	}
}

function toResolvedAppTarget(app: UiArtifactRow): RepoResolvedTarget {
	return {
		kind: 'app',
		source_id: app.sourceId ?? '',
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
	switch (input.args.target.kind) {
		case 'skill':
			return requireSkillTarget({
				db: input.db,
				userId: input.userId,
				name: input.args.target.name,
			})
		case 'job':
			return requireJobTarget({
				db: input.db,
				userId: input.userId,
				target: input.args.target,
			})
		case 'app':
			return requireAppTarget({
				db: input.db,
				userId: input.userId,
				appId: input.args.target.app_id,
			})
	}
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
		case 'skill': {
			const skills = await listMcpSkillsByUserId(input.db, input.userId)
			const skill = skills.find(
				(candidate) => candidate.id === source.entity_id,
			)
			if (!skill) {
				return toResolvedSourceTarget(source)
			}
			return toResolvedSkillTarget(skill)
		}
		case 'job': {
			const job = await getJobRowById(input.db, input.userId, source.entity_id)
			if (!job) {
				return toResolvedSourceTarget(source)
			}
			return {
				kind: 'job',
				source_id: source.id,
				job_id: job.id,
				name: job.name,
			}
		}
		case 'app': {
			const app = await getUiArtifactById(
				input.db,
				input.userId,
				source.entity_id,
			)
			if (!app || !app.sourceId) {
				return toResolvedSourceTarget(source)
			}
			return toResolvedAppTarget(app)
		}
	}
	return toResolvedSourceTarget(source)
}
