import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { insertInput } from './mailbox-inbound-ledger-test-helpers.ts'
import {
	mailboxInboundProvider,
	type MailboxInboundDeliveryInsertInput,
} from './mailbox-inbound-ledger.ts'
import { rpcFor, stubFor, uniqueUserId } from './mailbox-test-helpers.ts'

async function insertClaimAndReceive(
	mailbox: ReturnType<typeof rpcFor>,
	ownerId: string,
	delivery: MailboxInboundDeliveryInsertInput,
	now: string,
) {
	await mailbox.insertChargedPendingInboundDelivery({
		ownerId,
		delivery,
		now,
	})
	const claim = await mailbox.claimInboundDeliveryStorage({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now,
	})
	expect(claim.status).toBe('claimed')
	if (claim.status !== 'claimed') throw new Error('expected claim')
	const received = await mailbox.markInboundDeliveryReceived({
		ownerId,
		deliveryId: delivery.deliveryId,
		storageLease: claim.delivery.storageLease!,
		usageDurationMs: 25,
		usageMonth: '2026-07',
		usageBytes: 64,
		now,
	})
	expect(received.status).toBe('received')
	if (received.status !== 'received') throw new Error('expected received')
	return received
}

test('Mailbox inbound usage and subscription effects enforce exactly-once leases, retry, and dead-letter', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('effect-exactly-once')
	const mailbox = rpcFor(ownerId)
	const now = '2026-07-22T00:00:00.000Z'
	const delivery = insertInput(ownerId, {
		fingerprint: 'fp-effect-exactly-once',
		deliveryId: 'email-inbound-delivery:effect-exactly-once',
		messageId: 'email-inbound-message:effect-exactly-once',
		threadId: 'email-inbound-thread:effect-exactly-once',
	})
	const received = await insertClaimAndReceive(mailbox, ownerId, delivery, now)
	const finalizationToken = received.delivery.finalizationToken!

	const usageClaim = await mailbox.claimInboundUsageEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: finalizationToken,
		now,
	})
	expect(usageClaim.status).toBe('claimed')
	if (usageClaim.status !== 'claimed') throw new Error('expected usage claim')
	const usageBusy = await mailbox.claimInboundUsageEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		now,
	})
	expect(usageBusy.status).toBe('not-claimable')
	const usageDone = await mailbox.completeInboundUsageEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		usageEffectLease: usageClaim.delivery.usageEffectLease!,
		expectedFinalizationToken: finalizationToken,
		mode: 'recorded',
		usageMonth: '2026-07',
		usageBytes: 64,
		usageDurationMs: 25,
		now,
	})
	expect(usageDone.status).toBe('recorded')
	const usageReplay = await mailbox.claimInboundUsageEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		now,
	})
	expect(usageReplay.status).toBe('already-complete')

	const subClaim = await mailbox.claimInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: finalizationToken,
		now,
	})
	expect(subClaim.status).toBe('claimed')
	if (subClaim.status !== 'claimed') throw new Error('expected sub claim')
	const fail1 = await mailbox.failInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		subscriptionEffectLease: subClaim.delivery.subscriptionEffectLease!,
		expectedFinalizationToken: finalizationToken,
		error: 'transient-1',
		now,
	})
	expect(fail1.status).toBe('retry')

	const retryAt =
		fail1.status === 'retry' ? fail1.delivery.subscriptionEffectRetryAt! : now
	const subClaim2 = await mailbox.claimInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: finalizationToken,
		now: retryAt,
	})
	expect(subClaim2.status).toBe('claimed')
	if (subClaim2.status !== 'claimed') throw new Error('expected sub claim 2')
	const fail2 = await mailbox.failInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		subscriptionEffectLease: subClaim2.delivery.subscriptionEffectLease!,
		expectedFinalizationToken: finalizationToken,
		error: 'transient-2',
		now: retryAt,
	})
	expect(fail2.status).toBe('retry')
	const retryAt2 =
		fail2.status === 'retry'
			? fail2.delivery.subscriptionEffectRetryAt!
			: retryAt
	const subClaim3 = await mailbox.claimInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: finalizationToken,
		now: retryAt2,
	})
	expect(subClaim3.status).toBe('claimed')
	if (subClaim3.status !== 'claimed') throw new Error('expected sub claim 3')
	const dead = await mailbox.failInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		subscriptionEffectLease: subClaim3.delivery.subscriptionEffectLease!,
		expectedFinalizationToken: finalizationToken,
		error: 'final',
		now: retryAt2,
	})
	expect(dead.status).toBe('dead-letter')
})

test('Mailbox inbound usage and subscription effects support suppression on received deliveries', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('effect-suppress')
	const mailbox = rpcFor(ownerId)
	const now = '2026-07-22T00:00:00.000Z'
	const suppressDelivery = insertInput(ownerId, {
		fingerprint: 'fp-suppress',
		deliveryId: 'email-inbound-delivery:suppress',
		messageId: 'email-inbound-message:suppress',
		threadId: 'email-inbound-thread:suppress',
	})
	const suppressReceived = await insertClaimAndReceive(
		mailbox,
		ownerId,
		suppressDelivery,
		now,
	)
	const suppressToken = suppressReceived.delivery.finalizationToken!

	const usageSuppressClaim = await mailbox.claimInboundUsageEffect({
		ownerId,
		deliveryId: suppressDelivery.deliveryId,
		now,
	})
	expect(usageSuppressClaim.status).toBe('claimed')
	if (usageSuppressClaim.status !== 'claimed') {
		throw new Error('expected usage suppress claim')
	}
	expect(
		(
			await mailbox.completeInboundUsageEffect({
				ownerId,
				deliveryId: suppressDelivery.deliveryId,
				usageEffectLease: usageSuppressClaim.delivery.usageEffectLease!,
				expectedFinalizationToken: suppressToken,
				mode: 'suppressed',
				usageMonth: '2026-07',
				usageBytes: 1,
				usageDurationMs: 1,
				now,
			})
		).status,
	).toBe('suppressed')
	const subSuppressClaim = await mailbox.claimInboundSubscriptionEffect({
		ownerId,
		deliveryId: suppressDelivery.deliveryId,
		expectedFinalizationToken: suppressToken,
		now,
	})
	expect(subSuppressClaim.status).toBe('claimed')
	if (subSuppressClaim.status !== 'claimed') {
		throw new Error('expected sub suppress claim')
	}
	expect(
		(
			await mailbox.completeInboundSubscriptionEffect({
				ownerId,
				deliveryId: suppressDelivery.deliveryId,
				subscriptionEffectLease:
					subSuppressClaim.delivery.subscriptionEffectLease!,
				expectedFinalizationToken: suppressToken,
				mode: 'suppressed',
				suppressionReason: 'quarantine',
				now,
			})
		).status,
	).toBe('suppressed')
})

test('stale effect workers cannot complete or fail after storage reclaim re-finalization', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('reclaim-fence')
	const mailbox = rpcFor(ownerId)
	const now = '2026-07-22T00:00:00.000Z'
	const delivery = insertInput(ownerId, {
		fingerprint: 'fp-reclaim-fence',
		deliveryId: 'email-inbound-delivery:reclaim-fence',
		messageId: 'email-inbound-message:reclaim-fence',
		threadId: 'email-inbound-thread:reclaim-fence',
	})

	await mailbox.insertChargedPendingInboundDelivery({
		ownerId,
		delivery,
		now,
	})
	const firstClaim = await mailbox.claimInboundDeliveryStorage({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now,
	})
	expect(firstClaim.status).toBe('claimed')
	if (firstClaim.status !== 'claimed') throw new Error('expected first claim')
	const firstReceived = await mailbox.markInboundDeliveryReceived({
		ownerId,
		deliveryId: delivery.deliveryId,
		storageLease: firstClaim.delivery.storageLease!,
		usageDurationMs: 5,
		usageMonth: '2026-07',
		usageBytes: 8,
		now,
	})
	expect(firstReceived.status).toBe('received')
	if (firstReceived.status !== 'received') throw new Error('expected received')
	const staleToken = firstReceived.delivery.finalizationToken!
	expect(staleToken).toBeTruthy()

	const staleUsageClaim = await mailbox.claimInboundUsageEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: staleToken,
		now,
	})
	expect(staleUsageClaim.status).toBe('claimed')
	if (staleUsageClaim.status !== 'claimed') {
		throw new Error('expected stale usage claim')
	}
	const staleUsageLease = staleUsageClaim.delivery.usageEffectLease!
	const staleSubClaim = await mailbox.claimInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: staleToken,
		now,
	})
	expect(staleSubClaim.status).toBe('claimed')
	if (staleSubClaim.status !== 'claimed') {
		throw new Error('expected stale subscription claim')
	}
	const staleSubLease = staleSubClaim.delivery.subscriptionEffectLease!

	// Reclaim storage (no message row) — clears finalization + effect leases.
	const reclaim = await mailbox.claimInboundDeliveryStorage({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now: '2026-07-22T00:01:00.000Z',
	})
	expect(reclaim.status).toBe('claimed')
	if (reclaim.status !== 'claimed') throw new Error('expected reclaim')
	expect(reclaim.delivery.finalizationToken).toBeUndefined()
	expect(reclaim.delivery.usageEffectLease).toBeUndefined()
	expect(reclaim.delivery.subscriptionEffectLease).toBeUndefined()
	expect(reclaim.delivery.subscriptionEffectState).toBe('pending')

	const secondReceived = await mailbox.markInboundDeliveryReceived({
		ownerId,
		deliveryId: delivery.deliveryId,
		storageLease: reclaim.delivery.storageLease!,
		usageDurationMs: 9,
		usageMonth: '2026-07',
		usageBytes: 16,
		now: '2026-07-22T00:01:01.000Z',
	})
	expect(secondReceived.status).toBe('received')
	if (secondReceived.status !== 'received') {
		throw new Error('expected second received')
	}
	const freshToken = secondReceived.delivery.finalizationToken!
	expect(freshToken).toBeTruthy()
	expect(freshToken).not.toBe(staleToken)

	// Stale workers with prior token/leases cannot complete or fail.
	expect(
		(
			await mailbox.completeInboundUsageEffect({
				ownerId,
				deliveryId: delivery.deliveryId,
				usageEffectLease: staleUsageLease,
				expectedFinalizationToken: staleToken,
				mode: 'recorded',
				usageMonth: '2026-07',
				usageBytes: 8,
				usageDurationMs: 5,
				now: '2026-07-22T00:01:02.000Z',
			})
		).status,
	).toBe('lease-lost')
	expect(
		(
			await mailbox.completeInboundSubscriptionEffect({
				ownerId,
				deliveryId: delivery.deliveryId,
				subscriptionEffectLease: staleSubLease,
				expectedFinalizationToken: staleToken,
				mode: 'complete',
				now: '2026-07-22T00:01:02.000Z',
			})
		).status,
	).toBe('lease-lost')
	expect(
		(
			await mailbox.failInboundSubscriptionEffect({
				ownerId,
				deliveryId: delivery.deliveryId,
				subscriptionEffectLease: staleSubLease,
				expectedFinalizationToken: staleToken,
				error: 'stale-fail',
				now: '2026-07-22T00:01:02.000Z',
			})
		).status,
	).toBe('lease-lost')
	// Stale lease + fresh token still loses (lease cleared on reclaim).
	expect(
		(
			await mailbox.completeInboundUsageEffect({
				ownerId,
				deliveryId: delivery.deliveryId,
				usageEffectLease: staleUsageLease,
				expectedFinalizationToken: freshToken,
				mode: 'recorded',
				usageMonth: '2026-07',
				usageBytes: 8,
				usageDurationMs: 5,
				now: '2026-07-22T00:01:02.000Z',
			})
		).status,
	).toBe('lease-lost')

	// Fresh worker with the new finalization token can claim and complete.
	const freshUsageClaim = await mailbox.claimInboundUsageEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: freshToken,
		now: '2026-07-22T00:01:03.000Z',
	})
	expect(freshUsageClaim.status).toBe('claimed')
	if (freshUsageClaim.status !== 'claimed') {
		throw new Error('expected fresh usage claim')
	}
	expect(
		(
			await mailbox.completeInboundUsageEffect({
				ownerId,
				deliveryId: delivery.deliveryId,
				usageEffectLease: freshUsageClaim.delivery.usageEffectLease!,
				expectedFinalizationToken: freshToken,
				mode: 'recorded',
				usageMonth: '2026-07',
				usageBytes: 16,
				usageDurationMs: 9,
				now: '2026-07-22T00:01:03.000Z',
			})
		).status,
	).toBe('recorded')

	const freshSubClaim = await mailbox.claimInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: freshToken,
		now: '2026-07-22T00:01:04.000Z',
	})
	expect(freshSubClaim.status).toBe('claimed')
	if (freshSubClaim.status !== 'claimed') {
		throw new Error('expected fresh subscription claim')
	}
	expect(
		(
			await mailbox.completeInboundSubscriptionEffect({
				ownerId,
				deliveryId: delivery.deliveryId,
				subscriptionEffectLease:
					freshSubClaim.delivery.subscriptionEffectLease!,
				expectedFinalizationToken: freshToken,
				mode: 'complete',
				now: '2026-07-22T00:01:04.000Z',
			})
		).status,
	).toBe('complete')

	const terminalReclaim = await mailbox.claimInboundDeliveryStorage({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now: '2026-07-22T00:02:00.000Z',
	})
	expect(terminalReclaim.status).toBe('claimed')
	if (terminalReclaim.status !== 'claimed') {
		throw new Error('expected terminal-state reclaim')
	}
	const thirdReceived = await mailbox.markInboundDeliveryReceived({
		ownerId,
		deliveryId: delivery.deliveryId,
		storageLease: terminalReclaim.delivery.storageLease!,
		usageDurationMs: 9,
		usageMonth: '2026-07',
		usageBytes: 16,
		now: '2026-07-22T00:02:01.000Z',
	})
	expect(thirdReceived.status).toBe('received')
	if (thirdReceived.status !== 'received') {
		throw new Error('expected third received')
	}
	expect(thirdReceived.delivery.subscriptionEffectState).toBe('pending')
})

test('legacy received rows with null effect lease timestamps and null subscription state are claimable and due', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('null-lease')
	const mailbox = rpcFor(ownerId)
	const now = '2026-07-22T00:00:00.000Z'
	const delivery = insertInput(ownerId, {
		fingerprint: 'fp-null-lease',
		deliveryId: 'email-inbound-delivery:null-lease',
		messageId: 'email-inbound-message:null-lease',
		threadId: 'email-inbound-thread:null-lease',
	})

	await mailbox.insertChargedPendingInboundDelivery({
		ownerId,
		delivery,
		now,
	})
	const storage = await mailbox.claimInboundDeliveryStorage({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now,
	})
	expect(storage.status).toBe('claimed')
	if (storage.status !== 'claimed') throw new Error('expected claim')
	const received = await mailbox.markInboundDeliveryReceived({
		ownerId,
		deliveryId: delivery.deliveryId,
		storageLease: storage.delivery.storageLease!,
		usageDurationMs: 5,
		usageMonth: '2026-07',
		usageBytes: 8,
		now,
	})
	expect(received.status).toBe('received')
	if (received.status !== 'received') throw new Error('expected received')
	const finalizationToken = received.delivery.finalizationToken!
	expect(finalizationToken).toBeTruthy()

	// Simulate legacy/imported received row: null leases + null subscription state
	// in both columns and detail_json (snapshot falls back to detail).
	await runInDurableObject(stubFor(ownerId), async (_instance, state) => {
		state.storage.sql.exec(
			`UPDATE email_delivery_events
			 SET usage_effect_lease = 'legacy-usage-lease',
			     usage_effect_lease_at = NULL,
			     subscription_effect_state = NULL,
			     subscription_effect_lease = 'legacy-sub-lease',
			     subscription_effect_lease_at = NULL,
			     detail_json = json_remove(
			       json_remove(
			         json_remove(
			           json_remove(
			             json_remove(detail_json, '$.subscriptionEffectState'),
			             '$.usageEffectLeaseAt'
			           ),
			           '$.subscriptionEffectLeaseAt'
			         ),
			         '$.usageEffectLease'
			       ),
			       '$.subscriptionEffectLease'
			     )
			 WHERE id = ? AND provider = ?`,
			delivery.deliveryId,
			mailboxInboundProvider,
		)
	})

	const due = await mailbox.listDueInboundEffectWork({
		ownerId,
		now: '2026-07-22T00:00:01.000Z',
		limit: 50,
	})
	expect(
		due.deliveries.some((entry) => entry.deliveryId === delivery.deliveryId),
	).toBe(true)

	const usage = await mailbox.claimInboundUsageEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: finalizationToken,
		now: '2026-07-22T00:00:02.000Z',
	})
	expect(usage.status).toBe('claimed')
	if (usage.status !== 'claimed') throw new Error('expected usage claim')
	expect(usage.delivery.usageEffectLease).not.toBe('legacy-usage-lease')

	const subscription = await mailbox.claimInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: finalizationToken,
		now: '2026-07-22T00:00:03.000Z',
	})
	expect(subscription.status).toBe('claimed')
	if (subscription.status !== 'claimed') {
		throw new Error('expected subscription claim')
	}
	expect(subscription.delivery.subscriptionEffectLease).not.toBe(
		'legacy-sub-lease',
	)
	expect(subscription.delivery.subscriptionEffectState).toBe('processing')
})

test('processing subscription rows with null lease_at remain reclaimable and due', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('null-sub-lease-at')
	const mailbox = rpcFor(ownerId)
	const now = '2026-07-22T00:00:00.000Z'
	const delivery = insertInput(ownerId, {
		fingerprint: 'fp-null-sub-lease-at',
		deliveryId: 'email-inbound-delivery:null-sub-lease-at',
		messageId: 'email-inbound-message:null-sub-lease-at',
		threadId: 'email-inbound-thread:null-sub-lease-at',
	})

	await mailbox.insertChargedPendingInboundDelivery({
		ownerId,
		delivery,
		now,
	})
	const storage = await mailbox.claimInboundDeliveryStorage({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now,
	})
	expect(storage.status).toBe('claimed')
	if (storage.status !== 'claimed') throw new Error('expected claim')
	const received = await mailbox.markInboundDeliveryReceived({
		ownerId,
		deliveryId: delivery.deliveryId,
		storageLease: storage.delivery.storageLease!,
		usageDurationMs: 5,
		usageMonth: '2026-07',
		usageBytes: 8,
		now,
	})
	expect(received.status).toBe('received')
	if (received.status !== 'received') throw new Error('expected received')
	const finalizationToken = received.delivery.finalizationToken!

	await runInDurableObject(stubFor(ownerId), async (_instance, state) => {
		state.storage.sql.exec(
			`UPDATE email_delivery_events
			 SET subscription_effect_state = 'processing',
			     subscription_effect_lease = 'stale-lease',
			     subscription_effect_lease_at = NULL,
			     detail_json = json_remove(
			       json_set(
			         json_set(detail_json, '$.subscriptionEffectState', 'processing'),
			         '$.subscriptionEffectLease',
			         'stale-lease'
			       ),
			       '$.subscriptionEffectLeaseAt'
			     )
			 WHERE id = ? AND provider = ?`,
			delivery.deliveryId,
			mailboxInboundProvider,
		)
	})

	const due = await mailbox.listDueInboundEffectWork({
		ownerId,
		now: '2026-07-22T00:00:01.000Z',
		limit: 50,
	})
	expect(
		due.deliveries.some((entry) => entry.deliveryId === delivery.deliveryId),
	).toBe(true)

	const subscription = await mailbox.claimInboundSubscriptionEffect({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: finalizationToken,
		now: '2026-07-22T00:00:02.000Z',
	})
	expect(subscription.status).toBe('claimed')
	if (subscription.status !== 'claimed') {
		throw new Error('expected subscription claim')
	}
	expect(subscription.delivery.subscriptionEffectLease).not.toBe('stale-lease')
})
