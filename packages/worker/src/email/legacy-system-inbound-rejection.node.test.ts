import { expect, test } from 'vitest'
import * as inboundDelivery from './inbound-delivery.ts'
import { claimSystemInboundDeliveryWindow } from './system-inbound-delivery-authority.ts'
import { getSystemInboundDelivery } from './system-inbound-delivery-store.ts'

test('legacy shared-graph inbound entry points are absent after dedicated system cutover', () => {
	for (const legacyExport of [
		'getInboundDelivery',
		'claimInboundDeliveryWindow',
		'getInboundDeliveryWindow',
		'pruneExpiredInboundDedupePointers',
		'chargeSystemInboundDeliveryOnce',
		'markInboundDeliveryRejected',
		'claimInboundDeliveryStorage',
		'releaseInboundDeliveryStorage',
		'markInboundDeliveryReceived',
		'reconcileStaleInboundDeliveries',
	]) {
		expect(inboundDelivery).not.toHaveProperty(legacyExport)
	}
	expect(claimSystemInboundDeliveryWindow).toBeTypeOf('function')
	expect(getSystemInboundDelivery).toBeTypeOf('function')
})
