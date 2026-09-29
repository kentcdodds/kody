import { expect, test } from 'vitest'
import {
	evaluateUsageCampaign,
	nextUsageCampaignRow,
	resolveUsageCampaignState,
	type UsageCampaignPersisted,
	type UsageCampaignSnapshot,
} from './campaign-evaluator.ts'
import {
	usageCampaignAdvocateMinTenureMs,
	usageCampaignCoolingStaleMs,
	usageCampaignFirstSendDwellMs,
	usageCampaignSendIntervalMs,
} from './campaign-states.ts'

const now = new Date('2026-09-07T12:00:00.000Z')
const nowIso = now.toISOString()

type SnapshotInput = Partial<UsageCampaignSnapshot>
type PersistedInput = Partial<UsageCampaignPersisted>
type Decision = ReturnType<typeof evaluateUsageCampaign>

function snapshot(overrides: SnapshotInput = {}): UsageCampaignSnapshot {
	return {
		emailVerifiedAt: '2026-09-01T00:00:00.000Z',
		firstMcpConnectedAt: null,
		firstSavedPackageAt: null,
		lastActiveAt: null,
		distinctInboundClientCount: 0,
		hasEnabledScheduledJob: false,
		lastJobActivityAt: null,
		hasStrongRecentUse: false,
		isStripePaid: false,
		isNearEntitlementCap: false,
		now,
		...overrides,
	}
}

function persisted(overrides: PersistedInput = {}): UsageCampaignPersisted {
	return {
		state: null,
		enteredAt: null,
		sendCount: 0,
		lastSentAt: null,
		origin: null,
		coolingTerminal: false,
		everActivated: false,
		firstActivatedAt: null,
		advocateSentAt: null,
		...overrides,
	}
}

const day = (monthDay: string) => `2026-${monthDay}T00:00:00.000Z`
const later = (ms: number) => new Date(now.getTime() + ms)
const event = (
	state: UsageCampaignPersisted['state'],
	extra: PersistedInput = {},
): PersistedInput => ({ state, origin: 'event', ...extra })
const packaged = (
	clients: number,
	extra: SnapshotInput = {},
): SnapshotInput => ({
	firstSavedPackageAt: day('09-03'),
	distinctInboundClientCount: clients,
	lastActiveAt: day('09-06'),
	...extra,
})
const quiet = (extra: SnapshotInput = {}): SnapshotInput => ({
	firstSavedPackageAt: day('07-01'),
	lastActiveAt: day('07-01'),
	...extra,
})

function resolveTable(
	cases: Array<
		[SnapshotInput, PersistedInput, UsageCampaignPersisted['state']]
	>,
) {
	return {
		actual: cases.map(([s, p]) =>
			resolveUsageCampaignState(snapshot(s), persisted(p)),
		),
		expected: cases.map(([, , state]) => state),
	}
}

function decisionTable(
	cases: Array<[SnapshotInput, PersistedInput, Partial<Decision>]>,
) {
	return {
		actual: cases.map(([s, p]) =>
			evaluateUsageCampaign(snapshot(s), persisted(p)),
		),
		expected: cases.map(([, , decision]) => decision),
	}
}

test('evaluator walks usage stamps into states, caps, and Activated/Paid silence', () => {
	const states = resolveTable([
		[{}, {}, 'VerifiedNoMcp'],
		[{ firstMcpConnectedAt: day('09-02') }, {}, 'ConnectedNoPackage'],
		[
			packaged(1, { firstMcpConnectedAt: day('09-02') }),
			{},
			'PackagedSingleClient',
		],
		[packaged(2), {}, 'Activated'],
		[
			packaged(0, { inboundListingFailed: true }),
			event('Activated'),
			'Activated',
		],
		[
			{
				firstSavedPackageAt: day('09-03'),
				hasEnabledScheduledJob: true,
				lastActiveAt: day('08-01'),
			},
			{},
			'Activated',
		],
		[packaged(0, { hasStrongRecentUse: true }), {}, 'Activated'],
		[
			{
				firstSavedPackageAt: day('08-01'),
				lastActiveAt: new Date(
					now.getTime() - usageCampaignCoolingStaleMs,
				).toISOString(),
			},
			{},
			'Cooling',
		],
		[{ isNearEntitlementCap: true }, {}, 'LimitAware'],
		[{ isStripePaid: true, isNearEntitlementCap: true }, {}, 'Paid'],
	])
	expect(states.actual).toEqual(states.expected)

	const verifiedSent = (sendCount: number) =>
		event('VerifiedNoMcp', {
			enteredAt: day('09-01'),
			sendCount,
			lastSentAt: nowIso,
		})
	const decisions = decisionTable([
		[
			packaged(0, { inboundListingFailed: true }),
			event('PackagedSingleClient', { enteredAt: day('09-01') }),
			{
				state: 'PackagedSingleClient',
				action: 'persist',
				reason: 'inbound_listing_failed',
			},
		],
		[
			packaged(1, { executeReadFailed: true }),
			event('PackagedSingleClient', { enteredAt: day('09-01') }),
			{
				state: 'PackagedSingleClient',
				action: 'persist',
				reason: 'execute_read_failed',
			},
		],
		[
			{},
			{ origin: 'event' },
			{
				state: 'VerifiedNoMcp',
				action: 'send',
				template: 'verified_no_mcp',
				sendIndex: 1,
				reason: 'entered',
			},
		],
		[
			{},
			event('VerifiedNoMcp', { enteredAt: nowIso }),
			{ state: 'VerifiedNoMcp', action: 'persist', reason: 'dwell' },
		],
		[
			{},
			event('LimitAware', { enteredAt: nowIso }),
			{ state: 'VerifiedNoMcp', action: 'persist', reason: 'dwell' },
		],
		[{}, verifiedSent(1), { action: 'persist', reason: 'interval' }],
		[
			{ now: later(usageCampaignSendIntervalMs) },
			verifiedSent(1),
			{ action: 'send', sendIndex: 2, template: 'verified_no_mcp' },
		],
		[
			{ now: later(usageCampaignSendIntervalMs * 2) },
			verifiedSent(2),
			{ action: 'persist', reason: 'cap_reached' },
		],
		[
			{ firstMcpConnectedAt: day('09-02') },
			event('VerifiedNoMcp', { enteredAt: day('09-01'), sendCount: 2 }),
			{
				state: 'ConnectedNoPackage',
				action: 'persist',
				origin: 'event',
				reason: 'dwell',
			},
		],
		[
			{
				firstMcpConnectedAt: day('09-02'),
				now: later(usageCampaignFirstSendDwellMs),
			},
			event('ConnectedNoPackage', { enteredAt: nowIso }),
			{
				state: 'ConnectedNoPackage',
				action: 'send',
				template: 'connected_no_package',
				sendIndex: 1,
				origin: 'event',
			},
		],
		[
			packaged(2),
			event('PackagedSingleClient', { enteredAt: day('09-03') }),
			{ state: 'Activated', action: 'silence', reason: 'activated_silence' },
		],
		[
			{ isStripePaid: true },
			event('Activated', { enteredAt: day('09-03') }),
			{ state: 'Paid', action: 'silence', reason: 'paid_silence' },
		],
	])
	expect(decisions.actual).toMatchObject(decisions.expected)
})

test('seed observations do not mail, Cooling is one send then terminal, jobs keep Activated', () => {
	const coolingSent = event('Cooling', {
		enteredAt: nowIso,
		sendCount: 1,
		coolingTerminal: true,
	})
	const decisions = decisionTable([
		[
			{},
			{},
			{
				state: 'VerifiedNoMcp',
				action: 'persist',
				origin: 'seed',
				reason: 'seed_no_backfill',
			},
		],
		[
			{ now: later(usageCampaignSendIntervalMs * 3) },
			{ state: 'VerifiedNoMcp', enteredAt: nowIso, origin: 'seed' },
			{ action: 'persist', reason: 'seed_no_backfill' },
		],
		[
			quiet(),
			event('Activated', { enteredAt: day('07-01') }),
			{ state: 'Cooling', action: 'persist', reason: 'dwell' },
		],
		[
			quiet({ now: later(usageCampaignFirstSendDwellMs) }),
			event('Cooling', { enteredAt: nowIso }),
			{ state: 'Cooling', action: 'send', template: 'cooling', sendIndex: 1 },
		],
		[
			quiet(),
			{ ...coolingSent, lastSentAt: nowIso },
			{
				state: 'Cooling',
				action: 'silence',
				reason: 'cooling_terminal',
				coolingTerminal: true,
			},
		],
		[
			quiet({ hasEnabledScheduledJob: true }),
			coolingSent,
			{ state: 'Activated', action: 'silence' },
		],
		[
			{ isNearEntitlementCap: true },
			event('ConnectedNoPackage', { enteredAt: nowIso }),
			{
				state: 'LimitAware',
				action: 'silence',
				reason: 'limit_aware_transactional',
			},
		],
		[
			{ firstMcpConnectedAt: '2026-09-07T11:00:00.000Z' },
			event('VerifiedNoMcp', { enteredAt: day('09-01') }),
			{ state: 'ConnectedNoPackage', action: 'persist', reason: 'dwell' },
		],
	])
	expect(decisions.actual).toMatchObject(decisions.expected)
})

test('missing last_active uses the newest known stamp and does not invent Cooling', () => {
	const states = resolveTable([
		[
			packaged(1, { firstMcpConnectedAt: day('09-02'), lastActiveAt: null }),
			{},
			'PackagedSingleClient',
		],
		[
			{
				emailVerifiedAt: day('07-01'),
				firstMcpConnectedAt: day('07-02'),
				firstSavedPackageAt: day('07-03'),
				lastActiveAt: null,
				lastJobActivityAt: null,
				distinctInboundClientCount: 1,
			},
			{},
			'Cooling',
		],
	])
	expect(states.actual).toEqual(states.expected)
})

test('failed job listing does not invent Cooling or demote Activated', () => {
	const noActivityJobsFailed = packaged(1, {
		lastActiveAt: null,
		jobListingFailed: true,
	})
	const states = resolveTable([
		[noActivityJobsFailed, event('Activated'), 'Activated'],
		[noActivityJobsFailed, {}, 'PackagedSingleClient'],
	])
	expect(states.actual).toEqual(states.expected)
	const decisions = decisionTable([
		[
			quiet({
				jobListingFailed: true,
				now: later(usageCampaignFirstSendDwellMs),
			}),
			event('Cooling', { enteredAt: nowIso }),
			{ state: 'Cooling', action: 'persist', reason: 'job_listing_failed' },
		],
		[
			quiet({ jobListingFailed: true }),
			{},
			{
				state: 'Cooling',
				action: 'persist',
				origin: 'seed',
				reason: 'job_listing_failed',
			},
		],
		[
			quiet({ now: later(usageCampaignFirstSendDwellMs) }),
			{ state: 'Cooling', enteredAt: nowIso, origin: 'seed' },
			{
				state: 'Cooling',
				action: 'persist',
				origin: 'seed',
				reason: 'seed_no_backfill',
			},
		],
	])
	expect(decisions.actual).toMatchObject(decisions.expected)
})

test('Activated and Cooling history does not fall back into PackagedSingleClient mail', () => {
	const singleClient = packaged(1, { firstSavedPackageAt: day('08-01') })
	const activatedSilence = {
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	} as const
	const states = resolveTable([
		[
			{ ...singleClient, hasStrongRecentUse: false },
			event('Activated'),
			'Activated',
		],
		[
			{ lastActiveAt: day('09-06') },
			event('LimitAware', { everActivated: false }),
			'VerifiedNoMcp',
		],
	])
	expect(states.actual).toEqual(states.expected)
	const decisions = decisionTable([
		[
			singleClient,
			event('Activated', { enteredAt: day('08-01') }),
			activatedSilence,
		],
		[
			{ ...singleClient, firstSavedPackageAt: day('07-01') },
			event('Cooling', {
				enteredAt: day('08-20'),
				sendCount: 1,
				coolingTerminal: true,
				everActivated: true,
			}),
			activatedSilence,
		],
		[
			singleClient,
			event('LimitAware', { enteredAt: day('09-05'), everActivated: true }),
			activatedSilence,
		],
		[
			quiet(),
			event('Activated', {
				enteredAt: day('09-06'),
				coolingTerminal: true,
				everActivated: true,
			}),
			{
				state: 'Cooling',
				action: 'silence',
				reason: 'cooling_terminal',
				coolingTerminal: true,
			},
		],
	])
	expect(decisions.actual).toMatchObject(decisions.expected)
})

test('LimitAware with activated usage keeps history after the cap eases', () => {
	const nearCapActivated = evaluateUsageCampaign(
		snapshot(
			packaged(2, {
				firstSavedPackageAt: day('08-01'),
				isNearEntitlementCap: true,
			}),
		),
		persisted(),
	)
	expect(nearCapActivated).toMatchObject({
		state: 'LimitAware',
		action: 'silence',
		everActivated: true,
	})
	expect(
		nextUsageCampaignRow({
			decision: nearCapActivated,
			persisted: persisted(),
			now,
			sent: false,
		}).everActivated,
	).toBe(true)
	const decisions = decisionTable([
		[
			packaged(1, { firstSavedPackageAt: day('08-01') }),
			{
				state: 'LimitAware',
				enteredAt: nowIso,
				origin: 'seed',
				everActivated: true,
			},
			{ state: 'Activated', action: 'silence', reason: 'activated_silence' },
		],
		[
			{ isNearEntitlementCap: true, lastActiveAt: day('09-06') },
			{},
			{ state: 'LimitAware', action: 'silence', everActivated: false },
		],
	])
	expect(decisions.actual).toMatchObject(decisions.expected)
})

test('failed inbound listing seeds PackagedSingleClient instead of Activated', () => {
	const decisions = decisionTable([
		[
			packaged(0, { inboundListingFailed: true }),
			{},
			{
				state: 'PackagedSingleClient',
				action: 'persist',
				origin: 'seed',
				reason: 'inbound_listing_failed',
			},
		],
		[
			packaged(1, { now: later(usageCampaignFirstSendDwellMs) }),
			{ state: 'PackagedSingleClient', enteredAt: nowIso, origin: 'seed' },
			{
				state: 'PackagedSingleClient',
				action: 'persist',
				origin: 'seed',
				reason: 'seed_no_backfill',
			},
		],
	])
	expect(decisions.actual).toMatchObject(decisions.expected)
})

test('advocate one-shot mails Activated or Paid after 7 days, once, without reopening drips', () => {
	const enteredAt = new Date(
		now.getTime() - usageCampaignAdvocateMinTenureMs,
	).toISOString()
	const active = packaged(2, {
		firstSavedPackageAt: day('08-01'),
		lastActiveAt: nowIso,
	})
	const named = { ...active, username: 'kentcdodds' }
	const paidNamed = { isStripePaid: true, username: 'kentcdodds' }
	const activatedSilence = {
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	} as const
	const advocateSend = {
		action: 'send',
		template: 'advocate_referral_testimonial',
		sendIndex: 1,
		reason: 'advocate_one_shot',
	} as const
	const paidTenured = event('Paid', {
		enteredAt,
		everActivated: true,
		sendCount: 0,
	})
	const decisions = decisionTable([
		[named, {}, activatedSilence],
		[
			named,
			{ state: 'Activated', enteredAt, origin: 'seed', everActivated: true },
			{ state: 'Activated', ...advocateSend },
		],
		[
			paidNamed,
			{ ...paidTenured, firstActivatedAt: enteredAt },
			{ state: 'Paid', ...advocateSend },
		],
		[
			named,
			event('Activated', {
				enteredAt,
				everActivated: true,
				advocateSentAt: enteredAt,
			}),
			activatedSilence,
		],
		[
			active,
			event('Activated', { enteredAt, everActivated: true }),
			activatedSilence,
		],
	])
	expect(decisions.actual).toMatchObject(decisions.expected)

	expect(
		nextUsageCampaignRow({
			decision: evaluateUsageCampaign(
				snapshot(paidNamed),
				persisted(paidTenured),
			),
			persisted: persisted(paidTenured),
			now,
			sent: true,
		}),
	).toMatchObject({
		state: 'Paid',
		sendCount: 0,
		lastSentAt: null,
		advocateSentAt: nowIso,
		firstActivatedAt: enteredAt,
	})
})
