import {
	usageCampaignCoolingStaleMs,
	usageCampaignFirstSendDwellMs,
	usageCampaignSendCaps,
	usageCampaignSendIntervalMs,
	usageCampaignTemplateByState,
	type UsageCampaignMailTemplate,
	type UsageCampaignOrigin,
	type UsageCampaignState,
} from './campaign-states.ts'

export type UsageCampaignSnapshot = {
	emailVerifiedAt: string | null
	firstMcpConnectedAt: string | null
	firstSavedPackageAt: string | null
	lastActiveAt: string | null
	distinctInboundClientCount: number
	/** True when grant listing failed. Do not treat count as 0. */
	inboundListingFailed?: boolean
	hasEnabledScheduledJob: boolean
	lastJobActivityAt: string | null
	/** True when the jobs list failed. Do not treat that as "no jobs". */
	jobListingFailed?: boolean
	hasStrongRecentUse: boolean
	isStripePaid: boolean
	isNearEntitlementCap: boolean
	now: Date
}

export type UsageCampaignPersisted = {
	state: UsageCampaignState | null
	enteredAt: string | null
	sendCount: number
	lastSentAt: string | null
	origin: UsageCampaignOrigin | null
	coolingTerminal: boolean
}

export type UsageCampaignAction = 'send' | 'silence' | 'persist'

export type UsageCampaignDecision = {
	state: UsageCampaignState
	action: UsageCampaignAction
	template: UsageCampaignMailTemplate | null
	sendIndex: number | null
	origin: UsageCampaignOrigin
	coolingTerminal: boolean
	reason: string
}

export function resolveUsageCampaignState(
	snapshot: UsageCampaignSnapshot,
	persisted: UsageCampaignPersisted,
): UsageCampaignState {
	if (snapshot.isStripePaid) return 'Paid'
	if (snapshot.isNearEntitlementCap) return 'LimitAware'

	const packaged = snapshot.firstSavedPackageAt != null

	if (packaged || isActivatedOrCoolingHistory(persisted)) {
		if (snapshot.jobListingFailed && persisted.state === 'Activated') {
			return 'Activated'
		}
		if (snapshot.jobListingFailed && persisted.state === 'Cooling') {
			return 'Cooling'
		}
		if (isUsageCampaignQuiet(snapshot)) return 'Cooling'
		if (isActivatedUsage(snapshot)) return 'Activated'
		if (persisted.state === 'Activated' || persisted.state === 'Cooling') {
			return 'Activated'
		}
		if (snapshot.inboundListingFailed) {
			if (packaged) return 'PackagedSingleClient'
			return 'Activated'
		}
		if (packaged && snapshot.distinctInboundClientCount < 2) {
			return 'PackagedSingleClient'
		}
		return 'Activated'
	}

	if (snapshot.firstMcpConnectedAt != null) return 'ConnectedNoPackage'
	return 'VerifiedNoMcp'
}

export function isUsageCampaignQuiet(snapshot: UsageCampaignSnapshot) {
	if (snapshot.hasEnabledScheduledJob) return false
	if (snapshot.lastActiveAt != null || snapshot.lastJobActivityAt != null) {
		return (
			isMissingOrStale(snapshot.lastActiveAt, snapshot.now) &&
			isMissingOrStale(snapshot.lastJobActivityAt, snapshot.now)
		)
	}
	return isStampStale(latestActivationStamp(snapshot), snapshot.now)
}

function latestActivationStamp(snapshot: UsageCampaignSnapshot) {
	let latest: string | null = null
	let latestTime = Number.NEGATIVE_INFINITY
	for (const stamp of [
		snapshot.firstSavedPackageAt,
		snapshot.firstMcpConnectedAt,
	]) {
		if (stamp == null) continue
		const at = Date.parse(stamp)
		if (!Number.isFinite(at) || at <= latestTime) continue
		latest = stamp
		latestTime = at
	}
	return latest
}

export function isActivatedUsage(snapshot: UsageCampaignSnapshot) {
	return (
		snapshot.hasEnabledScheduledJob ||
		snapshot.distinctInboundClientCount >= 2 ||
		snapshot.hasStrongRecentUse
	)
}

export function evaluateUsageCampaign(
	snapshot: UsageCampaignSnapshot,
	persisted: UsageCampaignPersisted,
): UsageCampaignDecision {
	if (snapshot.emailVerifiedAt == null) {
		throw new Error('Usage campaign evaluator requires a verified user')
	}

	const state = resolveUsageCampaignState(snapshot, persisted)
	const coolingTerminal =
		state === 'Cooling' &&
		(persisted.coolingTerminal ||
			(persisted.state === 'Cooling' &&
				persisted.sendCount >= usageCampaignSendCaps.Cooling))
	const stateChanged = persisted.state !== state
	const origin: UsageCampaignOrigin = stateChanged
		? persisted.state == null
			? (persisted.origin ?? 'seed')
			: 'event'
		: (persisted.origin ?? 'seed')
	const sendCount = stateChanged ? 0 : persisted.sendCount
	const enteredAt = stateChanged
		? snapshot.now.toISOString()
		: (persisted.enteredAt ?? snapshot.now.toISOString())
	const lastSentAt = stateChanged ? null : persisted.lastSentAt
	const cap = usageCampaignSendCaps[state]
	const template = usageCampaignTemplateByState[state]

	if (state === 'PackagedSingleClient' && snapshot.inboundListingFailed) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: false,
			reason: 'inbound_listing_failed',
		}
	}

	if (state === 'Cooling' && snapshot.jobListingFailed) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: coolingTerminal,
			reason: 'job_listing_failed',
		}
	}

	if (cap === 0 || template == null) {
		return {
			state,
			action: 'silence',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: state === 'Cooling' ? coolingTerminal : false,
			reason: silenceReason(state),
		}
	}

	if (state === 'Cooling' && coolingTerminal && !stateChanged) {
		return {
			state,
			action: 'silence',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: true,
			reason: 'cooling_terminal',
		}
	}

	if (origin === 'seed') {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: false,
			reason: 'seed_no_backfill',
		}
	}

	if (sendCount >= cap) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: state === 'Cooling',
			reason: 'cap_reached',
		}
	}

	if (
		sendCount === 0 &&
		!hasCompletedDwell(enteredAt, snapshot.now) &&
		!isImmediateFirstSend(state, persisted)
	) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: false,
			reason: 'dwell',
		}
	}

	if (lastSentAt && !hasCompletedInterval(lastSentAt, snapshot.now)) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: false,
			reason: 'interval',
		}
	}

	return {
		state,
		action: 'send',
		template,
		sendIndex: sendCount + 1,
		origin,
		coolingTerminal: false,
		reason: stateChanged ? 'entered' : 'nudge',
	}
}

function isActivatedOrCoolingHistory(persisted: UsageCampaignPersisted) {
	return (
		persisted.state === 'Activated' ||
		persisted.state === 'Cooling' ||
		persisted.state === 'PackagedSingleClient'
	)
}

function isMissingOrStale(stamp: string | null, now: Date) {
	if (stamp == null) return true
	return isStampStale(stamp, now)
}

function isStampStale(stamp: string | null, now: Date) {
	if (stamp == null) return false
	const at = Date.parse(stamp)
	if (!Number.isFinite(at)) return false
	return now.getTime() - at >= usageCampaignCoolingStaleMs
}

function hasCompletedDwell(enteredAt: string, now: Date) {
	const at = Date.parse(enteredAt)
	if (!Number.isFinite(at)) return false
	return now.getTime() - at >= usageCampaignFirstSendDwellMs
}

function hasCompletedInterval(lastSentAt: string, now: Date) {
	const at = Date.parse(lastSentAt)
	if (!Number.isFinite(at)) return false
	return now.getTime() - at >= usageCampaignSendIntervalMs
}

/**
 * Verify-time VerifiedNoMcp send 1 is recorded as an event-origin row with
 * no prior send. The verify handler sends immediately; the evaluator used
 * from that path treats the first send as due.
 */
function isImmediateFirstSend(
	state: UsageCampaignState,
	persisted: UsageCampaignPersisted,
) {
	return (
		state === 'VerifiedNoMcp' &&
		persisted.state == null &&
		persisted.origin === 'event'
	)
}

export function nextUsageCampaignRow(input: {
	decision: UsageCampaignDecision
	persisted: UsageCampaignPersisted
	now: Date
	sent: boolean
}) {
	const stateChanged = input.persisted.state !== input.decision.state
	const enteredAt = stateChanged
		? input.now.toISOString()
		: (input.persisted.enteredAt ?? input.now.toISOString())
	const sendCount = input.sent
		? stateChanged
			? 1
			: input.persisted.sendCount + 1
		: stateChanged
			? 0
			: input.persisted.sendCount
	const lastSentAt = input.sent
		? input.now.toISOString()
		: stateChanged
			? null
			: input.persisted.lastSentAt
	return {
		state: input.decision.state,
		enteredAt,
		sendCount,
		lastSentAt,
		origin: input.decision.origin,
		coolingTerminal:
			input.decision.coolingTerminal ||
			(input.sent && input.decision.state === 'Cooling'),
	}
}

function silenceReason(state: UsageCampaignState) {
	switch (state) {
		case 'Activated':
			return 'activated_silence'
		case 'Paid':
			return 'paid_silence'
		case 'LimitAware':
			return 'limit_aware_transactional'
		case 'VerifiedNoMcp':
		case 'ConnectedNoPackage':
		case 'PackagedSingleClient':
		case 'Cooling':
			return 'no_template'
		default: {
			const exhaustive: never = state
			throw new Error(`Unknown campaign state: ${String(exhaustive)}`)
		}
	}
}
