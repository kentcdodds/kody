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

test('status email policy covers open, pause, reminder, all-clear, and the daily cap', () => {
	expect(decideStatusEmail(input())).toBeNull()
	expect(decideStatusEmail(input({ openIncidents: [openIncident()] }))).toEqual(
		{ kind: 'incident_opened' },
	)
	expect(
		decideStatusEmail(
			input({
				openIncidents: [openIncident(), openIncident({ component: 'kv' })],
				lastNotifiedState: 'incident',
				lastEmailSentAt: baseNow - 60 * 60 * 1000,
				emailsSentToday: 1,
			}),
		),
	).toBeNull()
	expect(
		decideStatusEmail(
			input({
				openIncidents: [openIncident()],
				lastNotifiedState: 'incident',
				lastEmailSentAt: baseNow - reminderIntervalMs,
			}),
		),
	).toEqual({ kind: 'daily_reminder' })
	expect(
		decideStatusEmail(
			input({
				lastNotifiedState: 'incident',
				lastEmailSentAt: baseNow - 30 * 60 * 1000,
				emailsSentToday: 1,
			}),
		),
	).toEqual({ kind: 'all_clear' })

	const capped = { emailsSentToday: defaultDailyEmailLimit }
	expect(
		decideStatusEmail(input({ ...capped, openIncidents: [openIncident()] })),
	).toBeNull()
	expect(
		decideStatusEmail(input({ ...capped, lastNotifiedState: 'incident' })),
	).toBeNull()
	// While capped, lastNotifiedState stays 'incident'. Next day the counter
	// resets and the pending all-clear goes out.
	expect(
		decideStatusEmail(
			input({
				lastNotifiedState: 'incident',
				lastEmailSentAt: baseNow - 6 * 60 * 60 * 1000,
				emailsSentToday: 0,
			}),
		),
	).toEqual({ kind: 'all_clear' })
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
			statusPageUrl: 'https://status.kody.codes',
			now: baseNow,
		})
		expect(content.subject).toContain('[kody status]')
		expect(content.text).toContain('https://status.kody.codes')
		expect(content.html).toContain('https://status.kody.codes')
		expect(content.html).not.toContain('<script>')
	}
	const opened = composeStatusEmail({
		kind: 'incident_opened',
		openIncidents: [incident],
		statusPageUrl: 'https://status.kody.codes',
		now: baseNow,
	})
	expect(opened.subject).toContain('App & API')
})

test('outage emails annotate active relevant Cloudflare incidents', () => {
	const providerIncidents = [
		{
			id: 'inc-r2',
			name: 'R2 Availability Issues',
			status: 'investigating',
			impact: 'minor',
			shortlink: 'https://stspg.io/r2',
			updatedAt: '2026-08-07T19:00:00.000Z',
			affectedComponents: ['R2'],
		},
	]
	const opened = composeStatusEmail({
		kind: 'incident_opened',
		openIncidents: [openIncident()],
		statusPageUrl: 'https://status.kody.codes',
		now: baseNow,
		providerIncidents,
	})
	expect(opened.text).toContain(
		'Possibly related Cloudflare incident: R2 Availability Issues (investigating)',
	)
	expect(opened.html).toContain('Possibly related Cloudflare incident')

	const reminder = composeStatusEmail({
		kind: 'daily_reminder',
		openIncidents: [openIncident()],
		statusPageUrl: 'https://status.kody.codes',
		now: baseNow,
		providerIncidents,
	})
	expect(reminder.text).toContain(
		'Possibly related Cloudflare incident: R2 Availability Issues (investigating)',
	)

	const allClear = composeStatusEmail({
		kind: 'all_clear',
		openIncidents: [],
		statusPageUrl: 'https://status.kody.codes',
		now: baseNow,
		providerIncidents,
	})
	expect(allClear.text).not.toContain('Possibly related Cloudflare incident')
})
