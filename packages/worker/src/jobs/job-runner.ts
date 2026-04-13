import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	type FacetStorageExport,
	FacetKodyBridge,
	callFacetExec,
	callFacetStorageExport,
	callFacetStorageReset,
	createFacetStartup,
	jsonResponse,
	toFacetErrorDetails,
} from '#mcp/facet-runtime.ts'
import { getJobById } from './repo.ts'
import { computeNextJobRunAt, formatJobScheduleSummary } from './schedule.ts'
import { buildJobStorageBindingId } from './service.ts'
import {
	type JobDetails,
	type JobRecord,
	type JobRunHistoryEntry,
	type JobRunResult,
	type JobRunTrigger,
	type JobRunnerStatus,
} from './types.ts'

const jobFacetClassName = 'Job'
const jobFacetName = 'job'
const jobFacetIdPrefix = 'job-facet'
const configStorageKey = 'config'
const defaultHistoryLimit = 50

type JobRunnerConfig = {
	jobId: string
	userId: string
	baseUrl: string
	serverCode: string
	serverCodeId: string
	enabled: boolean
	timezone: string
	schedule: JobRecord['schedule']
	historyLimit: number
	killSwitchEnabled: boolean
}

function defaultConfig(jobId: string): JobRunnerConfig {
	return {
		jobId,
		userId: '',
		baseUrl: '',
		serverCode: '',
		serverCodeId: crypto.randomUUID(),
		enabled: false,
		timezone: 'America/Denver',
		schedule: { intervalMs: 60_000 },
		historyLimit: defaultHistoryLimit,
		killSwitchEnabled: false,
	}
}

export class JobFacetBridge extends FacetKodyBridge {}

class JobRunnerBase extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS runner_status (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					next_run_at TEXT,
					run_count INTEGER NOT NULL DEFAULT 0,
					success_count INTEGER NOT NULL DEFAULT 0,
					failure_count INTEGER NOT NULL DEFAULT 0,
					last_run_started_at TEXT,
					last_run_finished_at TEXT,
					last_run_duration_ms INTEGER,
					last_error_message TEXT,
					last_error_stack TEXT,
					kill_switch_enabled INTEGER NOT NULL DEFAULT 0,
					history_limit INTEGER NOT NULL DEFAULT ${defaultHistoryLimit}
				)
			`)
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS run_history (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					trigger TEXT NOT NULL,
					status TEXT NOT NULL,
					scheduled_for TEXT,
					started_at TEXT NOT NULL,
					finished_at TEXT NOT NULL,
					duration_ms INTEGER NOT NULL,
					error_message TEXT,
					error_stack TEXT
				)
			`)
			this.ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO runner_status (singleton) VALUES (1)`,
			)
		})
	}

	async configure(input: {
		job: JobRecord
		baseUrl: string
		historyLimit?: number
		killSwitchEnabled?: boolean
		recomputeNextRunAt?: boolean
	}) {
		const existing = await this.readConfig(input.job.id)
		const existingStatus = await this.readRunnerStatus()
		const nextConfig: JobRunnerConfig = {
			...existing,
			jobId: input.job.id,
			userId: input.job.userId,
			baseUrl: input.baseUrl,
			serverCode: input.job.serverCode,
			serverCodeId: input.job.serverCodeId,
			enabled: input.job.enabled,
			timezone: input.job.timezone,
			schedule: input.job.schedule,
			historyLimit: input.historyLimit ?? existing.historyLimit,
			killSwitchEnabled: input.killSwitchEnabled ?? existing.killSwitchEnabled,
		}
		await this.writeConfig(nextConfig)
		await this.writeRunnerStatus({
			nextRunAt: nextConfig.enabled
				? input.recomputeNextRunAt || existing.userId === ''
					? computeNextJobRunAt({
							schedule: nextConfig.schedule,
							timezone: nextConfig.timezone,
						})
					: existingStatus.nextRunAt
				: null,
			killSwitchEnabled: nextConfig.killSwitchEnabled,
			historyLimit: nextConfig.historyLimit,
		})
		if (
			existing.serverCodeId !== nextConfig.serverCodeId ||
			existing.serverCode !== nextConfig.serverCode
		) {
			this.ctx.facets.abort(jobFacetName, new Error('Job server code updated.'))
		}
		await this.syncAlarm()
		return await this.getDetails()
	}

	async getDetails(): Promise<JobDetails> {
		const config = await this.readConfig(this.ctx.id.toString())
		const status = await this.readRunnerStatus()
		const job = await this.requireJob()
		return {
			id: config.jobId,
			userId: config.userId,
			name: job.name,
			serverCode: config.serverCode,
			serverCodeId: config.serverCodeId,
			schedule: config.schedule,
			timezone: config.timezone,
			enabled: config.enabled,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			...status,
			scheduleSummary: await this.getScheduleSummary(),
		}
	}

	async getHistory(limit?: number) {
		return this.readRunHistory(limit)
	}

	async setEnabled(input: { enabled: boolean }) {
		const config = await this.readConfig(this.ctx.id.toString())
		config.enabled = input.enabled
		await this.writeConfig(config)
		await this.writeRunnerStatus({
			nextRunAt: input.enabled
				? computeNextJobRunAt({
						schedule: config.schedule,
						timezone: config.timezone,
					})
				: null,
		})
		await this.syncAlarm()
		return await this.getDetails()
	}

	async setKillSwitch(input: { killSwitchEnabled: boolean }) {
		const config = await this.readConfig(this.ctx.id.toString())
		config.killSwitchEnabled = input.killSwitchEnabled
		await this.writeConfig(config)
		await this.writeRunnerStatus({
			killSwitchEnabled: input.killSwitchEnabled,
		})
		await this.syncAlarm()
		return await this.getDetails()
	}

	async resetStorage() {
		const facet = await this.getFacetStub()
		await callFacetStorageReset(facet)
		this.ctx.facets.abort(jobFacetName, new Error('Facet storage reset.'))
		return { ok: true as const }
	}

	async exportStorage() {
		const facet = await this.getFacetStub()
		return await callFacetStorageExport(facet)
	}

	async execServer(input: { code: string; params?: Record<string, unknown> }) {
		const facet = await this.getFacetStub()
		return await callFacetExec(facet, input.code, input.params)
	}

	async deleteRunner() {
		this.ctx.facets.delete(jobFacetName)
		await this.ctx.storage.deleteAll()
		return { ok: true as const }
	}

	async runNow() {
		return await this.executeRun({
			trigger: 'run_now',
			scheduledFor: null,
			advanceSchedule: false,
		})
	}

	async alarm() {
		await this.executeRun({
			trigger: 'alarm',
			scheduledFor: (await this.readRunnerStatus()).nextRunAt,
			advanceSchedule: true,
		})
	}

	private async executeRun(input: {
		trigger: JobRunTrigger
		scheduledFor: string | null
		advanceSchedule: boolean
	}) {
		const config = await this.readConfig(this.ctx.id.toString())
		if (!config.enabled || config.killSwitchEnabled) {
			await this.syncAlarm()
			return {
				ok: false as const,
				skipped: true as const,
			}
		}
		const startedAt = new Date()
		const startedMs = startedAt.getTime()
		const result = await this.runFacet().catch((error) => ({
			ok: false as const,
			error: toFacetErrorDetails(error),
		}))
		const finishedAt = new Date()
		const durationMs = Math.max(0, finishedAt.getTime() - startedMs)
		const status = await this.readRunnerStatus()
		const nextRunAt = input.advanceSchedule
			? computeNextJobRunAt({
					schedule: config.schedule,
					timezone: config.timezone,
					from: finishedAt,
				})
			: status.nextRunAt
		await this.writeRunnerStatus({
			nextRunAt,
			runCount: status.runCount + 1,
			successCount: status.successCount + (result.ok ? 1 : 0),
			failureCount: status.failureCount + (result.ok ? 0 : 1),
			lastRunStartedAt: startedAt.toISOString(),
			lastRunFinishedAt: finishedAt.toISOString(),
			lastRunDurationMs: durationMs,
			lastError: result.ok ? null : result.error,
		})
		await this.insertRunHistory({
			trigger: input.trigger,
			status: result.ok ? 'success' : 'failure',
			scheduledFor: input.scheduledFor,
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs,
			error: result.ok ? null : result.error,
		})
		await this.pruneRunHistory()
		await this.syncAlarm()
		return result
	}

	private async runFacet(): Promise<JobRunResult> {
		const facet = await this.getFacetStub()
		try {
			const result = await (
				facet as unknown as {
					run: () => Promise<unknown>
				}
			).run()
			return { ok: true, result }
		} catch (error) {
			return {
				ok: false,
				error: toFacetErrorDetails(error),
			}
		}
	}

	private async getFacetStub() {
		const config = await this.readConfig(this.ctx.id.toString())
		if (config.killSwitchEnabled) {
			throw jsonResponse({ ok: false, error: 'Job runner is disabled.' }, 503)
		}
		if (!config.serverCode) {
			throw jsonResponse(
				{ ok: false, error: 'Job server code is missing.' },
				404,
			)
		}
		return this.ctx.facets.get(jobFacetName, async () =>
			createFacetStartup({
				loader: this.env.APP_LOADER,
				cacheKey: `${config.jobId}:${config.serverCodeId}`,
				serverCode: config.serverCode,
				facetName: jobFacetName,
				baseClassName: jobFacetClassName,
				expectedExportDescription:
					'Job server code must export class Job extends DurableObject.',
				facetIdPrefix: jobFacetIdPrefix,
				bridgeBindingName: 'KODY',
				bridgeBinding: this.ctx.exports.JobFacetBridge({
					props: {
						userId: config.userId,
						baseUrl: config.baseUrl || 'http://internal.invalid',
						storageBindingId: buildJobStorageBindingId(config.jobId),
						scopeLabel: 'job',
						displayName: 'scheduled-job',
						facetName: jobFacetName,
					},
				}),
			}),
		)
	}

	private async requireJob() {
		const config = await this.readConfig(this.ctx.id.toString())
		const job = await getJobById(this.env.APP_DB, config.userId, config.jobId)
		if (!job) {
			throw new Error(`Job "${config.jobId}" was not found.`)
		}
		return job
	}

	private async getScheduleSummary() {
		const config = await this.readConfig(this.ctx.id.toString())
		return formatJobScheduleSummary({
			schedule: config.schedule,
			timezone: config.timezone,
		})
	}

	private async readConfig(jobId: string) {
		const config = await this.ctx.storage.get<JobRunnerConfig>(configStorageKey)
		return config ?? defaultConfig(jobId)
	}

	private async writeConfig(config: JobRunnerConfig) {
		await this.ctx.storage.put(configStorageKey, config)
	}

	private async readRunnerStatus(): Promise<JobRunnerStatus> {
		const row = this.ctx.storage.sql
			.exec<{
				next_run_at: string | null
				run_count: number
				success_count: number
				failure_count: number
				last_run_started_at: string | null
				last_run_finished_at: string | null
				last_run_duration_ms: number | null
				last_error_message: string | null
				last_error_stack: string | null
				kill_switch_enabled: number
				history_limit: number
			}>(
				`SELECT next_run_at, run_count, success_count, failure_count,
					last_run_started_at, last_run_finished_at, last_run_duration_ms,
					last_error_message, last_error_stack, kill_switch_enabled, history_limit
				FROM runner_status
				WHERE singleton = 1`,
			)
			.one()
		return {
			nextRunAt: row?.next_run_at ?? null,
			runCount: Number(row?.run_count ?? 0),
			successCount: Number(row?.success_count ?? 0),
			failureCount: Number(row?.failure_count ?? 0),
			lastRunStartedAt: row?.last_run_started_at ?? null,
			lastRunFinishedAt: row?.last_run_finished_at ?? null,
			lastRunDurationMs:
				row?.last_run_duration_ms == null
					? null
					: Number(row.last_run_duration_ms),
			lastError:
				row?.last_error_message == null
					? null
					: {
							message: row.last_error_message,
							stack: row.last_error_stack ?? null,
						},
			killSwitchEnabled: Number(row?.kill_switch_enabled ?? 0) === 1,
			historyLimit: Number(row?.history_limit ?? defaultHistoryLimit),
		}
	}

	private async writeRunnerStatus(input: Partial<JobRunnerStatus>) {
		const current = await this.readRunnerStatus()
		const next = {
			...current,
			...input,
		}
		this.ctx.storage.sql.exec(
			`UPDATE runner_status SET
				next_run_at = ?,
				run_count = ?,
				success_count = ?,
				failure_count = ?,
				last_run_started_at = ?,
				last_run_finished_at = ?,
				last_run_duration_ms = ?,
				last_error_message = ?,
				last_error_stack = ?,
				kill_switch_enabled = ?,
				history_limit = ?
			WHERE singleton = 1`,
			next.nextRunAt,
			next.runCount,
			next.successCount,
			next.failureCount,
			next.lastRunStartedAt,
			next.lastRunFinishedAt,
			next.lastRunDurationMs,
			next.lastError?.message ?? null,
			next.lastError?.stack ?? null,
			next.killSwitchEnabled ? 1 : 0,
			next.historyLimit,
		)
	}

	private async insertRunHistory(entry: Omit<JobRunHistoryEntry, 'id'>) {
		this.ctx.storage.sql.exec(
			`INSERT INTO run_history (
				trigger, status, scheduled_for, started_at, finished_at, duration_ms,
				error_message, error_stack
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			entry.trigger,
			entry.status,
			entry.scheduledFor,
			entry.startedAt,
			entry.finishedAt,
			entry.durationMs,
			entry.error?.message ?? null,
			entry.error?.stack ?? null,
		)
	}

	private async readRunHistory(limit = defaultHistoryLimit) {
		const rows = this.ctx.storage.sql
			.exec<{
				id: number
				trigger: JobRunTrigger
				status: JobRunHistoryEntry['status']
				scheduled_for: string | null
				started_at: string
				finished_at: string
				duration_ms: number
				error_message: string | null
				error_stack: string | null
			}>(
				`SELECT id, trigger, status, scheduled_for, started_at, finished_at,
					duration_ms, error_message, error_stack
				FROM run_history
				ORDER BY id DESC
				LIMIT ?`,
				limit,
			)
			.toArray()
		return rows.map((row) => ({
			id: Number(row.id),
			trigger: row.trigger,
			status: row.status,
			scheduledFor: row.scheduled_for,
			startedAt: row.started_at,
			finishedAt: row.finished_at,
			durationMs: Number(row.duration_ms),
			error:
				row.error_message == null
					? null
					: {
							message: row.error_message,
							stack: row.error_stack ?? null,
						},
		}))
	}

	private async pruneRunHistory() {
		const status = await this.readRunnerStatus()
		this.ctx.storage.sql.exec(
			`DELETE FROM run_history
			WHERE id NOT IN (
				SELECT id FROM run_history ORDER BY id DESC LIMIT ?
			)`,
			status.historyLimit,
		)
	}

	private async syncAlarm() {
		const config = await this.readConfig(this.ctx.id.toString())
		const status = await this.readRunnerStatus()
		if (!config.enabled || config.killSwitchEnabled || !status.nextRunAt) {
			await this.ctx.storage.deleteAlarm()
			return
		}
		await this.ctx.storage.setAlarm(new Date(status.nextRunAt))
	}
}

export const JobRunner = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	JobRunnerBase,
)

export function jobRunnerRpc(env: Env, jobId: string) {
	return env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName(jobId)) as unknown as {
		configure: (payload: {
			job: JobRecord
			baseUrl: string
			historyLimit?: number
			killSwitchEnabled?: boolean
			recomputeNextRunAt?: boolean
		}) => Promise<JobDetails>
		getDetails: () => Promise<JobDetails>
		getHistory: (limit?: number) => Promise<Array<JobRunHistoryEntry>>
		setEnabled: (payload: { enabled: boolean }) => Promise<JobDetails>
		setKillSwitch: (payload: {
			killSwitchEnabled: boolean
		}) => Promise<JobDetails>
		resetStorage: () => Promise<{ ok: true }>
		exportStorage: () => Promise<FacetStorageExport>
		execServer: (payload: {
			code: string
			params?: Record<string, unknown>
		}) => Promise<unknown>
		deleteRunner: () => Promise<{ ok: true }>
		runNow: () => Promise<
			| { ok: true; result: unknown }
			| { ok: false; error: { message: string; stack: string | null } }
			| { ok: false; skipped: true }
		>
	}
}

export async function syncJobRunnerFromDb(input: {
	env: Env
	userId: string
	jobId: string
	baseUrl: string
	historyLimit?: number
	killSwitchEnabled?: boolean
	recomputeNextRunAt?: boolean
}) {
	const job = await getJobById(input.env.APP_DB, input.userId, input.jobId)
	if (!job) {
		return null
	}
	return await jobRunnerRpc(input.env, input.jobId).configure({
		job,
		baseUrl: input.baseUrl,
		historyLimit: input.historyLimit,
		killSwitchEnabled: input.killSwitchEnabled,
		recomputeNextRunAt: input.recomputeNextRunAt,
	})
}
