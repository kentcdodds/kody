import { DurableObject } from 'cloudflare:workers'
import { sendAlertEmail } from './alert-email.ts'
import {
	composeStatusEmail,
	decideStatusEmail,
	defaultDailyEmailLimit,
	type OpenIncidentSummary,
} from './email-policy.ts'
import {
	applyProbeResult,
	initialComponentProbeState,
	type ComponentProbeState,
} from './incidents.ts'
import { runAllProbes } from './probes.ts'
import {
	fetchRelevantProviderIncidents,
	parseProviderIncidentCache,
	serializeProviderIncidentCache,
	type ProviderIncident,
} from './provider-incidents.ts'
import {
	statusComponentName,
	statusComponents,
	type ComponentDayStat,
	type ComponentSnapshot,
	type ComponentStatus,
	type IncidentView,
	type ProbeOutcome,
	type StatusComponentId,
	type StatusSnapshot,
} from './status-types.ts'

const providerIncidentsMetaKey = 'provider_incidents_cache'

export type StatusWorkerEnv = {
	STATUS_STORE: DurableObjectNamespace<StatusStore>
	PRIMARY_ORIGIN: string
	PACKAGE_APP_ORIGIN: string
	STATUS_PAGE_URL: string
	ALERT_EMAIL_TO: string
	ALERT_EMAIL_FROM: string
	STATUS_ALERT_DAILY_LIMIT?: string
	BUILD_COMMIT?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_BASE_URL?: string
	/** Worker secret: Cloudflare API token with Email Sending permission. */
	CLOUDFLARE_API_TOKEN?: string
}

const sampleRetentionMs = 25 * 60 * 60 * 1000
const dailyStatRetentionDays = 92
const incidentRetentionMs = 90 * 24 * 60 * 60 * 1000
const uptimeWindowDays = 90
const recentIncidentLimit = 20

function toDay(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 10)
}

export class StatusStore extends DurableObject<StatusWorkerEnv> {
	constructor(ctx: DurableObjectState, env: StatusWorkerEnv) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			this.initializeSchema()
		})
	}

	private initializeSchema() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS samples (
				component TEXT NOT NULL,
				checked_at INTEGER NOT NULL,
				ok INTEGER NOT NULL,
				latency_ms INTEGER,
				detail TEXT
			)
		`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_samples_component_time
			ON samples(component, checked_at DESC)`,
		)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS daily_stats (
				component TEXT NOT NULL,
				day TEXT NOT NULL,
				total INTEGER NOT NULL,
				failed INTEGER NOT NULL,
				PRIMARY KEY (component, day)
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS component_state (
				component TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				consecutive_failures INTEGER NOT NULL,
				consecutive_successes INTEGER NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS incidents (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				component TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				resolved_at INTEGER,
				detail TEXT
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS notifications (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				kind TEXT NOT NULL,
				sent_at INTEGER NOT NULL,
				day TEXT NOT NULL,
				subject TEXT NOT NULL,
				delivered INTEGER NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`)
	}

	private getMeta(key: string): string | null {
		const rows = this.ctx.storage.sql
			.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)
			.toArray()
		return rows[0]?.value ?? null
	}

	private setMeta(key: string, value: string) {
		this.ctx.storage.sql.exec(
			`INSERT INTO meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key,
			value,
		)
	}

	private loadComponentState(
		component: StatusComponentId,
	): ComponentProbeState {
		const rows = this.ctx.storage.sql
			.exec<{
				status: string
				consecutive_failures: number
				consecutive_successes: number
			}>(
				`SELECT status, consecutive_failures, consecutive_successes
				FROM component_state WHERE component = ?`,
				component,
			)
			.toArray()
		const row = rows[0]
		if (!row) return initialComponentProbeState
		return {
			status: row.status === 'down' ? 'down' : 'operational',
			consecutiveFailures: row.consecutive_failures,
			consecutiveSuccesses: row.consecutive_successes,
		}
	}

	private saveComponentState(
		component: StatusComponentId,
		state: ComponentProbeState,
	) {
		this.ctx.storage.sql.exec(
			`INSERT INTO component_state
			(component, status, consecutive_failures, consecutive_successes)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(component) DO UPDATE SET
				status = excluded.status,
				consecutive_failures = excluded.consecutive_failures,
				consecutive_successes = excluded.consecutive_successes`,
			component,
			state.status,
			state.consecutiveFailures,
			state.consecutiveSuccesses,
		)
	}

	private recordOutcome(outcome: ProbeOutcome, now: number) {
		this.ctx.storage.sql.exec(
			`INSERT INTO samples (component, checked_at, ok, latency_ms, detail)
			VALUES (?, ?, ?, ?, ?)`,
			outcome.component,
			now,
			outcome.ok ? 1 : 0,
			outcome.latencyMs,
			outcome.detail,
		)
		this.ctx.storage.sql.exec(
			`INSERT INTO daily_stats (component, day, total, failed)
			VALUES (?, ?, 1, ?)
			ON CONFLICT(component, day) DO UPDATE SET
				total = total + 1,
				failed = failed + excluded.failed`,
			outcome.component,
			toDay(now),
			outcome.ok ? 0 : 1,
		)
		const previous = this.loadComponentState(outcome.component)
		const { state, transition } = applyProbeResult(previous, outcome.ok)
		this.saveComponentState(outcome.component, state)
		if (transition === 'opened') {
			this.ctx.storage.sql.exec(
				`INSERT INTO incidents (component, started_at, resolved_at, detail)
				VALUES (?, ?, NULL, ?)`,
				outcome.component,
				now,
				outcome.detail,
			)
			console.warn(
				'status-incident-opened',
				JSON.stringify({
					component: outcome.component,
					detail: outcome.detail,
				}),
			)
		}
		if (transition === 'resolved') {
			this.ctx.storage.sql.exec(
				`UPDATE incidents SET resolved_at = ?
				WHERE component = ? AND resolved_at IS NULL`,
				now,
				outcome.component,
			)
			console.info(
				'status-incident-resolved',
				JSON.stringify({ component: outcome.component }),
			)
		}
	}

	private listOpenIncidents(): Array<OpenIncidentSummary> {
		return this.ctx.storage.sql
			.exec<{ component: string; started_at: number; detail: string | null }>(
				`SELECT component, started_at, detail FROM incidents
				WHERE resolved_at IS NULL ORDER BY started_at ASC`,
			)
			.toArray()
			.map((row) => ({
				component: row.component as StatusComponentId,
				startedAt: row.started_at,
				detail: row.detail,
			}))
	}

	private async maybeSendAlert(now: number) {
		const openIncidents = this.listOpenIncidents()
		const day = toDay(now)
		const emailsSentToday =
			this.ctx.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM notifications WHERE day = ?`,
					day,
				)
				.toArray()[0]?.count ?? 0
		const lastEmailSentAt =
			this.ctx.storage.sql
				.exec<{ latest: number | null }>(
					`SELECT MAX(sent_at) AS latest FROM notifications`,
				)
				.toArray()[0]?.latest ?? null
		const lastNotifiedState =
			this.getMeta('last_notified_state') === 'incident' ? 'incident' : 'ok'
		const dailyLimitRaw = Number(this.env.STATUS_ALERT_DAILY_LIMIT)
		const dailyLimit =
			Number.isInteger(dailyLimitRaw) && dailyLimitRaw > 0
				? dailyLimitRaw
				: defaultDailyEmailLimit
		const decision = decideStatusEmail({
			now,
			openIncidents,
			lastNotifiedState,
			lastEmailSentAt,
			emailsSentToday,
			dailyLimit,
		})
		if (!decision) {
			if (
				emailsSentToday >= dailyLimit &&
				(openIncidents.length > 0 || lastNotifiedState === 'incident')
			) {
				console.warn(
					'status-alert-email-capped',
					JSON.stringify({ emailsSentToday, dailyLimit }),
				)
			}
			return
		}
		const content = composeStatusEmail({
			kind: decision.kind,
			openIncidents,
			statusPageUrl: this.env.STATUS_PAGE_URL,
			now,
			providerIncidents: this.readProviderIncidents(now),
		})
		const result = await sendAlertEmail(
			{
				accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
				apiToken: this.env.CLOUDFLARE_API_TOKEN,
				apiBaseUrl: this.env.CLOUDFLARE_API_BASE_URL,
			},
			{
				from: this.env.ALERT_EMAIL_FROM,
				to: this.env.ALERT_EMAIL_TO,
				subject: content.subject,
				text: content.text,
				html: content.html,
			},
		)
		// Every attempt is recorded so the daily cap bounds API calls even when
		// sends fail permanently (for example an invalid token would otherwise
		// retry every minute forever). `last_notified_state` only advances on a
		// delivered or unconfigured-skip send, so failed attempts retry on the
		// next tick until the cap stops them for the day.
		this.ctx.storage.sql.exec(
			`INSERT INTO notifications (kind, sent_at, day, subject, delivered)
			VALUES (?, ?, ?, ?, ?)`,
			decision.kind,
			now,
			day,
			content.subject,
			result.delivered ? 1 : 0,
		)
		if (!result.delivered && !result.skipped) return
		this.setMeta(
			'last_notified_state',
			openIncidents.length > 0 ? 'incident' : 'ok',
		)
		console.info(
			'status-alert-email-recorded',
			JSON.stringify({
				kind: decision.kind,
				subject: content.subject,
				delivered: result.delivered,
			}),
		)
	}

	private prune(now: number) {
		this.ctx.storage.sql.exec(
			`DELETE FROM samples WHERE checked_at < ?`,
			now - sampleRetentionMs,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM daily_stats WHERE day < ?`,
			toDay(now - dailyStatRetentionDays * 24 * 60 * 60 * 1000),
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?`,
			now - incidentRetentionMs,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM notifications WHERE sent_at < ?`,
			now - incidentRetentionMs,
		)
	}

	private readProviderIncidents(now: number): Array<ProviderIncident> | null {
		return parseProviderIncidentCache(
			this.getMeta(providerIncidentsMetaKey),
			now,
		)
	}

	private async refreshProviderIncidents(now: number): Promise<void> {
		const result = await fetchRelevantProviderIncidents()
		if (!result.ok) {
			// Keep any still-fresh cache so a hammered Statuspage API does not
			// blank the section mid-incident. Stale entries age out via
			// parseProviderIncidentCache.
			return
		}
		this.setMeta(
			providerIncidentsMetaKey,
			serializeProviderIncidentCache({
				fetchedAt: now,
				incidents: result.incidents,
			}),
		)
	}

	async runProbes(): Promise<void> {
		const outcomes = await runAllProbes({
			primaryOrigin: this.env.PRIMARY_ORIGIN,
			packageAppOrigin: this.env.PACKAGE_APP_ORIGIN,
		})
		const now = Date.now()
		for (const outcome of outcomes) {
			this.recordOutcome(outcome, now)
		}
		await this.refreshProviderIncidents(now)
		await this.maybeSendAlert(now)
		this.prune(now)
	}

	async getSnapshot(): Promise<StatusSnapshot> {
		const now = Date.now()
		const components = statusComponents.map((component) =>
			this.buildComponentSnapshot(component.id, component.name, now),
		)
		const overallStatus: ComponentStatus = components.some(
			(component) => component.status === 'down',
		)
			? 'down'
			: components.every((component) => component.status === 'unknown')
				? 'unknown'
				: 'operational'
		return {
			generatedAt: new Date(now).toISOString(),
			overallStatus,
			components,
			openIncidents: this.listIncidents('open'),
			recentIncidents: this.listIncidents('resolved'),
			providerIncidents: this.readProviderIncidents(now),
			buildCommit: this.env.BUILD_COMMIT ?? null,
		}
	}

	private buildComponentSnapshot(
		id: StatusComponentId,
		name: string,
		now: number,
	): ComponentSnapshot {
		const stateRows = this.ctx.storage.sql
			.exec<{ status: string }>(
				`SELECT status FROM component_state WHERE component = ?`,
				id,
			)
			.toArray()
		const latestSample = this.ctx.storage.sql
			.exec<{ latency_ms: number | null }>(
				`SELECT latency_ms FROM samples WHERE component = ?
				ORDER BY checked_at DESC LIMIT 1`,
				id,
			)
			.toArray()[0]
		const status: ComponentStatus =
			stateRows.length === 0
				? 'unknown'
				: stateRows[0]?.status === 'down'
					? 'down'
					: 'operational'
		const statRows = this.ctx.storage.sql
			.exec<{ day: string; total: number; failed: number }>(
				`SELECT day, total, failed FROM daily_stats
				WHERE component = ? AND day >= ? ORDER BY day ASC`,
				id,
				toDay(now - (uptimeWindowDays - 1) * 24 * 60 * 60 * 1000),
			)
			.toArray()
		const statsByDay = new Map(statRows.map((row) => [row.day, row]))
		const days: Array<ComponentDayStat> = []
		for (let offset = uptimeWindowDays - 1; offset >= 0; offset -= 1) {
			const day = toDay(now - offset * 24 * 60 * 60 * 1000)
			const stat = statsByDay.get(day)
			days.push({
				day,
				total: stat?.total ?? 0,
				failed: stat?.failed ?? 0,
			})
		}
		const total = days.reduce((sum, day) => sum + day.total, 0)
		const failed = days.reduce((sum, day) => sum + day.failed, 0)
		const uptimePct = total === 0 ? null : ((total - failed) / total) * 100
		return {
			id,
			name,
			status,
			latencyMs: latestSample?.latency_ms ?? null,
			uptimePct,
			days,
		}
	}

	private listIncidents(kind: 'open' | 'resolved'): Array<IncidentView> {
		const where =
			kind === 'open' ? 'resolved_at IS NULL' : 'resolved_at IS NOT NULL'
		const order = kind === 'open' ? 'started_at ASC' : 'started_at DESC'
		return this.ctx.storage.sql
			.exec<{
				id: number
				component: string
				started_at: number
				resolved_at: number | null
				detail: string | null
			}>(
				`SELECT id, component, started_at, resolved_at, detail
				FROM incidents WHERE ${where} ORDER BY ${order} LIMIT ?`,
				recentIncidentLimit,
			)
			.toArray()
			.map((row) => {
				const component = row.component as StatusComponentId
				return {
					id: row.id,
					component,
					componentName: statusComponentName(component),
					startedAt: new Date(row.started_at).toISOString(),
					resolvedAt:
						row.resolved_at === null
							? null
							: new Date(row.resolved_at).toISOString(),
					detail: row.detail,
				}
			})
	}
}
