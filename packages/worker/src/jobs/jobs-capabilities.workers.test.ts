import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { capabilityMap } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

async function ensureJobsTable() {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			server_code TEXT NOT NULL,
			server_code_id TEXT NOT NULL,
			schedule_json TEXT NOT NULL,
			timezone TEXT NOT NULL DEFAULT 'America/Denver',
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id)`,
	).run()
}

function createCapabilityContext(): CapabilityContext {
	return {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-123',
				email: 'user@example.com',
				displayName: 'Jobs Tester',
			},
		}),
	}
}

function createJobCode(flavor: string) {
	return `
		import { DurableObject } from 'cloudflare:workers'

		export class Job extends DurableObject {
			async run() {
				const count = Number(this.ctx.storage.kv.get('count') ?? 0) + 1
				this.ctx.storage.kv.put('count', count)
				return { count, flavor: '${flavor}' }
			}

			async readState() {
				return {
					count: Number(this.ctx.storage.kv.get('count') ?? 0),
					flavor: '${flavor}',
				}
			}

			async setCount(nextCount) {
				this.ctx.storage.kv.put('count', Number(nextCount ?? 0))
				return await this.readState()
			}
		}
	`.trim()
}

const failingJobCode = `
	import { DurableObject } from 'cloudflare:workers'

	export class Job extends DurableObject {
		async run() {
			throw new Error('boom from job')
		}
	}
`.trim()

test('job capabilities create, update, run, and delete cron jobs end-to-end', async () => {
	await ensureJobsTable()
	const ctx = createCapabilityContext()
	const createJob = capabilityMap['job_create']!.handler
	const jobList = capabilityMap['job_list']!.handler
	const jobGet = capabilityMap['job_get']!.handler
	const jobUpdate = capabilityMap['job_update']!.handler
	const jobRunNow = capabilityMap['job_run_now']!.handler
	const jobHistory = capabilityMap['job_history']!.handler
	const jobServerExec = capabilityMap['job_server_exec']!.handler
	const jobDelete = capabilityMap['job_delete']!.handler
	const created = await createJob(
		{
			name: 'Morning sync',
			serverCode: createJobCode('alpha'),
			schedule: { cron: '0 8 * * *' },
			timezone: 'America/Denver',
			enabled: true,
		},
		ctx,
	)

	expect(created.name).toBe('Morning sync')
	expect(created.scheduleSummary).toContain('cron')
	expect(typeof created.nextRunAt).toBe('string')

	const listed = await jobList({}, ctx)
	expect(listed.map((job: { id: string }) => job.id)).toContain(created.id)

	const fetched = await jobGet({ job_id: created.id }, ctx)
	expect(fetched.id).toBe(created.id)

	const alarmRan = await runDurableObjectAlarm(
		env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName(created.id)),
	)
	expect(alarmRan).toBe(true)

	const historyAfterAlarm = await jobHistory(
		{ job_id: created.id, limit: 10 },
		ctx,
	)
	expect(historyAfterAlarm).toHaveLength(1)
	expect(historyAfterAlarm[0]).toMatchObject({
		trigger: 'alarm',
		status: 'success',
		error: null,
	})

	const updated = await jobUpdate(
		{
			job_id: created.id,
			patch: {
				name: 'Morning sync beta',
				serverCode: createJobCode('beta'),
			},
		},
		ctx,
	)
	expect(updated.name).toBe('Morning sync beta')
	expect(updated.serverCodeId).not.toBe(created.serverCodeId)

	const runNow = await jobRunNow({ job_id: created.id }, ctx)
	expect(runNow.execution).toMatchObject({
		ok: true,
		result: {
			count: 2,
			flavor: 'beta',
		},
	})
	expect(runNow.job.runCount).toBe(2)
	expect(runNow.job.successCount).toBe(2)

	const trivialExec = await jobServerExec(
		{
			job_id: created.id,
			code: `
				return {
					hello: 'world',
					source: params.source,
				}
			`,
			params: {
				source: 'throwaway-worker',
			},
		},
		ctx,
	)
	expect(trivialExec).toEqual({
		ok: true,
		job_id: created.id,
		result: {
			hello: 'world',
			source: 'throwaway-worker',
		},
	})

	await expect(
		jobServerExec(
			{
				job_id: created.id,
				code: `
					return await job.call('readState')
				`,
			},
			ctx,
		),
	).rejects.toThrow('#<Response>')

	const deleted = await jobDelete({ job_id: created.id }, ctx)
	expect(deleted).toEqual({
		job_id: created.id,
		deleted: true,
	})

	const listedAfterDelete = await jobList({}, ctx)
	expect(listedAfterDelete).toEqual([])
})

test('job capabilities handle interval jobs, enable/disable, kill switch, and error history', async () => {
	await ensureJobsTable()
	const ctx = createCapabilityContext()
	const createJob = capabilityMap['job_create']!.handler
	const jobEnable = capabilityMap['job_enable']!.handler
	const jobDisable = capabilityMap['job_disable']!.handler
	const jobUpdate = capabilityMap['job_update']!.handler
	const jobRunNow = capabilityMap['job_run_now']!.handler
	const jobHistory = capabilityMap['job_history']!.handler
	const jobGet = capabilityMap['job_get']!.handler
	const created = await createJob(
		{
			name: 'Interval watcher',
			serverCode: createJobCode('interval'),
			schedule: { intervalMs: 60_000 },
			enabled: false,
		},
		ctx,
	)

	expect(created.enabled).toBe(false)
	expect(created.nextRunAt).toBeNull()

	const skippedWhileDisabled = await jobRunNow({ job_id: created.id }, ctx)
	expect(skippedWhileDisabled.execution).toEqual({
		ok: false,
		skipped: true,
	})

	const enabled = await jobEnable({ job_id: created.id }, ctx)
	expect(enabled.enabled).toBe(true)
	expect(enabled.nextRunAt).toEqual(expect.any(String))
	expect(enabled.scheduleSummary).toContain('Runs every')

	const killSwitched = await jobUpdate(
		{
			job_id: created.id,
			patch: {
				kill_switch_enabled: true,
			},
		},
		ctx,
	)
	expect(killSwitched.killSwitchEnabled).toBe(true)

	const skippedWhileKillSwitched = await jobRunNow({ job_id: created.id }, ctx)
	expect(skippedWhileKillSwitched.execution).toEqual({
		ok: false,
		skipped: true,
	})

	const failing = await jobUpdate(
		{
			job_id: created.id,
			patch: {
				kill_switch_enabled: false,
				serverCode: failingJobCode,
			},
		},
		ctx,
	)
	expect(failing.killSwitchEnabled).toBe(false)

	const failedRun = await jobRunNow({ job_id: created.id }, ctx)
	expect(failedRun.execution).toMatchObject({
		ok: false,
		error: {
			message: 'boom from job',
		},
	})

	const history = await jobHistory({ job_id: created.id, limit: 10 }, ctx)
	expect(history[0]).toMatchObject({
		trigger: 'run_now',
		status: 'failure',
		error: {
			message: 'boom from job',
		},
	})

	const fetched = await jobGet({ job_id: created.id }, ctx)
	expect(fetched.lastError).toMatchObject({
		message: 'boom from job',
	})
	expect(fetched.failureCount).toBe(1)

	const disabled = await jobDisable({ job_id: created.id }, ctx)
	expect(disabled.enabled).toBe(false)
	expect(disabled.nextRunAt).toBeNull()

	const alarmRan = await runDurableObjectAlarm(
		env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName(created.id)),
	)
	expect(alarmRan).toBe(false)
})
