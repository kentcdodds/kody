import { syncSavedAppRunnerFromDb } from '#mcp/app-runner.ts'
import { parseUiArtifactParameters } from '#mcp/ui-artifact-parameters.ts'
import {
	listUiArtifactsByUserId,
	updateUiArtifact,
} from '#mcp/ui-artifacts-repo.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import {
	listMcpSkillsByUserId,
	updateMcpSkill,
} from '#mcp/skills/mcp-skills-repo.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'
import { parseSkillParameters } from '#mcp/skills/skill-parameters.ts'
import { reindexSkillVectors } from '#mcp/skills/skill-reindex.ts'
import { reindexUiArtifactVectors } from '#mcp/ui-artifact-reindex.ts'
import { reindexJobVectors } from '#worker/jobs/job-reindex.ts'
import { listJobRowsByUserId, type JobRow, updateJobRow } from '#worker/jobs/repo.ts'
import { toJobView } from '#worker/jobs/schedule.ts'
import {
	getEntitySourceByEntity,
	getEntitySourceById,
	updateEntitySource,
} from './entity-sources.ts'
import { buildAppSourceFiles, buildJobSourceFiles, buildSkillSourceFiles } from './source-templates.ts'
import { ensureEntitySource } from './source-service.ts'
import { syncArtifactSourceSnapshot } from './source-sync.ts'

type BackfillStatus = 'planned' | 'migrated' | 'skipped' | 'error'
type BackfillEntityKind = 'app' | 'skill' | 'job'

export type SourceBackfillEntityResult = {
	kind: BackfillEntityKind
	id: string
	title: string
	status: BackfillStatus
	reason: string | null
	sourceId: string | null
	publishedCommit: string | null
}

type SourceBackfillGroupResult = {
	total: number
	planned: number
	migrated: number
	skipped: number
	errors: number
	results: Array<SourceBackfillEntityResult>
}

export type SourceBackfillSummary = {
	dryRun: boolean
	apps: SourceBackfillGroupResult
	skills: SourceBackfillGroupResult
	jobs: SourceBackfillGroupResult
	reindex: null | {
		apps: number
		skills: number
		jobs: number
	}
}

export async function backfillRepoSources(input: {
	env: Env
	userId: string
	baseUrl: string
	dryRun?: boolean
	includeApps?: boolean
	includeSkills?: boolean
	includeJobs?: boolean
	reindex?: boolean
	syncAppRunners?: boolean
}) {
	const dryRun = input.dryRun ?? true
	const appRows = input.includeApps === false ? [] : await listUiArtifactsByUserId(input.env.APP_DB, input.userId)
	const skillRows =
		input.includeSkills === false
			? []
			: await listMcpSkillsByUserId(input.env.APP_DB, input.userId)
	const jobRows =
		input.includeJobs === false
			? []
			: await listJobRowsByUserId(input.env.APP_DB, input.userId)

	const apps = await backfillGroup(appRows, (row) =>
		backfillApp({
			row,
			env: input.env,
			userId: input.userId,
			baseUrl: input.baseUrl,
			dryRun,
			syncAppRunner: input.syncAppRunners ?? true,
		}),
	)
	const skills = await backfillGroup(skillRows, (row) =>
		backfillSkill({
			row,
			env: input.env,
			userId: input.userId,
			baseUrl: input.baseUrl,
			dryRun,
		}),
	)
	const jobs = await backfillGroup(jobRows, (row) =>
		backfillJob({
			row,
			env: input.env,
			userId: input.userId,
			baseUrl: input.baseUrl,
			dryRun,
		}),
	)

	const shouldReindex = !dryRun && (input.reindex ?? true)
	const reindex =
		shouldReindex === false
			? null
			: {
					apps: (await reindexUiArtifactVectors(input.env)).upserted,
					skills: (await reindexSkillVectors(input.env)).upserted,
					jobs: (await reindexJobVectors(input.env)).upserted,
				}

	return {
		dryRun,
		apps,
		skills,
		jobs,
		reindex,
	} satisfies SourceBackfillSummary
}

async function backfillGroup<T>(
	rows: Array<T>,
	run: (row: T) => Promise<SourceBackfillEntityResult>,
): Promise<SourceBackfillGroupResult> {
	const results = await Promise.all(rows.map((row) => run(row)))
	return {
		total: results.length,
		planned: results.filter((result) => result.status === 'planned').length,
		migrated: results.filter((result) => result.status === 'migrated').length,
		skipped: results.filter((result) => result.status === 'skipped').length,
		errors: results.filter((result) => result.status === 'error').length,
		results,
	}
}

async function backfillApp(input: {
	row: UiArtifactRow
	env: Env
	userId: string
	baseUrl: string
	dryRun: boolean
	syncAppRunner: boolean
}): Promise<SourceBackfillEntityResult> {
	try {
		const existingSource = await getExistingEntitySource({
			db: input.env.APP_DB,
			userId: input.userId,
			entityKind: 'app',
			entityId: input.row.id,
			sourceId: input.row.sourceId,
		})
		if (existingSource?.published_commit) {
			if (!input.dryRun && input.syncAppRunner) {
				try {
					await syncSavedAppRunnerFromDb({
						env: input.env,
						appId: input.row.id,
						userId: input.userId,
						baseUrl: input.baseUrl,
					})
				} catch (error) {
					return {
						kind: 'app',
						id: input.row.id,
						title: input.row.title,
						status: 'error',
						reason: formatBackfillError(error),
						sourceId: existingSource.id,
						publishedCommit: existingSource.published_commit,
					}
				}
			}
			return {
				kind: 'app',
				id: input.row.id,
				title: input.row.title,
				status: 'skipped',
				reason: 'Repo-backed source already published.',
				sourceId: existingSource.id,
				publishedCommit: existingSource.published_commit,
			}
		}

		const parameters = parseUiArtifactParameters(input.row.parameters)
		if (input.dryRun) {
			return {
				kind: 'app',
				id: input.row.id,
				title: input.row.title,
				status: 'planned',
				reason: 'Would create and publish a repo-backed source snapshot.',
				sourceId: existingSource?.id ?? input.row.sourceId,
				publishedCommit: existingSource?.published_commit ?? null,
			}
		}

		const ensuredSource = await ensureEntitySource({
			db: input.env.APP_DB,
			env: input.env,
			id: input.row.sourceId ?? undefined,
			userId: input.userId,
			entityKind: 'app',
			entityId: input.row.id,
			sourceRoot: '/',
			requirePersistence: true,
		})
		const publishedCommit = await syncArtifactSourceSnapshot({
			env: input.env,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceId: ensuredSource.id,
			files: buildAppSourceFiles({
				title: input.row.title,
				description: input.row.description,
				parameters,
				hidden: input.row.hidden,
				clientCode: input.row.clientCode,
				serverCode: input.row.serverCode,
			}),
		})
		if (!publishedCommit) {
			throw new Error('App backfill could not publish a repo-backed source snapshot.')
		}
		await updateEntitySource(input.env.APP_DB, {
			id: ensuredSource.id,
			userId: input.userId,
			publishedCommit,
			indexedCommit: publishedCommit,
		})
		if (input.row.sourceId !== ensuredSource.id) {
			await updateUiArtifact(input.env.APP_DB, input.userId, input.row.id, {
				sourceId: ensuredSource.id,
			})
		}
		if (input.syncAppRunner) {
			await syncSavedAppRunnerFromDb({
				env: input.env,
				appId: input.row.id,
				userId: input.userId,
				baseUrl: input.baseUrl,
			})
		}
		return {
			kind: 'app',
			id: input.row.id,
			title: input.row.title,
			status: 'migrated',
			reason: 'Published repo-backed source snapshot from legacy inline app source.',
			sourceId: ensuredSource.id,
			publishedCommit,
		}
	} catch (error) {
		return {
			kind: 'app',
			id: input.row.id,
			title: input.row.title,
			status: 'error',
			reason: formatBackfillError(error),
			sourceId: input.row.sourceId,
			publishedCommit: null,
		}
	}
}

async function backfillSkill(input: {
	row: McpSkillRow
	env: Env
	userId: string
	baseUrl: string
	dryRun: boolean
}): Promise<SourceBackfillEntityResult> {
	try {
		const existingSource = await getExistingEntitySource({
			db: input.env.APP_DB,
			userId: input.userId,
			entityKind: 'skill',
			entityId: input.row.id,
			sourceId: input.row.source_id,
		})
		if (existingSource?.published_commit) {
			return {
				kind: 'skill',
				id: input.row.id,
				title: input.row.title,
				status: 'skipped',
				reason: 'Repo-backed source already published.',
				sourceId: existingSource.id,
				publishedCommit: existingSource.published_commit,
			}
		}

		if (input.dryRun) {
			return {
				kind: 'skill',
				id: input.row.id,
				title: input.row.title,
				status: 'planned',
				reason: 'Would create and publish a repo-backed source snapshot.',
				sourceId: existingSource?.id ?? input.row.source_id,
				publishedCommit: existingSource?.published_commit ?? null,
			}
		}

		const ensuredSource = await ensureEntitySource({
			db: input.env.APP_DB,
			env: input.env,
			id: input.row.source_id ?? undefined,
			userId: input.userId,
			entityKind: 'skill',
			entityId: input.row.id,
			sourceRoot: '/',
			requirePersistence: true,
		})
		const publishedCommit = await syncArtifactSourceSnapshot({
			env: input.env,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceId: ensuredSource.id,
			files: buildSkillSourceFiles({
				title: input.row.title,
				description: input.row.description,
				keywords: parseJsonStringArray(input.row.keywords),
				searchText: input.row.search_text,
				collection: input.row.collection_name,
				readOnly: input.row.read_only === 1,
				idempotent: input.row.idempotent === 1,
				destructive: input.row.destructive === 1,
				usesCapabilities: parseOptionalJsonStringArray(
					input.row.uses_capabilities,
				),
				parameters: parseSkillParameters(input.row.parameters),
				code: input.row.code,
			}),
		})
		if (!publishedCommit) {
			throw new Error('Skill backfill could not publish a repo-backed source snapshot.')
		}
		await updateEntitySource(input.env.APP_DB, {
			id: ensuredSource.id,
			userId: input.userId,
			publishedCommit,
			indexedCommit: publishedCommit,
		})
		if (input.row.source_id !== ensuredSource.id) {
			await updateMcpSkill(input.env.APP_DB, input.userId, input.row.name, {
				name: input.row.name,
				title: input.row.title,
				description: input.row.description,
				source_id: ensuredSource.id,
				keywords: input.row.keywords,
				code: input.row.code,
				search_text: input.row.search_text,
				uses_capabilities: input.row.uses_capabilities,
				parameters: input.row.parameters,
				collection_name: input.row.collection_name,
				collection_slug: input.row.collection_slug,
				inferred_capabilities: input.row.inferred_capabilities,
				inference_partial: input.row.inference_partial,
				read_only: input.row.read_only,
				idempotent: input.row.idempotent,
				destructive: input.row.destructive,
			})
		}
		return {
			kind: 'skill',
			id: input.row.id,
			title: input.row.title,
			status: 'migrated',
			reason: 'Published repo-backed source snapshot from legacy inline skill source.',
			sourceId: ensuredSource.id,
			publishedCommit,
		}
	} catch (error) {
		return {
			kind: 'skill',
			id: input.row.id,
			title: input.row.title,
			status: 'error',
			reason: formatBackfillError(error),
			sourceId: input.row.source_id,
			publishedCommit: null,
		}
	}
}

async function backfillJob(input: {
	row: JobRow
	env: Env
	userId: string
	baseUrl: string
	dryRun: boolean
}): Promise<SourceBackfillEntityResult> {
	try {
		const existingSource = await getExistingEntitySource({
			db: input.env.APP_DB,
			userId: input.userId,
			entityKind: 'job',
			entityId: input.row.record.id,
			sourceId: input.row.record.sourceId,
		})
		if (existingSource?.published_commit) {
			if (
				!input.dryRun &&
				input.row.record.publishedCommit !== existingSource.published_commit
			) {
				await updateJobRow({
					db: input.env.APP_DB,
					userId: input.userId,
					job: {
						...input.row.record,
						sourceId: existingSource.id,
						publishedCommit: existingSource.published_commit,
					},
					callerContextJson: input.row.callerContextJson,
				})
			}
			return {
				kind: 'job',
				id: input.row.record.id,
				title: input.row.record.name,
				status: 'skipped',
				reason: 'Repo-backed source already published.',
				sourceId: existingSource.id,
				publishedCommit: existingSource.published_commit,
			}
		}
		if (!input.row.record.code?.trim()) {
			throw new Error(
				'Job has no inline code available for backfill and no published repo source to preserve.',
			)
		}

		if (input.dryRun) {
			return {
				kind: 'job',
				id: input.row.record.id,
				title: input.row.record.name,
				status: 'planned',
				reason: 'Would create and publish a repo-backed source snapshot.',
				sourceId: existingSource?.id ?? input.row.record.sourceId,
				publishedCommit: existingSource?.published_commit ?? null,
			}
		}

		const ensuredSource = await ensureEntitySource({
			db: input.env.APP_DB,
			env: input.env,
			id: input.row.record.sourceId ?? undefined,
			userId: input.userId,
			entityKind: 'job',
			entityId: input.row.record.id,
			sourceRoot: '/',
			requirePersistence: true,
		})
		const nextRecord = {
			...input.row.record,
			sourceId: ensuredSource.id,
		}
		const publishedCommit = await syncArtifactSourceSnapshot({
			env: input.env,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceId: ensuredSource.id,
			files: buildJobSourceFiles({
				job: toJobView(nextRecord),
			}),
		})
		if (!publishedCommit) {
			throw new Error('Job backfill could not publish a repo-backed source snapshot.')
		}
		await updateEntitySource(input.env.APP_DB, {
			id: ensuredSource.id,
			userId: input.userId,
			publishedCommit,
			indexedCommit: publishedCommit,
		})
		await updateJobRow({
			db: input.env.APP_DB,
			userId: input.userId,
			job: {
				...nextRecord,
				publishedCommit,
			},
			callerContextJson: input.row.callerContextJson,
		})
		return {
			kind: 'job',
			id: input.row.record.id,
			title: input.row.record.name,
			status: 'migrated',
			reason: 'Published repo-backed source snapshot from legacy inline job code.',
			sourceId: ensuredSource.id,
			publishedCommit,
		}
	} catch (error) {
		return {
			kind: 'job',
			id: input.row.record.id,
			title: input.row.record.name,
			status: 'error',
			reason: formatBackfillError(error),
			sourceId: input.row.record.sourceId,
			publishedCommit: input.row.record.publishedCommit,
		}
	}
}

function parseJsonStringArray(raw: string): Array<string> {
	try {
		const parsed = JSON.parse(raw) as unknown
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === 'string')
			: []
	} catch {
		return []
	}
}

function parseOptionalJsonStringArray(raw: string | null): Array<string> | null {
	return raw == null ? null : parseJsonStringArray(raw)
}

function formatBackfillError(error: unknown) {
	if (error instanceof Error) return error.message
	return String(error)
}

async function getExistingEntitySource(input: {
	db: D1Database
	userId: string
	entityKind: BackfillEntityKind
	entityId: string
	sourceId: string | null
}) {
	if (input.sourceId) {
		return await getEntitySourceById(input.db, input.sourceId)
	}
	return await getEntitySourceByEntity(input.db, {
		userId: input.userId,
		entityKind: input.entityKind,
		entityId: input.entityId,
	})
}
