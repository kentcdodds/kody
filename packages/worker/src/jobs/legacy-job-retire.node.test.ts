/**
 * Legacy non-package job retirement against a migrated APP_DB with real
 * users and personal orgs. Listing, email, move and delete are injected.
 */
import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	buildLegacyJobNotice,
	buildMovedJobPackageFiles,
	runLegacyJobRetire,
	type LegacyJob,
	type LegacyJobDecision,
	type LegacyJobRetireDeps,
} from './legacy-job-retire.ts'
import { type JobRecord, type JobSchedule } from './types.ts'

const now = '2026-10-11T00:00:00.000Z'
const baseUrl = 'https://kody.example'

function jobRecord(
	overrides: Partial<JobRecord> & Pick<JobRecord, 'id' | 'userId' | 'name'>,
): JobRecord {
	return {
		version: 1,
		sourceId: `source-${overrides.id}`,
		publishedCommit: 'commit-1',
		storageId: `job:${overrides.id}`,
		schedule: { type: 'interval', every: '15m' },
		timezone: 'America/Denver',
		enabled: true,
		killSwitchEnabled: false,
		preserved: false,
		expiresAt: null,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
		lastRunAt: '2026-10-10T12:00:00.000Z',
		lastRunStatus: 'success',
		nextRunAt: '2026-10-11T00:15:00.000Z',
		runCount: 10,
		successCount: 10,
		errorCount: 0,
		...overrides,
	}
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const people = {
		alice: testStableUserIdFromEmail('alice@example.com'),
		bob: testStableUserIdFromEmail('bob@example.com'),
		nomail: testStableUserIdFromEmail('nomail@example.com'),
	}
	for (const [username, stableUserId] of Object.entries(people)) {
		await db
			.prepare(
				`INSERT INTO users (
					username, email, password_hash, created_at, updated_at, stable_user_id
				) VALUES (?, ?, 'hash', ?, ?, ?)`,
			)
			.bind(username, `${username}@example.com`, now, now, stableUserId)
			.run()
		await provisionPersonalOrg(db, { stableUserId, username, createdAt: now })
	}
	async function orgIdFor(slug: string) {
		const row = await db
			.prepare(`SELECT id FROM orgs WHERE slug = ?`)
			.bind(slug)
			.first<{ id: string }>()
		return ownerIdFromStored(row!.id)
	}
	const orgs = {
		alice: await orgIdFor('alice'),
		bob: await orgIdFor('bob'),
		nomail: await orgIdFor('nomail'),
	}

	const fleet: Array<LegacyJob> = [
		{
			record: jobRecord({
				id: 'legacy-move',
				userId: orgs.alice,
				name: 'Health watch',
				schedule: { type: 'interval', every: '10m' },
			}),
			creatorUserId: people.alice,
		},
		{
			record: jobRecord({
				id: 'legacy-delete',
				userId: orgs.bob,
				name: 'Trending models',
				schedule: { type: 'cron', expression: '0 8 * * *' },
				lastRunStatus: 'error',
			}),
			creatorUserId: people.bob,
		},
	]
	const insertJobSource = sqlite.prepare(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, created_at, updated_at
		) VALUES (?, ?, 'job', ?, ?, ?, ?)`,
	)
	for (const job of fleet) {
		insertJobSource.run(
			job.record.sourceId,
			String(job.record.userId),
			job.record.id,
			`job-${job.record.id}`,
			now,
			now,
		)
	}
	insertJobSource.run(
		'source-orphan',
		String(orgs.alice),
		'deleted-long-ago',
		'job-deleted-long-ago',
		'2026-05-10T13:32:35.303Z',
		now,
	)
	const deleteSource = sqlite.prepare(`DELETE FROM entity_sources WHERE id = ?`)
	const calls: Array<string> = []
	const notices: Array<{ to: string; subject: string; text: string }> = []
	const deps: LegacyJobRetireDeps = {
		async listLegacyJobs() {
			return [...fleet]
		},
		async sendNotice(notice) {
			calls.push(`notice ${notice.to}`)
			notices.push(notice)
		},
		async moveJob({ job, owner, packageKodyId, schedule }) {
			calls.push(
				`move ${job.record.id} @${owner.orgSlug}/${packageKodyId} ${JSON.stringify(schedule)}`,
			)
			fleet.splice(fleet.indexOf(job), 1)
			deleteSource.run(job.record.sourceId)
			return {
				packageId: `pkg-${packageKodyId}`,
				packageName: `@${owner.orgSlug}/${packageKodyId}`,
				jobId: `package-job:pkg-${packageKodyId}:${encodeURIComponent(job.record.name)}`,
			}
		},
		async deleteJob({ job }) {
			calls.push(`delete ${job.record.id}`)
			fleet.splice(fleet.indexOf(job), 1)
			deleteSource.run(job.record.sourceId)
		},
		async deleteOrphanJobSource({ source }) {
			calls.push(`delete source ${source.sourceId}`)
			deleteSource.run(source.sourceId)
		},
	}
	const decisions: Array<LegacyJobDecision> = [
		{
			jobId: 'legacy-delete',
			action: 'delete',
		},
		{
			jobId: 'legacy-move',
			action: 'move',
			packageKodyId: 'health-watch',
			description: 'Checks the demo site every 15 minutes.',
			schedule: { type: 'interval', every: '15m' },
		},
	]
	return { sqlite, db, people, orgs, fleet, calls, notices, deps, decisions }
}

test('dry-run plans every row with its owner notice and writes nothing', async () => {
	const { db, deps, decisions, calls } = await setup()
	const report = await runLegacyJobRetire({
		db,
		mode: 'dry-run',
		decisions,
		baseUrl,
		deps,
	})
	expect(calls).toEqual([])
	expect(report.noticesSent).toBe(0)
	expect(report.remainingLegacyJobs).toBe(2)
	expect(report.remainingJobSources).toBe(3)
	expect(report.orphanJobSources).toEqual([
		{
			sourceId: 'source-orphan',
			orgId: expect.any(String),
			orgSlug: 'alice',
			entityId: 'deleted-long-ago',
			publishedCommit: null,
			createdAt: '2026-05-10T13:32:35.303Z',
			outcome: 'planned',
		},
	])
	expect(
		report.rows.map((row) => ({
			jobId: row.jobId,
			orgSlug: row.orgSlug,
			action: row.action,
			packageName: row.packageName,
			recipient: row.recipient,
			outcome: row.outcome,
		})),
	).toEqual([
		{
			jobId: 'legacy-delete',
			orgSlug: 'bob',
			action: 'delete',
			packageName: null,
			recipient: '***@example.com',
			outcome: 'planned',
		},
		{
			jobId: 'legacy-move',
			orgSlug: 'alice',
			action: 'move',
			packageName: '@alice/health-watch',
			recipient: '***@example.com',
			outcome: 'planned',
		},
	])
	expect(report.rows[0]!.notice.subject).toBe(
		'Kody: your scheduled job "Trending models" will be removed',
	)
	expect(report.rows[1]!.notice.subject).toBe(
		'Kody: your scheduled job "Health watch" is moving into a package',
	)
})

test('refuses a run unless every legacy row has exactly one valid decision', async () => {
	const { db, deps, decisions } = await setup()
	const run = (next: Array<LegacyJobDecision>) =>
		runLegacyJobRetire({ db, mode: 'dry-run', decisions: next, baseUrl, deps })

	await expect(run(decisions.slice(0, 1))).rejects.toThrow(
		'job "legacy-move" has no decision',
	)
	await expect(
		run([...decisions, { jobId: 'not-legacy', action: 'delete' }]),
	).rejects.toThrow('job "not-legacy" is not a legacy non-package job')
	await expect(
		run([...decisions, { jobId: 'legacy-delete', action: 'delete' }]),
	).rejects.toThrow('job "legacy-delete" has more than one decision')
	await expect(
		run([
			decisions[0]!,
			{
				jobId: 'legacy-move',
				action: 'move',
				packageKodyId: 'Health Watch',
				description: 'x',
			},
		]),
	).rejects.toThrow('must be lower-kebab-case')
})

test('notify emails each owner, and refuses before sending when one has no email', async () => {
	const { sqlite, db, deps, decisions, calls, notices, people } = await setup()
	const report = await runLegacyJobRetire({
		db,
		mode: 'notify',
		decisions,
		baseUrl,
		deps,
	})
	expect(report.noticesSent).toBe(2)
	expect(calls).toEqual(['notice bob@example.com', 'notice alice@example.com'])
	expect(notices[0]!.text).toContain('Hi @bob,')
	expect(report.rows.every((row) => row.outcome === 'notified')).toBe(true)

	calls.length = 0
	sqlite
		.prepare(`UPDATE users SET email = '' WHERE stable_user_id = ?`)
		.run(people.alice)
	await expect(
		runLegacyJobRetire({ db, mode: 'notify', decisions, baseUrl, deps }),
	).rejects.toThrow('No email to notify for: job "legacy-move" (@alice)')
	expect(calls).toEqual([])
})

test('apply requires owners_notified, moves before deletes, then drops orphan sources', async () => {
	const { db, deps, decisions, calls, fleet } = await setup()
	await expect(
		runLegacyJobRetire({ db, mode: 'apply', decisions, baseUrl, deps }),
	).rejects.toThrow('run notify first and pass owners_notified: true')
	expect(calls).toEqual([])

	const report = await runLegacyJobRetire({
		db,
		mode: 'apply',
		decisions,
		ownersNotified: true,
		baseUrl,
		deps,
	})
	expect(calls).toEqual([
		'move legacy-move @alice/health-watch {"type":"interval","every":"15m"}',
		'delete legacy-delete',
		'delete source source-orphan',
	])
	expect(fleet).toEqual([])
	expect(report.remainingLegacyJobs).toBe(0)
	expect(report.remainingJobSources).toBe(0)
	expect(report.orphanJobSources.map((source) => source.outcome)).toEqual([
		'deleted',
	])
	expect(report.rows.map((row) => [row.jobId, row.outcome])).toEqual([
		['legacy-move', 'moved'],
		['legacy-delete', 'deleted'],
	])
	expect(report.rows[0]!.moved).toEqual({
		packageId: 'pkg-health-watch',
		packageName: '@alice/health-watch',
		jobId: 'package-job:pkg-health-watch:Health%20watch',
	})
})

test('apply with no legacy rows left still deletes orphan job sources', async () => {
	const { db, deps, calls, fleet } = await setup()
	fleet.length = 0
	const report = await runLegacyJobRetire({
		db,
		mode: 'apply',
		decisions: [],
		ownersNotified: true,
		baseUrl,
		deps,
	})
	expect(report.rows).toEqual([])
	expect(report.remainingLegacyJobs).toBe(0)
	expect(calls).toContain('delete source source-orphan')
	expect(report.remainingJobSources).toBe(0)
	expect(
		report.orphanJobSources.every((source) => source.outcome === 'deleted'),
	).toBe(true)
})

test('apply keeps the legacy schedule when a move does not override it', async () => {
	const { db, deps, decisions, calls } = await setup()
	await runLegacyJobRetire({
		db,
		mode: 'apply',
		decisions: [
			decisions[0]!,
			{
				jobId: 'legacy-move',
				action: 'move',
				packageKodyId: 'health-watch',
				description: 'Checks the demo site.',
			},
		],
		ownersNotified: true,
		baseUrl,
		deps,
	})
	expect(calls[0]).toBe(
		'move legacy-move @alice/health-watch {"type":"interval","every":"10m"}',
	)
})

test('a failed move stops apply before any delete and names the failing row', async () => {
	const { db, deps, decisions, calls } = await setup()
	const failure = new Error('repo check failed')
	const run = runLegacyJobRetire({
		db,
		mode: 'apply',
		decisions,
		ownersNotified: true,
		baseUrl,
		deps: {
			...deps,
			async moveJob() {
				throw failure
			},
		},
	})
	await expect(run).rejects.toThrow('Legacy job move failed for "legacy-move".')
	await expect(run).rejects.toMatchObject({ cause: failure })
	expect(calls).toEqual([])
})

test('a failed delete lists the rows already done', async () => {
	const { db, deps, decisions } = await setup()
	await expect(
		runLegacyJobRetire({
			db,
			mode: 'apply',
			decisions,
			ownersNotified: true,
			baseUrl,
			deps: {
				...deps,
				async deleteJob() {
					throw new Error('storage busy')
				},
			},
		}),
	).rejects.toThrow(
		'Legacy job delete failed for "legacy-delete" after: moved legacy-move.',
	)
})

test('a failed orphan source delete lists the jobs already retired', async () => {
	const { db, deps, decisions } = await setup()
	await expect(
		runLegacyJobRetire({
			db,
			mode: 'apply',
			decisions,
			ownersNotified: true,
			baseUrl,
			deps: {
				...deps,
				async deleteOrphanJobSource() {
					throw new Error('artifact repo busy')
				},
			},
		}),
	).rejects.toThrow(
		'Orphan job source delete failed for "source-orphan" after: moved legacy-move, deleted legacy-delete.',
	)
})

test('notifies the org Owner when the creator is no longer a member', async () => {
	const { db, deps, decisions, fleet, people } = await setup()
	fleet[0]!.creatorUserId = people.nomail
	const report = await runLegacyJobRetire({
		db,
		mode: 'notify',
		decisions,
		baseUrl,
		deps,
	})
	const moveRow = report.rows.find((row) => row.jobId === 'legacy-move')
	expect(moveRow?.notice.text).toContain('Hi @alice,')
})

test('refuses a row whose org is gone', async () => {
	const { sqlite, db, deps, decisions, orgs } = await setup()
	sqlite
		.prepare(`UPDATE orgs SET deleted_at = ? WHERE id = ?`)
		.run(now, String(orgs.bob))
	await expect(
		runLegacyJobRetire({ db, mode: 'dry-run', decisions, baseUrl, deps }),
	).rejects.toThrow('which is missing or has no slug')
})

test('move notice names the package and calls out a schedule change', () => {
	const job = jobRecord({
		id: 'legacy-move',
		userId: ownerIdFromStored('org-1'),
		name: 'Health watch',
		schedule: { type: 'interval', every: '10m' },
	})
	const owner = { orgSlug: 'alice', username: 'alice' }
	const decision = (schedule?: JobSchedule): LegacyJobDecision => ({
		jobId: job.id,
		action: 'move',
		packageKodyId: 'health-watch',
		description: 'Checks the demo.',
		schedule,
	})
	const changed = buildLegacyJobNotice({
		job,
		owner,
		decision: decision({ type: 'interval', every: '15m' }),
		baseUrl,
	})
	expect(changed.text).toContain('@alice/health-watch')
	expect(changed.text).toContain('One thing changes')
	expect(changed.text).toContain('https://kody.example/@alice/-/jobs')

	const same = buildLegacyJobNotice({
		job,
		owner,
		decision: decision(),
		baseUrl,
	})
	expect(same.text).not.toContain('One thing changes')
	expect(same.text).toContain('You do not need to do anything.')
})

test('delete notice explains why and how to keep the job', () => {
	const notice = buildLegacyJobNotice({
		job: jobRecord({
			id: 'legacy-delete',
			userId: ownerIdFromStored('org-1'),
			name: 'Trending models',
			enabled: false,
			lastRunAt: '2026-09-11T16:34:00.000Z',
		}),
		owner: { orgSlug: 'bob', username: 'bob' },
		decision: { jobId: 'legacy-delete', action: 'delete' },
		baseUrl,
	})
	expect(notice.text).toContain(
		'It is turned off and last ran on September 11, 2026.',
	)
	expect(notice.text).toContain('package.json#kody.jobs')
	expect(notice.text).toContain('Reply to this email')
})

test('moved package files declare the job and drop kody.json', () => {
	const files = buildMovedJobPackageFiles({
		ownerScope: 'alice',
		packageKodyId: 'health-watch',
		description: 'Checks the demo site every 15 minutes.',
		jobName: 'Health watch',
		entryPoint: 'src/job.ts',
		manifestPath: '/kody.json',
		schedule: { type: 'interval', every: '15m' },
		timezone: 'America/Denver',
		enabled: true,
		sourceFiles: {
			'kody.json': '{"entry":"src/job.ts"}',
			'src/job.ts': 'export default async function run() {}\n',
			'README.md': '# Health watch\n\nKeeps an eye on the demo.\n',
		},
	})
	expect(Object.keys(files).sort()).toEqual([
		'AGENTS.md',
		'README.md',
		'package.json',
		'src/job.ts',
	])
	expect(files['README.md']).toBe(
		'# Health watch\n\nKeeps an eye on the demo.\n',
	)
	const manifest = parseAuthoredPackageJson({
		content: files['package.json']!,
		expectedPackageScope: 'alice',
	})
	expect(manifest.name).toBe('@alice/health-watch')
	expect(manifest.kody.jobs).toEqual({
		'Health watch': {
			entry: './src/job.ts',
			schedule: { type: 'interval', every: '15m' },
			timezone: 'America/Denver',
			enabled: true,
		},
	})
})

test('moved package files refuse a source that already has package.json or lacks the entry', () => {
	const input = {
		ownerScope: 'alice',
		packageKodyId: 'health-watch',
		description: 'x',
		jobName: 'Health watch',
		entryPoint: 'src/job.ts',
		manifestPath: 'kody.json',
		schedule: { type: 'interval', every: '15m' } as const,
		timezone: 'UTC',
		enabled: true,
	}
	expect(() =>
		buildMovedJobPackageFiles({
			...input,
			sourceFiles: { 'package.json': '{}', 'src/job.ts': '' },
		}),
	).toThrow('already has a package.json')
	expect(() =>
		buildMovedJobPackageFiles({ ...input, sourceFiles: { 'kody.json': '{}' } }),
	).toThrow('entry "src/job.ts" is missing')
})
