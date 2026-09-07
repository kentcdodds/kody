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

function snapshot(
	overrides: Partial<UsageCampaignSnapshot> = {},
): UsageCampaignSnapshot {
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

function persisted(
	overrides: Partial<UsageCampaignPersisted> = {},
): UsageCampaignPersisted {
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

test('evaluator walks usage stamps into states, caps, and Activated/Paid silence', () => {
	expect(resolveUsageCampaignState(snapshot(), persisted())).toBe(
		'VerifiedNoMcp',
	)
	expect(
		resolveUsageCampaignState(
			snapshot({ firstMcpConnectedAt: '2026-09-02T00:00:00.000Z' }),
			persisted(),
		),
	).toBe('ConnectedNoPackage')
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstMcpConnectedAt: '2026-09-02T00:00:00.000Z',
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				lastActiveAt: '2026-09-06T00:00:00.000Z',
				distinctInboundClientCount: 1,
			}),
			persisted(),
		),
	).toBe('PackagedSingleClient')
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				distinctInboundClientCount: 2,
				lastActiveAt: '2026-09-06T00:00:00.000Z',
			}),
			persisted(),
		),
	).toBe('Activated')
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				distinctInboundClientCount: 0,
				inboundListingFailed: true,
				lastActiveAt: '2026-09-06T00:00:00.000Z',
			}),
			persisted({ state: 'Activated', origin: 'event' }),
		),
	).toBe('Activated')
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				distinctInboundClientCount: 0,
				inboundListingFailed: true,
				lastActiveAt: '2026-09-06T00:00:00.000Z',
			}),
			persisted({
				state: 'PackagedSingleClient',
				enteredAt: '2026-09-01T00:00:00.000Z',
				origin: 'event',
			}),
		),
	).toMatchObject({
		state: 'PackagedSingleClient',
		action: 'persist',
		reason: 'inbound_listing_failed',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				distinctInboundClientCount: 1,
				executeReadFailed: true,
				lastActiveAt: '2026-09-06T00:00:00.000Z',
			}),
			persisted({
				state: 'PackagedSingleClient',
				enteredAt: '2026-09-01T00:00:00.000Z',
				origin: 'event',
			}),
		),
	).toMatchObject({
		state: 'PackagedSingleClient',
		action: 'persist',
		reason: 'execute_read_failed',
	})
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				hasEnabledScheduledJob: true,
				lastActiveAt: '2026-08-01T00:00:00.000Z',
			}),
			persisted(),
		),
	).toBe('Activated')
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				hasStrongRecentUse: true,
				lastActiveAt: '2026-09-06T00:00:00.000Z',
			}),
			persisted(),
		),
	).toBe('Activated')
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
				lastActiveAt: new Date(
					now.getTime() - usageCampaignCoolingStaleMs,
				).toISOString(),
			}),
			persisted(),
		),
	).toBe('Cooling')
	expect(
		resolveUsageCampaignState(
			snapshot({ isNearEntitlementCap: true }),
			persisted(),
		),
	).toBe('LimitAware')
	expect(
		resolveUsageCampaignState(
			snapshot({ isStripePaid: true, isNearEntitlementCap: true }),
			persisted(),
		),
	).toBe('Paid')

	const verifyFirst = evaluateUsageCampaign(
		snapshot(),
		persisted({ origin: 'event' }),
	)
	expect(verifyFirst).toMatchObject({
		state: 'VerifiedNoMcp',
		action: 'send',
		template: 'verified_no_mcp',
		sendIndex: 1,
		reason: 'entered',
	})
	expect(
		evaluateUsageCampaign(
			snapshot(),
			persisted({
				state: 'VerifiedNoMcp',
				enteredAt: now.toISOString(),
				origin: 'event',
			}),
		),
	).toMatchObject({
		state: 'VerifiedNoMcp',
		action: 'persist',
		reason: 'dwell',
	})
	expect(
		evaluateUsageCampaign(
			snapshot(),
			persisted({
				state: 'LimitAware',
				enteredAt: now.toISOString(),
				origin: 'event',
			}),
		),
	).toMatchObject({
		state: 'VerifiedNoMcp',
		action: 'persist',
		reason: 'dwell',
	})

	const afterFirst = evaluateUsageCampaign(
		snapshot(),
		persisted({
			state: 'VerifiedNoMcp',
			enteredAt: '2026-09-01T00:00:00.000Z',
			sendCount: 1,
			lastSentAt: now.toISOString(),
			origin: 'event',
		}),
	)
	expect(afterFirst.action).toBe('persist')
	expect(afterFirst.reason).toBe('interval')

	const secondDue = evaluateUsageCampaign(
		snapshot({
			now: new Date(now.getTime() + usageCampaignSendIntervalMs),
		}),
		persisted({
			state: 'VerifiedNoMcp',
			enteredAt: '2026-09-01T00:00:00.000Z',
			sendCount: 1,
			lastSentAt: now.toISOString(),
			origin: 'event',
		}),
	)
	expect(secondDue).toMatchObject({
		action: 'send',
		sendIndex: 2,
		template: 'verified_no_mcp',
	})

	const capped = evaluateUsageCampaign(
		snapshot({
			now: new Date(now.getTime() + usageCampaignSendIntervalMs * 2),
		}),
		persisted({
			state: 'VerifiedNoMcp',
			enteredAt: '2026-09-01T00:00:00.000Z',
			sendCount: 2,
			lastSentAt: now.toISOString(),
			origin: 'event',
		}),
	)
	expect(capped).toMatchObject({ action: 'persist', reason: 'cap_reached' })

	const connectedEnter = evaluateUsageCampaign(
		snapshot({ firstMcpConnectedAt: '2026-09-02T00:00:00.000Z' }),
		persisted({
			state: 'VerifiedNoMcp',
			enteredAt: '2026-09-01T00:00:00.000Z',
			sendCount: 2,
			origin: 'event',
		}),
	)
	expect(connectedEnter).toMatchObject({
		state: 'ConnectedNoPackage',
		action: 'persist',
		origin: 'event',
		reason: 'dwell',
	})

	const connectedDue = evaluateUsageCampaign(
		snapshot({
			firstMcpConnectedAt: '2026-09-02T00:00:00.000Z',
			now: new Date(now.getTime() + usageCampaignFirstSendDwellMs),
		}),
		persisted({
			state: 'ConnectedNoPackage',
			enteredAt: now.toISOString(),
			origin: 'event',
		}),
	)
	expect(connectedDue).toMatchObject({
		state: 'ConnectedNoPackage',
		action: 'send',
		template: 'connected_no_package',
		sendIndex: 1,
		origin: 'event',
	})

	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				distinctInboundClientCount: 2,
				lastActiveAt: '2026-09-06T00:00:00.000Z',
			}),
			persisted({
				state: 'PackagedSingleClient',
				enteredAt: '2026-09-03T00:00:00.000Z',
				origin: 'event',
			}),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	})

	expect(
		evaluateUsageCampaign(
			snapshot({ isStripePaid: true }),
			persisted({
				state: 'Activated',
				enteredAt: '2026-09-03T00:00:00.000Z',
				origin: 'event',
			}),
		),
	).toMatchObject({
		state: 'Paid',
		action: 'silence',
		reason: 'paid_silence',
	})
})

test('seed observations do not mail, Cooling is one send then terminal, jobs keep Activated', () => {
	const seeded = evaluateUsageCampaign(snapshot(), persisted())
	expect(seeded).toMatchObject({
		state: 'VerifiedNoMcp',
		action: 'persist',
		origin: 'seed',
		reason: 'seed_no_backfill',
	})

	const stillSeeded = evaluateUsageCampaign(
		snapshot({
			now: new Date(now.getTime() + usageCampaignSendIntervalMs * 3),
		}),
		persisted({
			state: 'VerifiedNoMcp',
			enteredAt: now.toISOString(),
			origin: 'seed',
		}),
	)
	expect(stillSeeded).toMatchObject({
		action: 'persist',
		reason: 'seed_no_backfill',
	})

	const coolingEnter = evaluateUsageCampaign(
		snapshot({
			firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
			lastActiveAt: '2026-07-01T00:00:00.000Z',
		}),
		persisted({
			state: 'Activated',
			enteredAt: '2026-07-01T00:00:00.000Z',
			origin: 'event',
		}),
	)
	expect(coolingEnter).toMatchObject({
		state: 'Cooling',
		action: 'persist',
		reason: 'dwell',
	})

	const coolingFirst = evaluateUsageCampaign(
		snapshot({
			firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
			lastActiveAt: '2026-07-01T00:00:00.000Z',
			now: new Date(now.getTime() + usageCampaignFirstSendDwellMs),
		}),
		persisted({
			state: 'Cooling',
			enteredAt: now.toISOString(),
			origin: 'event',
		}),
	)
	expect(coolingFirst).toMatchObject({
		state: 'Cooling',
		action: 'send',
		template: 'cooling',
		sendIndex: 1,
	})

	const coolingDone = evaluateUsageCampaign(
		snapshot({
			firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
			lastActiveAt: '2026-07-01T00:00:00.000Z',
		}),
		persisted({
			state: 'Cooling',
			enteredAt: now.toISOString(),
			sendCount: 1,
			lastSentAt: now.toISOString(),
			origin: 'event',
			coolingTerminal: true,
		}),
	)
	expect(coolingDone).toMatchObject({
		state: 'Cooling',
		action: 'silence',
		reason: 'cooling_terminal',
		coolingTerminal: true,
	})

	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
				lastActiveAt: '2026-07-01T00:00:00.000Z',
				hasEnabledScheduledJob: true,
			}),
			persisted({
				state: 'Cooling',
				enteredAt: now.toISOString(),
				sendCount: 1,
				origin: 'event',
				coolingTerminal: true,
			}),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'silence',
	})

	expect(
		evaluateUsageCampaign(
			snapshot({ isNearEntitlementCap: true }),
			persisted({
				state: 'ConnectedNoPackage',
				enteredAt: now.toISOString(),
				origin: 'event',
			}),
		),
	).toMatchObject({
		state: 'LimitAware',
		action: 'silence',
		reason: 'limit_aware_transactional',
	})

	const dwell = evaluateUsageCampaign(
		snapshot({ firstMcpConnectedAt: '2026-09-07T11:00:00.000Z' }),
		persisted({
			state: 'VerifiedNoMcp',
			enteredAt: '2026-09-01T00:00:00.000Z',
			origin: 'event',
		}),
	)
	expect(dwell).toMatchObject({
		state: 'ConnectedNoPackage',
		action: 'persist',
		reason: 'dwell',
	})
})

test('missing last_active uses the newest known stamp and does not invent Cooling', () => {
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstMcpConnectedAt: '2026-09-02T00:00:00.000Z',
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				lastActiveAt: null,
				distinctInboundClientCount: 1,
			}),
			persisted(),
		),
	).toBe('PackagedSingleClient')
	expect(
		resolveUsageCampaignState(
			snapshot({
				emailVerifiedAt: '2026-07-01T00:00:00.000Z',
				firstMcpConnectedAt: '2026-07-02T00:00:00.000Z',
				firstSavedPackageAt: '2026-07-03T00:00:00.000Z',
				lastActiveAt: null,
				lastJobActivityAt: null,
				distinctInboundClientCount: 1,
			}),
			persisted(),
		),
	).toBe('Cooling')
})

test('failed job listing does not invent Cooling or demote Activated', () => {
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				lastActiveAt: null,
				distinctInboundClientCount: 1,
				jobListingFailed: true,
			}),
			persisted({ state: 'Activated', origin: 'event' }),
		),
	).toBe('Activated')
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
				lastActiveAt: '2026-07-01T00:00:00.000Z',
				jobListingFailed: true,
				now: new Date(now.getTime() + usageCampaignFirstSendDwellMs),
			}),
			persisted({
				state: 'Cooling',
				enteredAt: now.toISOString(),
				origin: 'event',
			}),
		),
	).toMatchObject({
		state: 'Cooling',
		action: 'persist',
		reason: 'job_listing_failed',
	})
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				lastActiveAt: null,
				distinctInboundClientCount: 1,
				jobListingFailed: true,
			}),
			persisted(),
		),
	).toBe('PackagedSingleClient')
	const firstQuietJobsFailed = evaluateUsageCampaign(
		snapshot({
			firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
			lastActiveAt: '2026-07-01T00:00:00.000Z',
			jobListingFailed: true,
		}),
		persisted(),
	)
	expect(firstQuietJobsFailed).toMatchObject({
		state: 'Cooling',
		action: 'persist',
		origin: 'seed',
		reason: 'job_listing_failed',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
				lastActiveAt: '2026-07-01T00:00:00.000Z',
				now: new Date(now.getTime() + usageCampaignFirstSendDwellMs),
			}),
			persisted({
				state: 'Cooling',
				enteredAt: now.toISOString(),
				origin: 'seed',
			}),
		),
	).toMatchObject({
		state: 'Cooling',
		action: 'persist',
		origin: 'seed',
		reason: 'seed_no_backfill',
	})
})

test('Activated and Cooling history does not fall back into PackagedSingleClient mail', () => {
	expect(
		resolveUsageCampaignState(
			snapshot({
				firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
				lastActiveAt: '2026-09-06T00:00:00.000Z',
				distinctInboundClientCount: 1,
				hasStrongRecentUse: false,
			}),
			persisted({ state: 'Activated', origin: 'event' }),
		),
	).toBe('Activated')
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
				lastActiveAt: '2026-09-06T00:00:00.000Z',
				distinctInboundClientCount: 1,
			}),
			persisted({
				state: 'Activated',
				enteredAt: '2026-08-01T00:00:00.000Z',
				origin: 'event',
			}),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
				lastActiveAt: '2026-09-06T00:00:00.000Z',
				distinctInboundClientCount: 1,
			}),
			persisted({
				state: 'Cooling',
				enteredAt: '2026-08-20T00:00:00.000Z',
				sendCount: 1,
				origin: 'event',
				coolingTerminal: true,
				everActivated: true,
			}),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
				lastActiveAt: '2026-09-06T00:00:00.000Z',
				distinctInboundClientCount: 1,
			}),
			persisted({
				state: 'LimitAware',
				enteredAt: '2026-09-05T00:00:00.000Z',
				origin: 'event',
				everActivated: true,
			}),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	})
	expect(
		resolveUsageCampaignState(
			snapshot({
				lastActiveAt: '2026-09-06T00:00:00.000Z',
			}),
			persisted({
				state: 'LimitAware',
				origin: 'event',
				everActivated: false,
			}),
		),
	).toBe('VerifiedNoMcp')
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
				lastActiveAt: '2026-07-01T00:00:00.000Z',
			}),
			persisted({
				state: 'Activated',
				enteredAt: '2026-09-06T00:00:00.000Z',
				origin: 'event',
				coolingTerminal: true,
				everActivated: true,
			}),
		),
	).toMatchObject({
		state: 'Cooling',
		action: 'silence',
		reason: 'cooling_terminal',
		coolingTerminal: true,
	})
})

test('LimitAware with activated usage keeps history after the cap eases', () => {
	const nearCapActivated = evaluateUsageCampaign(
		snapshot({
			firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
			lastActiveAt: '2026-09-06T00:00:00.000Z',
			distinctInboundClientCount: 2,
			isNearEntitlementCap: true,
		}),
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
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
				lastActiveAt: '2026-09-06T00:00:00.000Z',
				distinctInboundClientCount: 1,
			}),
			persisted({
				state: 'LimitAware',
				enteredAt: now.toISOString(),
				origin: 'seed',
				everActivated: true,
			}),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				isNearEntitlementCap: true,
				lastActiveAt: '2026-09-06T00:00:00.000Z',
			}),
			persisted(),
		),
	).toMatchObject({
		state: 'LimitAware',
		action: 'silence',
		everActivated: false,
	})
})

test('failed inbound listing seeds PackagedSingleClient instead of Activated', () => {
	const first = evaluateUsageCampaign(
		snapshot({
			firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
			distinctInboundClientCount: 0,
			inboundListingFailed: true,
			lastActiveAt: '2026-09-06T00:00:00.000Z',
		}),
		persisted(),
	)
	expect(first).toMatchObject({
		state: 'PackagedSingleClient',
		action: 'persist',
		origin: 'seed',
		reason: 'inbound_listing_failed',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-09-03T00:00:00.000Z',
				distinctInboundClientCount: 1,
				lastActiveAt: '2026-09-06T00:00:00.000Z',
				now: new Date(now.getTime() + usageCampaignFirstSendDwellMs),
			}),
			persisted({
				state: 'PackagedSingleClient',
				enteredAt: now.toISOString(),
				origin: 'seed',
			}),
		),
	).toMatchObject({
		state: 'PackagedSingleClient',
		action: 'persist',
		origin: 'seed',
		reason: 'seed_no_backfill',
	})
})

test('advocate one-shot mails Activated or Paid after 7 days, once, without reopening drips', () => {
	const enteredAt = new Date(
		now.getTime() - usageCampaignAdvocateMinTenureMs,
	).toISOString()
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
				distinctInboundClientCount: 2,
				lastActiveAt: now.toISOString(),
				username: 'kentcdodds',
			}),
			persisted(),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
				distinctInboundClientCount: 2,
				lastActiveAt: now.toISOString(),
				username: 'kentcdodds',
			}),
			persisted({
				state: 'Activated',
				enteredAt,
				origin: 'seed',
				everActivated: true,
			}),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'send',
		template: 'advocate_referral_testimonial',
		sendIndex: 1,
		reason: 'advocate_one_shot',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				isStripePaid: true,
				username: 'kentcdodds',
			}),
			persisted({
				state: 'Paid',
				enteredAt,
				origin: 'event',
				everActivated: true,
				firstActivatedAt: enteredAt,
			}),
		),
	).toMatchObject({
		state: 'Paid',
		action: 'send',
		template: 'advocate_referral_testimonial',
		sendIndex: 1,
		reason: 'advocate_one_shot',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
				distinctInboundClientCount: 2,
				lastActiveAt: now.toISOString(),
				username: 'kentcdodds',
			}),
			persisted({
				state: 'Activated',
				enteredAt,
				origin: 'event',
				everActivated: true,
				advocateSentAt: enteredAt,
			}),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	})
	expect(
		evaluateUsageCampaign(
			snapshot({
				firstSavedPackageAt: '2026-08-01T00:00:00.000Z',
				distinctInboundClientCount: 2,
				lastActiveAt: now.toISOString(),
			}),
			persisted({
				state: 'Activated',
				enteredAt,
				origin: 'event',
				everActivated: true,
			}),
		),
	).toMatchObject({
		state: 'Activated',
		action: 'silence',
		reason: 'activated_silence',
	})

	const advocateDecision = evaluateUsageCampaign(
		snapshot({
			isStripePaid: true,
			username: 'kentcdodds',
		}),
		persisted({
			state: 'Paid',
			enteredAt,
			origin: 'event',
			everActivated: true,
			sendCount: 0,
		}),
	)
	expect(
		nextUsageCampaignRow({
			decision: advocateDecision,
			persisted: persisted({
				state: 'Paid',
				enteredAt,
				origin: 'event',
				everActivated: true,
				sendCount: 0,
			}),
			now,
			sent: true,
		}),
	).toMatchObject({
		state: 'Paid',
		sendCount: 0,
		lastSentAt: null,
		advocateSentAt: now.toISOString(),
		firstActivatedAt: enteredAt,
	})
})
