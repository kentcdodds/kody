import { expect, test } from 'vitest'
import {
	evaluateUsageCampaign,
	resolveUsageCampaignState,
	type UsageCampaignPersisted,
	type UsageCampaignSnapshot,
} from './campaign-evaluator.ts'
import {
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
