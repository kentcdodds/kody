import { Cron } from 'croner'
import { type JobRecord, type JobSchedule } from './types.ts'

export const defaultJobTimezone = 'America/Denver'
const cronFieldPattern = /\s+/
const minimumIntervalMs = 1_000

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

export function assertValidJobCronExpression(expression: string) {
	const trimmed = expression.trim()
	const fields = trimmed.split(cronFieldPattern).filter(Boolean)
	if (fields.length !== 5) {
		throw new Error(
			'Cron schedules must use standard 5-field syntax: minute hour day-of-month month day-of-week.',
		)
	}
	return fields.join(' ')
}

export function normalizeJobIntervalMs(intervalMs: number) {
	if (!Number.isFinite(intervalMs) || intervalMs < minimumIntervalMs) {
		throw new Error(
			`Interval schedules require intervalMs >= ${minimumIntervalMs}.`,
		)
	}
	return Math.trunc(intervalMs)
}

export function normalizeJobSchedule(schedule: JobSchedule): JobSchedule {
	if ('cron' in schedule) {
		return {
			cron: assertValidJobCronExpression(schedule.cron),
		}
	}
	return {
		intervalMs: normalizeJobIntervalMs(schedule.intervalMs),
	}
}

export function formatJobScheduleSummary(input: {
	schedule: JobSchedule
	timezone?: string | null
}) {
	const timezone = normalizeJobTimezone(input.timezone)
	if ('cron' in input.schedule) {
		return `Runs on cron "${assertValidJobCronExpression(input.schedule.cron)}" in ${timezone}`
	}
	return `Runs every ${normalizeJobIntervalMs(input.schedule.intervalMs).toLocaleString()}ms`
}

export function computeNextJobRunAt(input: {
	schedule: JobSchedule
	timezone?: string | null
	from?: Date | string | null
}) {
	const normalizedSchedule = normalizeJobSchedule(input.schedule)
	const timezone = normalizeJobTimezone(input.timezone)
	const from =
		input.from instanceof Date
			? input.from
			: input.from
				? new Date(input.from)
				: new Date()
	if (Number.isNaN(from.valueOf())) {
		throw new Error('Cannot compute the next run time from an invalid date.')
	}
	if ('intervalMs' in normalizedSchedule) {
		return new Date(
			from.getTime() + normalizeJobIntervalMs(normalizedSchedule.intervalMs),
		).toISOString()
	}
	assertValidJobTimezone(timezone)
	const cron = new Cron(assertValidJobCronExpression(normalizedSchedule.cron), {
		paused: true,
		timezone,
	})
	const nextRun = cron.nextRun(from)
	if (!nextRun) {
		throw new Error('Cron expression does not produce a future run time.')
	}
	return nextRun.toISOString()
}

