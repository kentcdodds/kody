import { z } from 'zod'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { sendSystemEmail } from '#worker/email/system-outbound.ts'
import {
	disableEnablement,
	insertEnablement,
	listEnablementsForInstance,
} from '#worker/enablements/repo.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { deleteSavedPackageProjection } from '#worker/package-registry/service.ts'
import { resolvePublishedJobSource } from '#worker/jobs/inspect-published-source.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import {
	runLegacyJobRetire,
	buildMovedJobPackageFiles,
	type LegacyJob,
	type LegacyJobRetireDeps,
} from '#worker/jobs/legacy-job-retire.ts'
import {
	buildPackageJobId,
	packageIdFromJobId,
} from '#worker/jobs/package-job-id.ts'
import {
	deleteEntitySourceWithArtifacts,
	deleteJob,
	deleteJobEntitySource,
} from '#worker/jobs/service.ts'
import {
	getEntitySourceByEntity,
	getEntitySourceByIdForUser,
} from '#worker/repo/entity-sources.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { createSavedPackageFromFiles } from '#mcp/capabilities/packages/create-stub-package.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const jobsPageSize = 200

const scheduleSchema = z.union([
	z.object({ type: z.literal('cron'), expression: z.string().min(1) }),
	z.object({ type: z.literal('interval'), every: z.string().min(1) }),
])

const decisionSchema = z.discriminatedUnion('action', [
	z.object({
		job_id: z.string().min(1),
		action: z.literal('move'),
		package_kody_id: z
			.string()
			.min(1)
			.describe('Name leaf of the new private package in the job org.'),
		description: z
			.string()
			.min(1)
			.max(200)
			.describe('package.json#kody.description and README intent.'),
		schedule: scheduleSchema
			.optional()
			.describe(
				'Replaces the legacy schedule, e.g. to meet the owner plan interval floor.',
			),
	}),
	z.object({
		job_id: z.string().min(1),
		action: z.literal('delete'),
	}),
])

const rowSchema = z.object({
	job_id: z.string(),
	org_id: z.string(),
	org_slug: z.string(),
	job_name: z.string(),
	schedule_summary: z.string(),
	enabled: z.boolean(),
	last_run_at: z.string().nullable(),
	last_run_status: z.string().nullable(),
	action: z.enum(['move', 'delete']),
	package_name: z.string().nullable(),
	recipient: z.string().nullable(),
	notice: z.object({ subject: z.string(), text: z.string() }),
	outcome: z.enum(['planned', 'notified', 'moved', 'deleted']),
	moved: z
		.object({
			package_id: z.string(),
			package_name: z.string(),
			job_id: z.string(),
		})
		.nullable(),
})

async function listLegacyJobs(env: Env): Promise<Array<LegacyJob>> {
	const jobs: Array<LegacyJob> = []
	let afterId: string | null = null
	for (;;) {
		const page = await jobsData(env).listJobsPage({
			afterId,
			limit: jobsPageSize,
		})
		for (const row of page) {
			if (packageIdFromJobId(row.record.id) != null) continue
			jobs.push({
				record: row.record,
				creatorUserId:
					row.created_by_user_id ?? row.callerContext?.user?.userId ?? null,
			})
		}
		if (page.length < jobsPageSize) return jobs
		afterId = page.at(-1)?.record.id ?? null
	}
}

async function assertKeyValueOnlyStorage(input: {
	env: Env
	orgId: string
	storageId: string
}) {
	const tables = await storageRunnerRpc({
		env: input.env,
		userId: ownerIdFromStored(input.orgId),
		storageId: input.storageId,
	}).sqlQuery({
		query: `SELECT name FROM sqlite_master
			WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'
			  AND name NOT LIKE 'sqlite%'`,
	})
	if (tables.rows.length > 0) {
		throw new Error(
			`Storage "${input.storageId}" holds SQL tables; only key/value entries are copied.`,
		)
	}
}

async function copyJobStorage(input: {
	env: Env
	orgId: string
	fromStorageId: string
	toStorageId: string
}) {
	const userId = ownerIdFromStored(input.orgId)
	const source = storageRunnerRpc({
		env: input.env,
		userId,
		storageId: input.fromStorageId,
	})
	const target = storageRunnerRpc({
		env: input.env,
		userId,
		storageId: input.toStorageId,
	})
	let startAfter: string | null = null
	do {
		const page = await source.listValues({ startAfter, pageSize: 100 })
		for (const entry of page.entries) {
			await target.setValue({ key: entry.key, value: entry.value })
		}
		startAfter = page.nextStartAfter
	} while (startAfter)
}

async function deleteLegacyJob(env: Env, job: LegacyJob) {
	const orgId = String(job.record.userId)
	const enablements = await listEnablementsForInstance({
		db: env.APP_DB,
		orgId,
		triggerKind: 'cron',
		instanceId: job.record.id,
	})
	await deleteJob({
		env,
		userId: ownerIdFromStored(orgId),
		jobId: job.record.id,
	})
	for (const enablement of enablements) {
		await disableEnablement({ db: env.APP_DB, orgId, id: enablement.id })
	}
}

export function defaultLegacyJobRetireDeps(input: {
	env: Env
	baseUrl: string
}): LegacyJobRetireDeps {
	const { env, baseUrl } = input
	return {
		listLegacyJobs: () => listLegacyJobs(env),
		async sendNotice(notice) {
			await sendSystemEmail({
				env,
				to: notice.to,
				subject: notice.subject,
				text: notice.text,
			})
		},
		async moveJob({ job, owner, packageKodyId, description, schedule }) {
			const { record } = job
			const orgId = ownerIdFromStored(owner.orgId)
			if (!owner.email) {
				throw new Error(`@${owner.username} has no email for entitlements.`)
			}
			const resolved = await resolvePublishedJobSource({
				env,
				userId: owner.orgId,
				job: record,
			})
			if (resolved.packageContext) {
				throw new Error(`Job "${record.id}" is already package-backed.`)
			}
			const files = buildMovedJobPackageFiles({
				ownerScope: owner.orgSlug,
				packageKodyId,
				description,
				jobName: record.name,
				entryPoint: resolved.entryPoint,
				manifestPath: resolved.source.manifest_path,
				schedule,
				timezone: record.timezone,
				enabled: record.enabled,
				sourceFiles: resolved.files,
			})
			await assertWithinEntitlement({
				db: env.APP_DB,
				userId: orgId,
				email: owner.email,
				resource: 'saved_packages',
			})
			await assertKeyValueOnlyStorage({
				env,
				orgId: owner.orgId,
				storageId: record.storageId,
			})
			const legacyEnablements = await listEnablementsForInstance({
				db: env.APP_DB,
				orgId: owner.orgId,
				triggerKind: 'cron',
				instanceId: record.id,
			})
			const paused = legacyEnablements.find(
				(enablement) => enablement.state !== 'on',
			)
			if (paused) {
				throw new Error(
					`Enablement "${paused.id}" for job "${record.id}" is ${paused.state}; resolve it before moving.`,
				)
			}
			const actorUserId = personIdFromStored(owner.personId)
			const packageId = crypto.randomUUID()
			const insertedEnablementIds: Array<string> = []
			let moved: { packageId: string; packageName: string; jobId: string }
			try {
				const created = await createSavedPackageFromFiles({
					env,
					baseUrl,
					owner: {
						ownerUserId: orgId,
						ownerScope: owner.orgSlug,
						ownerEmail: owner.email,
						actorUserId,
					},
					files,
					packageId,
				})
				const packageJobId = buildPackageJobId(packageId, record.name)
				const packageJob = await jobsData(env).getJobById({
					userId: owner.orgId,
					jobId: packageJobId,
				})
				if (!packageJob) {
					throw new Error(
						`Package ${created.name} published but job "${packageJobId}" was not created.`,
					)
				}
				const updated = await jobsData(env).updateJob({
					userId: owner.orgId,
					job: {
						...packageJob.record,
						params: record.params ?? packageJob.record.params,
						killSwitchEnabled: record.killSwitchEnabled,
						expiresAt: record.expiresAt,
						updatedAt: new Date().toISOString(),
					},
					callerContextJson: packageJob.callerContextJson,
				})
				if (!updated) {
					throw new Error(`Job "${packageJobId}" settings were not saved.`)
				}
				await copyJobStorage({
					env,
					orgId: owner.orgId,
					fromStorageId: record.storageId,
					toStorageId: packageJob.record.storageId,
				})
				for (const enablement of legacyEnablements) {
					const inserted = await insertEnablement({
						db: env.APP_DB,
						enablement: {
							orgId: owner.orgId,
							packageId,
							triggerKind: 'cron',
							triggerName: record.name,
							instanceId: packageJobId,
							enablerUserId: enablement.enablerUserId,
							origin: 'migrated',
						},
					})
					insertedEnablementIds.push(inserted.id)
				}
				moved = {
					packageId,
					packageName: created.name,
					jobId: packageJobId,
				}
			} catch (error) {
				return await rollBackMove(error)
			}
			try {
				await deleteLegacyJob(env, job)
			} catch (error) {
				// deleteJob removes the legacy source before the row, so roll back only
				// while the legacy job is still whole; otherwise the package job is the
				// only runnable copy.
				const legacyRow = await jobsData(env).getJobById({
					userId: owner.orgId,
					jobId: record.id,
				})
				const legacySource = legacyRow
					? await getEntitySourceByIdForUser(env.APP_DB, {
							id: record.sourceId,
							userId: orgId,
						})
					: null
				if (legacyRow && legacySource) return await rollBackMove(error)
				if (legacyRow) {
					throw new Error(
						`Job "${record.id}" moved to "${moved.jobId}" but its legacy row survived without a source; retry it with a delete decision.`,
						{ cause: error },
					)
				}
				throw error
			}
			return moved

			async function rollBackMove(error: unknown): Promise<never> {
				try {
					for (const id of insertedEnablementIds) {
						await disableEnablement({ db: env.APP_DB, orgId: owner.orgId, id })
					}
					await deleteSavedPackageProjection({
						env,
						userId: orgId,
						packageId,
						actorUserId,
					})
					// A publish that failed before insertSavedPackage leaves only the source.
					const leftoverSource = await getEntitySourceByEntity(env.APP_DB, {
						userId: orgId,
						entityKind: 'package',
						entityId: packageId,
					})
					if (leftoverSource) {
						await deleteEntitySourceWithArtifacts({
							env,
							userId: orgId,
							source: leftoverSource,
						})
					}
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Move of job "${record.id}" failed and rollback of package "${packageId}" also failed.`,
					)
				}
				throw error
			}
		},
		async deleteJob({ job }) {
			await deleteLegacyJob(env, job)
		},
		async deleteOrphanJobSource({ source }) {
			const userId = ownerIdFromStored(source.orgId)
			const row = await getEntitySourceByIdForUser(env.APP_DB, {
				id: source.sourceId,
				userId,
			})
			if (!row) {
				throw new Error(`Job source "${source.sourceId}" was not found.`)
			}
			await deleteJobEntitySource({ env, userId, source: row })
		},
	}
}

export const adminLegacyJobsRetireCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminLegacyJobsRetire',
		description:
			'Admin-only, one-shot ADR 0032 cleanup of the last non-package (unattached) job rows. Pass one decision per surviving row: move (publish its source as a new private package job in the same org, carrying params, storage and enablement, then delete the legacy row) or delete (remove the row, its source, storage and enablements). Refuses unless the decisions cover every legacy row exactly once. dry-run writes nothing and returns each owner notice. notify emails each owner that notice. apply performs moves, then deletes, then deletes job sources whose job row is already gone, and requires owners_notified: true. Audited.',
		keywords: [
			'admin',
			'jobs',
			'legacy',
			'unattached',
			'migration',
			'ADR 0032',
		],
		destructive: true,
		inputSchema: z.object({
			mode: z
				.enum(['dry-run', 'notify', 'apply'])
				.describe('dry-run writes nothing. notify sends email. apply writes.'),
			decisions: z.array(decisionSchema).max(100),
			owners_notified: z
				.boolean()
				.optional()
				.describe(
					'Required true for apply: every owner got the notify notice.',
				),
		}),
		outputSchema: z.object({
			mode: z.enum(['dry-run', 'notify', 'apply']),
			notices_sent: z.number().int().nonnegative(),
			remaining_legacy_jobs: z.number().int().nonnegative(),
			rows: z.array(rowSchema),
			orphan_job_sources: z.array(
				z.object({
					source_id: z.string(),
					org_id: z.string(),
					org_slug: z.string().nullable(),
					entity_id: z.string(),
					published_commit: z.string().nullable(),
					created_at: z.string(),
					outcome: z.enum(['planned', 'deleted']),
				}),
			),
			remaining_job_sources: z.number().int().nonnegative(),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminLegacyJobsRetire',
				async () => {
					const baseUrl = getAppBaseUrl({
						env: ctx.env,
						requestUrl: ctx.callerContext.baseUrl,
					})
					const report = await runLegacyJobRetire({
						db: ctx.env.APP_DB,
						mode: args.mode,
						ownersNotified: args.owners_notified,
						baseUrl,
						deps: defaultLegacyJobRetireDeps({ env: ctx.env, baseUrl }),
						decisions: args.decisions.map((decision) =>
							decision.action === 'move'
								? {
										jobId: decision.job_id,
										action: 'move' as const,
										packageKodyId: decision.package_kody_id,
										description: decision.description,
										...(decision.schedule
											? { schedule: decision.schedule }
											: {}),
									}
								: { jobId: decision.job_id, action: 'delete' as const },
						),
					})
					return {
						mode: report.mode,
						notices_sent: report.noticesSent,
						remaining_legacy_jobs: report.remainingLegacyJobs,
						rows: report.rows.map((row) => ({
							job_id: row.jobId,
							org_id: row.orgId,
							org_slug: row.orgSlug,
							job_name: row.jobName,
							schedule_summary: row.scheduleSummary,
							enabled: row.enabled,
							last_run_at: row.lastRunAt,
							last_run_status: row.lastRunStatus,
							action: row.action,
							package_name: row.packageName,
							recipient: row.recipient,
							notice: row.notice,
							outcome: row.outcome,
							moved: row.moved
								? {
										package_id: row.moved.packageId,
										package_name: row.moved.packageName,
										job_id: row.moved.jobId,
									}
								: null,
						})),
						orphan_job_sources: report.orphanJobSources.map((source) => ({
							source_id: source.sourceId,
							org_id: source.orgId,
							org_slug: source.orgSlug,
							entity_id: source.entityId,
							published_commit: source.publishedCommit,
							created_at: source.createdAt,
							outcome: source.outcome,
						})),
						remaining_job_sources: report.remainingJobSources,
					}
				},
				{
					successReason: (result) =>
						`mode=${result.mode};rows=${result.rows.length};notices=${result.notices_sent};remaining=${result.remaining_legacy_jobs};orphan_sources=${result.orphan_job_sources.length};remaining_sources=${result.remaining_job_sources}`,
				},
			)
		},
	},
)
