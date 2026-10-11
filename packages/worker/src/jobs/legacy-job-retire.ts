/**
 * One-shot retirement of the last non-package (unattached) job rows, ADR
 * 0032. Every surviving row needs an explicit decision: move it into a new
 * private package job owned by the same org, or delete it. There is no third
 * lane, so a run refuses any row left without a decision.
 *
 * - `dry-run` writes nothing and returns each row's plan and owner notice.
 * - `notify` emails each row's owner that notice.
 * - `apply` moves and deletes, and refuses to run unless the caller confirms
 *   the owners were notified.
 */
import { formatScheduleSummary } from '@kody-internal/shared/jobs/schedule.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { redactEmailRecipient } from '#worker/audit-log.ts'
import { loadEarliestLiveOwnerId } from '#worker/enablements/repo.ts'
import { kodyPackageIdPattern } from '#worker/package-registry/types.ts'
import { type JobRecord, type JobSchedule } from './types.ts'

export type LegacyJobRetireMode = 'dry-run' | 'notify' | 'apply'

export type LegacyJob = {
	record: JobRecord
	creatorUserId: string | null
}

export type LegacyJobDecision =
	| {
			jobId: string
			action: 'move'
			/** Name leaf of the new package, e.g. `inspectit-health-watch`. */
			packageKodyId: string
			/** `package.json#kody.description` and README intent. */
			description: string
			/**
			 * Replaces the legacy schedule, e.g. when it is shorter than the
			 * owner's plan interval floor (legacy rows were never checked).
			 */
			schedule?: JobSchedule
	  }
	| { jobId: string; action: 'delete' }

export type LegacyJobOwner = {
	orgId: string
	orgSlug: string
	personId: string
	username: string
	email: string | null
}

export type MovedLegacyJob = {
	packageId: string
	packageName: string
	jobId: string
}

export type LegacyJobRetireDeps = {
	/** Every non-package job row in the fleet. */
	listLegacyJobs(): Promise<Array<LegacyJob>>
	sendNotice(input: {
		to: string
		subject: string
		text: string
	}): Promise<void>
	/**
	 * Publish the job's source as a package job for the same org, carry its
	 * params, storage and enablement over, then delete the legacy row.
	 */
	moveJob(input: {
		job: LegacyJob
		owner: LegacyJobOwner
		packageKodyId: string
		description: string
		schedule: JobSchedule
	}): Promise<MovedLegacyJob>
	/** Delete the legacy row, its source, its storage and its enablements. */
	deleteJob(input: { job: LegacyJob }): Promise<void>
}

export type LegacyJobRetireRow = {
	jobId: string
	orgId: string
	orgSlug: string
	jobName: string
	scheduleSummary: string
	enabled: boolean
	lastRunAt: string | null
	lastRunStatus: string | null
	action: LegacyJobDecision['action']
	/** `@scope/leaf` for a move. */
	packageName: string | null
	recipient: string | null
	notice: { subject: string; text: string }
	outcome: 'planned' | 'notified' | 'moved' | 'deleted'
	moved: MovedLegacyJob | null
}

export type LegacyJobRetireReport = {
	mode: LegacyJobRetireMode
	rows: Array<LegacyJobRetireRow>
	noticesSent: number
	/** Non-package rows still in the fleet after this run. */
	remainingLegacyJobs: number
}

type PlannedRow = {
	job: LegacyJob
	decision: LegacyJobDecision
	owner: LegacyJobOwner
	packageName: string | null
	notice: { subject: string; text: string }
}

function formatDay(iso: string | null | undefined) {
	if (!iso) return null
	const date = new Date(iso)
	if (Number.isNaN(date.valueOf())) return null
	return new Intl.DateTimeFormat('en-US', {
		dateStyle: 'long',
		timeZone: 'UTC',
	}).format(date)
}

function describeJobState(record: JobRecord) {
	const lastRun = formatDay(record.lastRunAt)
	if (!record.enabled) {
		return `It is turned off${lastRun ? ` and last ran on ${lastRun}` : ''}.`
	}
	if (record.lastRunStatus === 'error') {
		return `It is on, but its last run${lastRun ? ` (${lastRun})` : ''} failed.`
	}
	return `It is on${lastRun ? ` and last ran on ${lastRun}` : ''}.`
}

export function buildLegacyJobNotice(input: {
	job: JobRecord
	owner: Pick<LegacyJobOwner, 'orgSlug' | 'username'>
	decision: LegacyJobDecision
	baseUrl: string
}) {
	const { job, owner, decision } = input
	const schedule = formatScheduleSummary({
		schedule: job.schedule,
		timezone: job.timezone,
	})
	const jobsUrl = new URL(`/@${owner.orgSlug}/-/jobs`, input.baseUrl).href
	const intro = [
		`Hi @${owner.username},`,
		'',
		`Kody now runs every scheduled job from a package (package.json#kody.jobs). Your job "${job.name}" in @${owner.orgSlug} is one of the few left over from before that change, when a job could live on its own.`,
		'',
		`- Schedule: ${schedule}`,
		`- ${describeJobState(job)}`,
		'',
	]
	switch (decision.action) {
		case 'move': {
			const packageName = `@${owner.orgSlug}/${decision.packageKodyId}`
			const nextSchedule = decision.schedule
				? formatScheduleSummary({
						schedule: decision.schedule,
						timezone: job.timezone,
					})
				: schedule
			const scheduleChanges = nextSchedule !== schedule
			return {
				subject: `Kody: your scheduled job "${job.name}" is moving into a package`,
				text: [
					...intro,
					scheduleChanges
						? `We are moving it into a new private package, ${packageName}, with the same code, timezone and settings. One thing changes: it will run on "${nextSchedule}" instead, the shortest interval your plan allows (older jobs were never held to it). It keeps running as you and keeps its saved state.`
						: `We are moving it into a new private package, ${packageName}, with the same code, schedule, timezone and settings. It keeps running as you and keeps its saved state. You do not need to do anything.`,
					'',
					`Afterwards it shows up on ${jobsUrl} under that package. To change it later, edit the package and publish it.`,
					'',
					'Reply to this email if you have questions or would rather we did not move it.',
				].join('\n'),
			}
		}
		case 'delete':
			return {
				subject: `Kody: your scheduled job "${job.name}" will be removed`,
				text: [
					...intro,
					'Because it is not running successfully today, we are removing it instead of moving it into a package. Nothing else in your account changes.',
					'',
					'If you still want it, ask your agent to save the job code as a package and declare it under package.json#kody.jobs. It then runs on the same schedule.',
					'',
					'Reply to this email if you want help with that, or if you would like us to hold off.',
				].join('\n'),
			}
		default: {
			const exhaustive: never = decision
			throw new Error(`Unhandled legacy job action: ${String(exhaustive)}`)
		}
	}
}

/**
 * The legacy repo's files as a package whose `kody.jobs` declares the job
 * under its existing name, entry, schedule and timezone. The legacy
 * `kody.json` manifest is dropped.
 */
export function buildMovedJobPackageFiles(input: {
	ownerScope: string
	packageKodyId: string
	description: string
	jobName: string
	entryPoint: string
	manifestPath: string
	schedule: JobSchedule
	timezone: string
	enabled: boolean
	sourceFiles: Record<string, string>
}): Record<string, string> {
	const manifestPath = input.manifestPath.replace(/^\/+/, '')
	if (Object.hasOwn(input.sourceFiles, 'package.json')) {
		throw new McpCallerError(
			`Legacy job "${input.jobName}" already has a package.json; move it by hand.`,
		)
	}
	if (!Object.hasOwn(input.sourceFiles, input.entryPoint)) {
		throw new McpCallerError(
			`Legacy job "${input.jobName}" entry "${input.entryPoint}" is missing from its source.`,
		)
	}
	const name = `@${input.ownerScope}/${input.packageKodyId}`
	const entry = `./${input.entryPoint}`
	const packageJson = {
		name,
		private: true,
		exports: { '.': entry },
		kody: {
			id: input.packageKodyId,
			description: input.description,
			jobs: {
				[input.jobName]: {
					entry,
					schedule: input.schedule,
					timezone: input.timezone,
					enabled: input.enabled,
				},
			},
		},
	}
	const files: Record<string, string> = {}
	for (const [path, content] of Object.entries(input.sourceFiles)) {
		if (path !== manifestPath) files[path] = content
	}
	files['package.json'] = `${JSON.stringify(packageJson, null, '\t')}\n`
	if (!files['README.md']?.trim()) {
		files['README.md'] = [
			`# ${name}`,
			'',
			'## Intent',
			'',
			input.description,
			'',
			`The \`${input.jobName}\` job in \`package.json#kody.jobs\` runs \`${entry}\`.`,
			'',
		].join('\n')
	}
	if (!files['AGENTS.md']?.trim()) {
		files['AGENTS.md'] = [
			`# ${name}`,
			'',
			`Scheduled job \`${input.jobName}\` runs \`${entry}\`; its params are set on the job (\`jobUpdate\`).`,
			'',
			'## Smoke tests',
			'',
			`Run it once with \`jobRunNow\` on the \`${input.jobName}\` job and check the run in Activity.`,
			'',
		].join('\n')
	}
	return files
}

async function loadOwner(
	db: D1Database,
	job: LegacyJob,
): Promise<LegacyJobOwner> {
	const orgId = String(job.record.userId)
	const org = await db
		.prepare(
			`SELECT slug FROM orgs
			 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL`,
		)
		.bind(orgId)
		.first<{ slug: string | null }>()
	if (!org?.slug) {
		throw new McpCallerError(
			`Job "${job.record.id}" belongs to org "${orgId}", which is missing or has no slug.`,
		)
	}
	const creatorIsMember = job.creatorUserId
		? await db
				.prepare(
					`SELECT 1 AS ok FROM org_memberships m
					 INNER JOIN users u ON u.stable_user_id = m.user_id
					 WHERE m.org_id = ? AND m.user_id = ? AND m.deleted_at IS NULL
					   AND u.deleted_at IS NULL AND u.deleting_at IS NULL`,
				)
				.bind(orgId, job.creatorUserId)
				.first<{ ok: number }>()
		: null
	const personId =
		creatorIsMember && job.creatorUserId
			? job.creatorUserId
			: await loadEarliestLiveOwnerId(db, orgId)
	if (!personId) {
		throw new McpCallerError(
			`Job "${job.record.id}" has no live creator or Owner in @${org.slug} to notify or run it.`,
		)
	}
	const person = await db
		.prepare(
			`SELECT username, email FROM users
			 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL`,
		)
		.bind(personId)
		.first<{ username: string; email: string | null }>()
	if (!person) {
		throw new McpCallerError(
			`Job "${job.record.id}" owner "${personId}" was not found.`,
		)
	}
	return {
		orgId,
		orgSlug: org.slug,
		personId,
		username: person.username,
		email: person.email?.trim() || null,
	}
}

function assertDecisionsCoverFleet(input: {
	jobs: ReadonlyArray<LegacyJob>
	decisions: ReadonlyArray<LegacyJobDecision>
}) {
	const legacyIds = new Set(input.jobs.map((job) => job.record.id))
	const seen = new Set<string>()
	const problems: Array<string> = []
	for (const decision of input.decisions) {
		if (seen.has(decision.jobId)) {
			problems.push(`job "${decision.jobId}" has more than one decision`)
		}
		seen.add(decision.jobId)
		if (!legacyIds.has(decision.jobId)) {
			problems.push(`job "${decision.jobId}" is not a legacy non-package job`)
		}
		if (
			decision.action === 'move' &&
			!kodyPackageIdPattern.test(decision.packageKodyId)
		) {
			problems.push(
				`job "${decision.jobId}" package name leaf "${decision.packageKodyId}" must be lower-kebab-case`,
			)
		}
	}
	for (const id of legacyIds) {
		if (!seen.has(id)) problems.push(`job "${id}" has no decision`)
	}
	if (problems.length > 0) {
		throw new McpCallerError(
			`Every legacy non-package job needs exactly one move or delete decision: ${problems.join('; ')}.`,
		)
	}
}

function toRow(
	planned: PlannedRow,
	outcome: LegacyJobRetireRow['outcome'],
	moved: MovedLegacyJob | null = null,
): LegacyJobRetireRow {
	const { record } = planned.job
	return {
		jobId: record.id,
		orgId: planned.owner.orgId,
		orgSlug: planned.owner.orgSlug,
		jobName: record.name,
		scheduleSummary: formatScheduleSummary({
			schedule: record.schedule,
			timezone: record.timezone,
		}),
		enabled: record.enabled,
		lastRunAt: record.lastRunAt ?? null,
		lastRunStatus: record.lastRunStatus ?? null,
		action: planned.decision.action,
		packageName: planned.packageName,
		recipient: planned.owner.email
			? redactEmailRecipient(planned.owner.email)
			: null,
		notice: planned.notice,
		outcome,
		moved,
	}
}

export async function runLegacyJobRetire(input: {
	db: D1Database
	mode: LegacyJobRetireMode
	decisions: ReadonlyArray<LegacyJobDecision>
	/** Required for `apply`: the owners got the `notify` notice. */
	ownersNotified?: boolean
	baseUrl: string
	deps: LegacyJobRetireDeps
}): Promise<LegacyJobRetireReport> {
	const jobs = await input.deps.listLegacyJobs()
	assertDecisionsCoverFleet({ jobs, decisions: input.decisions })
	if (input.mode === 'apply' && input.ownersNotified !== true) {
		throw new McpCallerError(
			'apply moves and deletes jobs; run notify first and pass owners_notified: true once every owner has the notice.',
		)
	}
	const jobsById = new Map(jobs.map((job) => [job.record.id, job]))
	const planned: Array<PlannedRow> = []
	for (const decision of input.decisions) {
		const job = jobsById.get(decision.jobId)
		if (!job) throw new Error(`Legacy job "${decision.jobId}" vanished.`)
		const owner = await loadOwner(input.db, job)
		planned.push({
			job,
			decision,
			owner,
			packageName:
				decision.action === 'move'
					? `@${owner.orgSlug}/${decision.packageKodyId}`
					: null,
			notice: buildLegacyJobNotice({
				job: job.record,
				owner,
				decision,
				baseUrl: input.baseUrl,
			}),
		})
	}

	const rows: Array<LegacyJobRetireRow> = []
	let noticesSent = 0
	switch (input.mode) {
		case 'dry-run':
			for (const row of planned) rows.push(toRow(row, 'planned'))
			break
		case 'notify': {
			const missingEmail = planned.filter((row) => !row.owner.email)
			if (missingEmail.length > 0) {
				throw new McpCallerError(
					`No email to notify for: ${missingEmail.map((row) => `job "${row.job.record.id}" (@${row.owner.username})`).join(', ')}.`,
				)
			}
			for (const row of planned) {
				await input.deps.sendNotice({ to: row.owner.email!, ...row.notice })
				noticesSent += 1
				rows.push(toRow(row, 'notified'))
			}
			break
		}
		case 'apply': {
			// Moves first: a failed publish stops the run before anything is deleted.
			const ordered = [
				...planned.filter((row) => row.decision.action === 'move'),
				...planned.filter((row) => row.decision.action === 'delete'),
			]
			for (const row of ordered) {
				const { decision } = row
				try {
					switch (decision.action) {
						case 'move': {
							const moved = await input.deps.moveJob({
								job: row.job,
								owner: row.owner,
								packageKodyId: decision.packageKodyId,
								description: decision.description,
								schedule: decision.schedule ?? row.job.record.schedule,
							})
							rows.push(toRow(row, 'moved', moved))
							break
						}
						case 'delete':
							await input.deps.deleteJob({ job: row.job })
							rows.push(toRow(row, 'deleted'))
							break
						default: {
							const exhaustive: never = decision
							throw new Error(
								`Unhandled legacy job action: ${String(exhaustive)}`,
							)
						}
					}
				} catch (error) {
					const done = rows.map((done) => `${done.outcome} ${done.jobId}`)
					throw new Error(
						`Legacy job ${decision.action} failed for "${row.job.record.id}"${done.length > 0 ? ` after: ${done.join(', ')}` : ''}.`,
						{ cause: error },
					)
				}
			}
			break
		}
		default: {
			const exhaustive: never = input.mode
			throw new Error(`Unhandled legacy job retire mode: ${String(exhaustive)}`)
		}
	}
	return {
		mode: input.mode,
		rows,
		noticesSent,
		remainingLegacyJobs:
			input.mode === 'apply'
				? (await input.deps.listLegacyJobs()).length
				: jobs.length,
	}
}
