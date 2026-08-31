import {
	onboardingChecklistItemHref,
	onboardingChecklistItemLabels,
	type OnboardingChecklistItemId,
} from './onboarding-process.ts'
import { routes } from './routes.ts'

export const waitingItemKinds = [
	'verify-email',
	'mcp-server',
	'publish-lock',
	'email-change',
	'entitlement',
	'error-rate',
	'onboarding',
] as const

export type WaitingItemKind = (typeof waitingItemKinds)[number]

export const waitingSeverities = ['block', 'degraded', 'setup'] as const

export type WaitingSeverity = (typeof waitingSeverities)[number]

/**
 * A current-state item the signed-in human can clear. Not a notification:
 * it disappears when the underlying gate clears. `who` is always `you` —
 * vendor outages and operator work do not belong here.
 */
export type WaitingItem = {
	id: string
	kind: WaitingItemKind
	title: string
	why: string
	who: 'you'
	doLabel: string
	href: string
	severity: WaitingSeverity
}

export const userErrorRateMinErrors = 5
export const userErrorRateMinPercent = 0.2
export const userErrorRateAbsoluteErrors = 10

export function isElevatedUserErrorRate(input: {
	errorCount: number
	eventCount: number
}) {
	if (input.errorCount >= userErrorRateAbsoluteErrors) return true
	if (input.errorCount < userErrorRateMinErrors) return false
	if (input.eventCount <= 0) return false
	return input.errorCount / input.eventCount >= userErrorRateMinPercent
}

export type WaitingMcpServerSignal = {
	id: string
	name: string
	state: string
	error: string | null
}

export type WaitingLockedPackageSignal = {
	id: string
	name: string
	kodyId: string
}

export type WaitingEntitlementCapSignal = {
	resource: string
	label: string
}

export type WaitingSignals = {
	emailVerified: boolean
	onboardingDismissed: boolean
	onboardingRemaining: Array<OnboardingChecklistItemId>
	mcpServers: Array<WaitingMcpServerSignal>
	lockedPackages: Array<WaitingLockedPackageSignal>
	pendingEmailChange: string | null
	errorRate: { errorCount: number; eventCount: number } | null
	entitlementCaps: Array<WaitingEntitlementCapSignal>
}

const severityRank: Record<WaitingSeverity, number> = {
	block: 0,
	degraded: 1,
	setup: 2,
}

const kindRank: Record<WaitingItemKind, number> = {
	'verify-email': 0,
	'mcp-server': 1,
	'publish-lock': 2,
	'email-change': 3,
	entitlement: 4,
	'error-rate': 5,
	onboarding: 6,
}

const mcpHumanStates = new Set(['authenticating', 'failed', 'disconnected'])

export function isWaitingMcpServerState(state: string) {
	return mcpHumanStates.has(state)
}

export function buildWaitingItems(signals: WaitingSignals): Array<WaitingItem> {
	const items: Array<WaitingItem> = []

	if (!signals.emailVerified) {
		items.push({
			id: 'verify-email',
			kind: 'verify-email',
			title: 'Verify your email',
			why: 'Unverified accounts can sign in, but outbound email stays off until you confirm the address.',
			who: 'you',
			doLabel: 'Verify email',
			href: routes.pendingVerification.href(),
			severity: 'block',
		})
	}

	for (const server of signals.mcpServers) {
		const item = buildMcpServerWaitingItem(server)
		if (item) items.push(item)
	}

	for (const pkg of signals.lockedPackages) {
		items.push({
			id: `publish-lock:${pkg.id}`,
			kind: 'publish-lock',
			title: `Promote a publish for ${pkg.name}`,
			why: 'This package is locked. Agents can push drafts, but published code does not move until you promote a commit.',
			who: 'you',
			doLabel: 'Review publish',
			href: routes.accountPackageApprovePublish.href({
				packageId: pkg.id,
			}),
			severity: 'block',
		})
	}

	if (signals.pendingEmailChange) {
		items.push({
			id: 'email-change',
			kind: 'email-change',
			title: 'Confirm your new email',
			why: `A change to ${signals.pendingEmailChange} is waiting on the verification link sent to that address.`,
			who: 'you',
			doLabel: 'Open account email settings',
			href: routes.account.href(),
			severity: 'block',
		})
	}

	for (const cap of signals.entitlementCaps) {
		items.push({
			id: `entitlement:${cap.resource}`,
			kind: 'entitlement',
			title: `${cap.label} is at your plan cap`,
			why: 'New work that needs this resource will fail until you free some up or upgrade.',
			who: 'you',
			doLabel: 'Review usage',
			href: routes.accountUsage.href(),
			severity: 'degraded',
		})
	}

	if (
		signals.errorRate &&
		isElevatedUserErrorRate({
			errorCount: signals.errorRate.errorCount,
			eventCount: signals.errorRate.eventCount,
		})
	) {
		items.push({
			id: 'error-rate',
			kind: 'error-rate',
			title: 'Error rate is elevated',
			why: `${signals.errorRate.errorCount} of ${signals.errorRate.eventCount} recent runs failed. Activity is where you triage those errors.`,
			who: 'you',
			doLabel: 'Open Activity',
			href: routes.accountActivity.href(),
			severity: 'degraded',
		})
	}

	if (!signals.onboardingDismissed) {
		for (const step of signals.onboardingRemaining) {
			if (step === 'verify-email' && !signals.emailVerified) continue
			items.push({
				id: `onboarding:${step}`,
				kind: 'onboarding',
				title: onboardingChecklistItemLabels[step],
				why: 'Setup is still unfinished. Finish this step, or dismiss the checklist on Get started.',
				who: 'you',
				doLabel: 'Continue setup',
				href: onboardingChecklistItemHref(step, routes.onboarding.href()),
				severity: 'setup',
			})
		}
	}

	return items.sort((left, right) => {
		const severity = severityRank[left.severity] - severityRank[right.severity]
		if (severity !== 0) return severity
		const kind = kindRank[left.kind] - kindRank[right.kind]
		if (kind !== 0) return kind
		return left.title.localeCompare(right.title)
	})
}

function buildMcpServerWaitingItem(
	server: WaitingMcpServerSignal,
): WaitingItem | null {
	const href = routes.accountMcpServerDetail.href({ serverId: server.id })
	if (server.state === 'authenticating') {
		return {
			id: `mcp-server:${server.id}`,
			kind: 'mcp-server',
			title: `${server.name} needs authorization`,
			why: 'This MCP server is waiting for you to finish OAuth. Until you do, its tools stay off.',
			who: 'you',
			doLabel: 'Complete authorization',
			href,
			severity: 'block',
		}
	}
	if (server.state === 'failed') {
		return {
			id: `mcp-server:${server.id}`,
			kind: 'mcp-server',
			title: `${server.name} failed to connect`,
			why:
				server.error?.trim() ||
				'Kody could not reach this MCP server. Reconnect it so your agent can use its tools.',
			who: 'you',
			doLabel: 'Reconnect',
			href,
			severity: 'degraded',
		}
	}
	if (server.state === 'disconnected') {
		return {
			id: `mcp-server:${server.id}`,
			kind: 'mcp-server',
			title: `${server.name} is disconnected`,
			why: 'The connection dropped. Reconnect it so your agent can use its tools.',
			who: 'you',
			doLabel: 'Reconnect',
			href,
			severity: 'degraded',
		}
	}
	return null
}
