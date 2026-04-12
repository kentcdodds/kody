import { Cron } from 'croner'
import { type ScheduledJob, type ScheduledJobSchedule, type ScheduledJobView } from './types.ts'

export const defaultSchedulerTimezone = 'UTC'

const cronFieldPattern = /\s+/

export function formatSchedulerError(error: unknown): string {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	return String(error)
}

export function normalizeSchedulerTimezone(timezone?: string | null) {
	return timezone?.trim() || defaultSchedulerTimezone
}

export function assertValidSchedulerTimezone(timezone: string) {
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
	return trimmed
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

export function computeNextRunAt(input: {
	schedule: ScheduledJobSchedule
	timezone?: string | null
	from?: Date | string | null
}) {
	const timezone = normalizeSchedulerTimezone(input.timezone)
	const from =
		input.from instanceof Date
			? input.from
			: input.from
				? new Date(input.from)
				: new Date()
	if (Number.isNaN(from.valueOf())) {
		throw new Error('Cannot compute the next run time from an invalid reference date.')
	}
	if (input.schedule.type === 'once') {
		return parseOnceRunAt(input.schedule.runAt).toISOString()
	}
	assertValidSchedulerTimezone(timezone)
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

export function normalizeScheduledJobSchedule(schedule: ScheduledJobSchedule) {
	if (schedule.type === 'once') {
		return {
			type: 'once' as const,
			runAt: parseOnceRunAt(schedule.runAt).toISOString(),
		}
	}
	return {
		type: 'cron' as const,
		expression: assertValidCronExpression(schedule.expression),
	}
}

export function formatScheduleSummary(input: {
	schedule: ScheduledJobSchedule
	timezone?: string | null
}) {
	const timezone = normalizeSchedulerTimezone(input.timezone)
	if (input.schedule.type === 'once') {
		return `Runs once at ${parseOnceRunAt(input.schedule.runAt).toISOString()}`
	}
	return `Runs on cron "${assertValidCronExpression(input.schedule.expression)}" in ${timezone}`
}

export function isJobDue(job: ScheduledJob, now = new Date()) {
	if (!job.enabled) return false
	return new Date(job.nextRunAt).valueOf() <= now.valueOf()
}

export function toScheduledJobView(job: ScheduledJob): ScheduledJobView {
	return {
		...job,
		timezone: normalizeSchedulerTimezone(job.timezone),
		scheduleSummary: formatScheduleSummary({
			schedule: job.schedule,
			timezone: job.timezone,
		}),
	}
}
