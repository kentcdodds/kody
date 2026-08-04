import { expect, test } from 'vitest'
import {
	composeStatusEmail,
	decideStatusEmail,
	defaultDailyEmailLimit,
	reminderIntervalMs,
	type EmailPolicyInput,
	type OpenIncidentSummary,
} from './email-policy.ts'

const baseNow = Date.UTC(2026, 7, 4, 12, 0, 0)

function openIncident(
	overrides: Partial<OpenIncidentSummary> = {},
): OpenIncidentSummary {
	return {
		component: 'app',
		startedAt: baseNow - 5 * 60 * 1000,
		detail: 'HTTP 500',
		...overrides,
	}
}

function input(overrides: Partial<EmailPolicyInput> = {}): EmailPolicyInput {
	return {
		now: baseNow,
		openIncidents: [],
		lastNotifiedState: 'ok',
		lastEmailSentAt: null,
		emailsSentToday: 0,
		dailyLimit: defaultDailyEmailLimit,
		...overrides,
	}
}

test('first incident of an episode sends the incident email', () => {
	const decision = decideStatusEmail(input({ openIncidents: [openIncident()] }))
	expect(decision).toEqual({ kind: 'incident_opened' })
})

test('further incidents while one is already announced stay paused', () => {
	const decision = decideStatusEmail(
		input({
			openIncidents: [openIncident(), openIncident({ component: 'kv' })],
			lastNotifiedState: 'incident',
			lastEmailSentAt: baseNow - 60 * 60 * 1000,
			emailsSentToday: 1,
		}),
	)
	expect(decision).toBeNull()
})

test('a reminder goes out once 24 hours pass without an email', () => {
	const decision = decideStatusEmail(
		input({
			openIncidents: [openIncident()],
			lastNotifiedState: 'incident',
			lastEmailSentAt: baseNow - reminderIntervalMs,
		}),
	)
	expect(decision).toEqual({ kind: 'daily_reminder' })
})

test('all clear sends once every incident is resolved', () => {
	const decision = decideStatusEmail(
		input({
			lastNotifiedState: 'incident',
			lastEmailSentAt: baseNow - 30 * 60 * 1000,
			emailsSentToday: 1,
		}),
	)
	expect(decision).toEqual({ kind: 'all_clear' })
})

test('no email when everything is healthy and no incident was announced', () => {
	expect(decideStatusEmail(input())).toBeNull()
})

test('the daily cap suppresses every kind of email', () => {
	const capped = { emailsSentToday: defaultDailyEmailLimit }
	expect(
		decideStatusEmail(input({ ...capped, openIncidents: [openIncident()] })),
	).toBeNull()
	expect(
		decideStatusEmail(input({ ...capped, lastNotifiedState: 'incident' })),
	).toBeNull()
})

test('a capped all-clear is sent on the first uncapped tick', () => {
	// While capped, lastNotifiedState stays 'incident'. Next day the counter
	// resets and the pending all-clear goes out.
	const decision = decideStatusEmail(
		input({
			lastNotifiedState: 'incident',
			lastEmailSentAt: baseNow - 6 * 60 * 60 * 1000,
			emailsSentToday: 0,
		}),
	)
	expect(decision).toEqual({ kind: 'all_clear' })
})

test('composed emails carry component names, status page link, and escape html', () => {
	const incident = openIncident({ detail: '<script>alert(1)</script>' })
	for (const kind of [
		'incident_opened',
		'daily_reminder',
		'all_clear',
	] as const) {
		const content = composeStatusEmail({
			kind,
			openIncidents: [incident],
			statusPageUrl: 'https://status.heykody.dev',
			now: baseNow,
		})
		expect(content.subject).toContain('[kody status]')
		expect(content.text).toContain('https://status.heykody.dev')
		expect(content.html).toContain('https://status.heykody.dev')
		expect(content.html).not.toContain('<script>')
	}
	const opened = composeStatusEmail({
		kind: 'incident_opened',
		openIncidents: [incident],
		statusPageUrl: 'https://status.heykody.dev',
		now: baseNow,
	})
	expect(opened.subject).toContain('App & API')
})
