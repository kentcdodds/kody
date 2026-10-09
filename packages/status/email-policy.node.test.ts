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
	const hour = 60 * 60 * 1000
	const capped = { emailsSentToday: defaultDailyEmailLimit }
	const cases: Array<[Partial<EmailPolicyInput>, string | null]> = [
		[{}, null],
		[{ openIncidents: [openIncident()] }, 'incident_opened'],
		[
			{
				openIncidents: [openIncident(), openIncident({ component: 'kv' })],
				lastNotifiedState: 'incident',
				lastEmailSentAt: baseNow - hour,
				emailsSentToday: 1,
			},
			null,
		],
		[
			{
				openIncidents: [openIncident()],
				lastNotifiedState: 'incident',
				lastEmailSentAt: baseNow - reminderIntervalMs,
			},
			'daily_reminder',
		],
		[
			{
				lastNotifiedState: 'incident',
				lastEmailSentAt: baseNow - hour / 2,
				emailsSentToday: 1,
			},
			'all_clear',
		],
		[{ ...capped, openIncidents: [openIncident()] }, null],
		[{ ...capped, lastNotifiedState: 'incident' }, null],
		// While capped, lastNotifiedState stays 'incident'. Next day the counter
		// resets and the pending all-clear goes out.
		[
			{
				lastNotifiedState: 'incident',
				lastEmailSentAt: baseNow - 6 * hour,
				emailsSentToday: 0,
			},
			'all_clear',
		],
	]
	expect(
		cases.map(([overrides]) => decideStatusEmail(input(overrides))),
	).toEqual(cases.map(([, kind]) => (kind ? { kind } : null)))
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
	const annotation =
		'Possibly related Cloudflare incident: R2 Availability Issues (investigating)'
	const compose = (kind: 'incident_opened' | 'daily_reminder' | 'all_clear') =>
		composeStatusEmail({
			kind,
			openIncidents: kind === 'all_clear' ? [] : [openIncident()],
			statusPageUrl: 'https://status.kody.codes',
			now: baseNow,
			providerIncidents,
		})
	const opened = compose('incident_opened')
	expect(opened.text).toContain(annotation)
	expect(opened.html).toContain('Possibly related Cloudflare incident')
	expect(compose('daily_reminder').text).toContain(annotation)
	expect(compose('all_clear').text).not.toContain(
		'Possibly related Cloudflare incident',
	)
})
