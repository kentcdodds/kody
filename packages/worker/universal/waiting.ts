import {
	expiredSecretCopy,
	integrationAuthFailureCopy,
	isVendorLikelyMcpError,
	waitingExpiredSecretCap,
	type IntegrationAuthFailureReason,
} from './connection-trouble.ts'
import {
	onboardingChecklistItemHref,
	onboardingChecklistItemLabels,
	type OnboardingChecklistItemId,
} from './onboarding-process.ts'
import { routes } from './routes.ts'

export const waitingItemKinds = [
	'verify-email',
	'mcp-server',
	'integration-auth',
	'secret-expired',
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

export type WaitingIntegrationAuthSignal = {
	name: string
	accountLabel: string | null
	lane: 'user' | 'platform'
	reason: IntegrationAuthFailureReason
}

export type WaitingExpiredSecretSignal = {
	name: string
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
	integrationAuth: Array<WaitingIntegrationAuthSignal>
	expiredSecrets: Array<WaitingExpiredSecretSignal>
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
	'integration-auth': 2,
	'secret-expired': 3,
	'publish-lock': 4,
	'email-change': 5,
	entitlement: 6,
	'error-rate': 7,
	onboarding: 8,
}

const mcpHumanStates = new Set(['authenticating', 'failed', 'disconnected'])

export function isWaitingMcpServerState(state: string) {
	return mcpHumanStates.has(state)
}

/** `pending_email_changes.expires_at` is a millisecond epoch, not a datetime. */
export function isUnexpiredEpochMs(expiresAt: number, now: Date) {
	return Number.isFinite(expiresAt) && expiresAt > now.getTime()
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

	for (const connection of signals.integrationAuth) {
		const copy = integrationAuthFailureCopy(connection)
		if (copy.who !== 'you' || !copy.reconnectable) continue
		items.push({
			id: `integration-auth:${connection.name}`,
			kind: 'integration-auth',
			title: copy.title,
			why: copy.why,
			who: 'you',
			doLabel: copy.doLabel,
			href: copy.href,
			severity: 'block',
		})
	}

	const expiredSecrets = signals.expiredSecrets.slice(
		0,
		waitingExpiredSecretCap,
	)
	for (const secret of expiredSecrets) {
		const copy = expiredSecretCopy(secret.name)
		items.push({
			id: `secret-expired:${secret.name}`,
			kind: 'secret-expired',
			title: copy.title,
			why: copy.why,
			who: 'you',
			doLabel: copy.doLabel,
			href: copy.href,
			severity: 'degraded',
		})
	}
	const extraExpired = signals.expiredSecrets.length - expiredSecrets.length
	if (extraExpired > 0) {
		items.push({
			id: 'secret-expired-more',
			kind: 'secret-expired',
			title: `${String(extraExpired)} more expired secrets`,
			why: 'Open Secrets to paste new values. Do not put them in chat.',
			who: 'you',
			doLabel: 'Open Secrets',
			href: routes.accountSecrets.href(),
			severity: 'degraded',
		})
	}

	for (const pkg of signals.lockedPackages) {
		items.push({
			id: `publish-lock:${pkg.id}`,
			kind: 'publish-lock',
			title: `${pkg.name} is locked`,
			why: 'Agents can push drafts, but published code does not move until you promote a commit or unlock it.',
			who: 'you',
			doLabel: 'Review lock',
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
		if (left.id === 'secret-expired-more') return 1
		if (right.id === 'secret-expired-more') return -1
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
		if (isVendorLikelyMcpError(server.error)) return null
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
		if (isVendorLikelyMcpError(server.error)) return null
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
