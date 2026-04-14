import { Cron } from 'croner'
import {
	type JobRecord,
	type JobSchedule,
	type JobView,
} from './types.ts'

export const defaultJobTimezone = 'UTC'

const cronFieldPattern = /\s+/
const intervalPattern = /^(\d+)\s*(ms|s|m|h|d)$/i
const intervalUnitMs = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
} as const

export function formatJobError(error: unknown): string {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	return String(error)
}

export function normalizeJobTimezone(timezone?: string | null) {
	return timezone?.trim() || defaultJobTimezone
}

export function assertValidJobTimezone(timezone: string) {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
	} catch {
		throw new Error(`Invalid IANA timezone "${timezone}".`)
	}
}

export function assertValidCronExpression(expression: string) {
	const trimmed = expression.trim()
	const fields = trimmed.split(cronFieldPattern).filter(Boolean)
	if (fields.length !== 5) {
		throw new Error(
			'Cron expressions must use standard 5-field syntax: minute hour day-of-month month day-of-week.',
		)
	}
	return fields.join(' ')
}

export function parseOnceRunAt(runAt: string) {
	const trimmed = runAt.trim()
	if (!trimmed) {
		throw new Error('Once schedules require a non-empty runAt timestamp.')
	}
	if (!/(?:Z|[+-]00:00)$/i.test(trimmed)) {
		throw new Error(
			'Once schedules must use an ISO 8601 UTC timestamp (for example 2026-04-17T15:00:00Z).',
		)
	}
	const parsed = new Date(trimmed)
	if (Number.isNaN(parsed.valueOf())) {
		throw new Error('Once schedules require a valid ISO 8601 timestamp.')
	}
	return parsed
}

export function parseIntervalEvery(every: string) {
	const trimmed = every.trim()
	if (!trimmed) {
		throw new Error(
			'Interval schedules require a non-empty duration such as "15m" or "1h".',
		)
	}
	const match = trimmed.match(intervalPattern)
	if (!match?.[1] || !match[2]) {
		throw new Error(
			'Interval schedules must use "<positive integer><unit>" with unit ms, s, m, h, or d.',
		)
	}
	const amount = Number.parseInt(match[1], 10)
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error('Interval schedules require a positive duration amount.')
	}
	const unit = match[2].toLowerCase() as keyof typeof intervalUnitMs
	return {
		every: `${amount}${unit}`,
		everyMs: amount * intervalUnitMs[unit],
	}
}

export function computeNextRunAt(input: {
	schedule: JobSchedule
	timezone?: string | null
	from?: Date | string | null
}) {
	const timezone = normalizeJobTimezone(input.timezone)
	const from =
		input.from instanceof Date
			? input.from
			: input.from
				? new Date(input.from)
				: new Date()
	if (Number.isNaN(from.valueOf())) {
		throw new Error(
			'Cannot compute the next run time from an invalid reference date.',
		)
	}
	switch (input.schedule.type) {
		case 'once':
			return parseOnceRunAt(input.schedule.runAt).toISOString()
		case 'interval':
			return new Date(
				from.valueOf() + parseIntervalEvery(input.schedule.every).everyMs,
			).toISOString()
		case 'cron': {
			assertValidJobTimezone(timezone)
			const expression = assertValidCronExpression(input.schedule.expression)
			const cron = new Cron(expression, {
				paused: true,
				timezone,
			})
			const nextRun = cron.nextRun(from)
			if (!nextRun) {
				throw new Error('Cron expression does not produce a future run time.')
			}
			return nextRun.toISOString()
		}
	}
}

export function normalizeJobSchedule(schedule: JobSchedule) {
	switch (schedule.type) {
		case 'once':
			return {
				type: 'once' as const,
				runAt: parseOnceRunAt(schedule.runAt).toISOString(),
			}
		case 'interval':
			return {
				type: 'interval' as const,
				every: parseIntervalEvery(schedule.every).every,
			}
		case 'cron':
			return {
				type: 'cron' as const,
				expression: assertValidCronExpression(schedule.expression),
			}
	}
}

export function formatScheduleSummary(input: {
	schedule: JobSchedule
	timezone?: string | null
}) {
	const timezone = normalizeJobTimezone(input.timezone)
	switch (input.schedule.type) {
		case 'once':
			return `Runs once at ${parseOnceRunAt(input.schedule.runAt).toISOString()}`
		case 'interval':
			return `Runs every ${parseIntervalEvery(input.schedule.every).every}`
		case 'cron':
			return `Runs on cron "${assertValidCronExpression(input.schedule.expression)}" in ${timezone}`
	}
}

export function isJobDue(job: JobRecord, now = new Date()) {
	if (!job.enabled || job.killSwitchEnabled) return false
	return new Date(job.nextRunAt).valueOf() <= now.valueOf()
}

export function toJobView(job: JobRecord): JobView {
	const { userId: _userId, ...rest } = job
	return {
		...rest,
		timezone: normalizeJobTimezone(job.timezone),
		scheduleSummary: formatScheduleSummary({
			schedule: job.schedule,
			timezone: job.timezone,
		}),
	}
}
