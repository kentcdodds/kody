import { statusComponentName, type StatusComponentId } from './status-types.ts'

/**
 * Operator alert policy:
 *
 * - one email when an outage episode starts (the first incident to open);
 * - no further emails while incidents remain open, except one reminder per
 *   24 hours;
 * - one "all is well" email once every incident has resolved;
 * - a hard daily cap on total emails, so a flapping component cannot flood
 *   the inbox. A suppressed all-clear is not lost: `lastNotifiedState` stays
 *   `incident` until an all-clear actually sends, so it goes out on the first
 *   uncapped tick.
 */

export const defaultDailyEmailLimit = 6
export const reminderIntervalMs = 24 * 60 * 60 * 1000

export type StatusEmailKind = 'incident_opened' | 'daily_reminder' | 'all_clear'

export type OpenIncidentSummary = {
	component: StatusComponentId
	startedAt: number
	detail: string | null
}

export type EmailPolicyInput = {
	now: number
	openIncidents: Array<OpenIncidentSummary>
	lastNotifiedState: 'ok' | 'incident'
	lastEmailSentAt: number | null
	emailsSentToday: number
	dailyLimit: number
}

export function decideStatusEmail(
	input: EmailPolicyInput,
): { kind: StatusEmailKind } | null {
	if (input.emailsSentToday >= input.dailyLimit) return null
	if (input.openIncidents.length > 0) {
		if (input.lastNotifiedState === 'ok') {
			return { kind: 'incident_opened' }
		}
		if (
			input.lastEmailSentAt !== null &&
			input.now - input.lastEmailSentAt >= reminderIntervalMs
		) {
			return { kind: 'daily_reminder' }
		}
		return null
	}
	if (input.lastNotifiedState === 'incident') {
		return { kind: 'all_clear' }
	}
	return null
}

export type StatusEmailContent = {
	subject: string
	text: string
	html: string
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}

function describeIncidents(incidents: Array<OpenIncidentSummary>): string {
	return incidents
		.map((incident) => {
			const name = statusComponentName(incident.component)
			const since = new Date(incident.startedAt).toISOString()
			const detail = incident.detail ? ` (${incident.detail})` : ''
			return `- ${name}: down since ${since}${detail}`
		})
		.join('\n')
}

export function composeStatusEmail(input: {
	kind: StatusEmailKind
	openIncidents: Array<OpenIncidentSummary>
	statusPageUrl: string
	now: number
}): StatusEmailContent {
	const componentNames = input.openIncidents
		.map((incident) => statusComponentName(incident.component))
		.join(', ')
	const incidentLines = describeIncidents(input.openIncidents)
	const footerText = `Status page: ${input.statusPageUrl}`
	const footerHtml = `<p><a href="${escapeHtml(input.statusPageUrl)}">Open the status page</a></p>`

	switch (input.kind) {
		case 'incident_opened': {
			const subject = `[kody status] Incident: ${componentNames} down`
			const text = `An incident is affecting kody.\n\n${incidentLines}\n\nYou will get at most one reminder per day while this is unresolved, and an all-clear email once everything recovers.\n\n${footerText}`
			return { subject, text, html: toHtml(text, footerHtml) }
		}
		case 'daily_reminder': {
			const subject = `[kody status] Reminder: incident still unresolved (${componentNames})`
			const text = `An incident affecting kody is still unresolved.\n\n${incidentLines}\n\n${footerText}`
			return { subject, text, html: toHtml(text, footerHtml) }
		}
		case 'all_clear': {
			const subject = '[kody status] All systems operational again'
			const text = `Every kody component has recovered. All systems are operational as of ${new Date(input.now).toISOString()}.\n\n${footerText}`
			return { subject, text, html: toHtml(text, footerHtml) }
		}
		default: {
			input.kind satisfies never
			throw new Error(`Unknown status email kind: ${String(input.kind)}`)
		}
	}
}

function toHtml(text: string, footerHtml: string): string {
	const paragraphs = text
		.split('\n\n')
		.slice(0, -1)
		.map(
			(paragraph) =>
				`<p>${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`,
		)
		.join('')
	return `<div>${paragraphs}${footerHtml}</div>`
}
