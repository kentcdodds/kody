import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import { Mailbox } from './mailbox-do.ts'
import { insertInput } from './mailbox-inbound-ledger-test-helpers.ts'
import {
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
	mailboxInboundStorageLeaseMs,
} from './mailbox-inbound-ledger.ts'
import { initializeMailboxSchema } from './mailbox-schema.ts'
import {
	mailboxMetaSchemaVersionKey,
	mailboxSchemaVersion,
} from './mailbox-types.ts'
import {
	assertMailboxThrows,
	rpcFor,
	stubFor,
	uniqueUserId,
} from './mailbox-test-helpers.ts'

test('Mailbox inbound ledger CAS covers USER transition matrix without live flip', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerA = uniqueUserId('ledger-a')
	const ownerB = uniqueUserId('ledger-b')
	const mailboxA = rpcFor(ownerA)
	const mailboxB = rpcFor(ownerB)
	const now = '2026-07-22T00:00:00.000Z'

	// Schema v2 indexes present after cold init.
	await runInDurableObject(
		stubFor(ownerA),
		async (_instance: Mailbox, state) => {
			expect(mailboxSchemaVersion).toBe(2)
			const version = state.storage.sql
				.exec<{ value: number }>(
					`SELECT value FROM mailbox_meta WHERE key = ?`,
					mailboxMetaSchemaVersionKey,
				)
				.toArray()[0]?.value
			expect(Number(version)).toBe(mailboxSchemaVersion)
			const schemaV2Indexes = [
				'idx_email_delivery_events_reconcile_after',
				'idx_email_delivery_events_usage_effect_retry',
				'idx_email_delivery_events_subscription_effect_retry',
				'idx_email_delivery_events_stale_state',
				'idx_email_delivery_events_dedupe_provider_expires',
			] as const
			const indexes = state.storage.sql
				.exec<{ name: string }>(
					`SELECT name FROM sqlite_master
				WHERE type = 'index'
					AND name IN (
						'idx_email_delivery_events_reconcile_after',
						'idx_email_delivery_events_usage_effect_retry',
						'idx_email_delivery_events_subscription_effect_retry',
						'idx_email_delivery_events_stale_state',
						'idx_email_delivery_events_dedupe_provider_expires'
					)
				ORDER BY name ASC`,
				)
				.toArray()
				.map((row) => row.name)
			expect(indexes).toEqual([...schemaV2Indexes].sort())
			for (const name of schemaV2Indexes) {
				expect(indexes.filter((entry) => entry === name)).toHaveLength(1)
			}
		},
	)

	const delivery = insertInput(ownerA, {
		fingerprint: 'fp-concurrent-dedupe',
		deliveryId: 'email-inbound-delivery:concurrent',
		messageId: 'email-inbound-message:concurrent',
		threadId: 'email-inbound-thread:concurrent',
	})

	// Concurrent dedupe window claim / rewrite.
	const window1 = await mailboxA.claimInboundDeliveryWindow({
		ownerId: ownerA,
		delivery,
		now,
	})
	expect(window1.deliveryId).toBe(delivery.deliveryId)
	expect(window1.fingerprint).toBe(delivery.fingerprint)
	const windowAgain = await mailboxA.claimInboundDeliveryWindow({
		ownerId: ownerA,
		delivery: {
			...delivery,
			deliveryId: 'email-inbound-delivery:rewritten',
			messageId: 'email-inbound-message:rewritten',
			threadId: 'email-inbound-thread:rewritten',
			rawMimeKey: emailRawMimeKey(ownerA, 'email-inbound-message:rewritten'),
		},
		now: '2026-07-22T01:00:00.000Z',
	})
	// Active window is not rewritten.
	expect(windowAgain.deliveryId).toBe(delivery.deliveryId)
	const activeWindow = await mailboxA.getInboundDeliveryWindow({
		ownerId: ownerA,
		fingerprint: delivery.fingerprint,
		now,
	})
	expect(activeWindow?.deliveryId).toBe(delivery.deliveryId)

	// UserMeter-following insert replay shape: inserted then existed.
	const inserted = await mailboxA.insertChargedPendingInboundDelivery({
		ownerId: ownerA,
		delivery,
		now,
	})
	expect(inserted.status).toBe('inserted')
	const replay = await mailboxA.insertChargedPendingInboundDelivery({
		ownerId: ownerA,
		delivery,
		now: '2026-07-22T00:00:01.000Z',
	})
	expect(replay.status).toBe('existed')
	expect(replay.delivery.deliveryId).toBe(delivery.deliveryId)

	// Storage lease claim / stale release / finalize vs reject.
	const claim = await mailboxA.claimInboundDeliveryStorage({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now,
	})
	expect(claim.status).toBe('claimed')
	if (claim.status !== 'claimed') throw new Error('expected claim')
	const lease = claim.delivery.storageLease
	expect(lease).toBeTruthy()

	const staleRelease = await mailboxA.releaseInboundDeliveryStorage({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		storageLease: 'wrong-lease',
		now,
	})
	expect(staleRelease.status).toBe('not-held')

	const released = await mailboxA.releaseInboundDeliveryStorage({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		storageLease: lease!,
		now: '2026-07-22T00:00:02.000Z',
	})
	expect(released.status).toBe('released')

	const reclaimAt = '2026-07-22T00:00:03.000Z'
	const reclaim = await mailboxA.claimInboundDeliveryStorage({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now: reclaimAt,
	})
	expect(reclaim.status).toBe('claimed')
	if (reclaim.status !== 'claimed') throw new Error('expected reclaim')

	// Stale lease cannot finalize after takeover.
	const staleLease = reclaim.delivery.storageLease
	const takeoverNow = new Date(
		Date.parse(reclaimAt) + mailboxInboundStorageLeaseMs + 1_000,
	).toISOString()
	const takeover = await mailboxA.claimInboundDeliveryStorage({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now: takeoverNow,
	})
	expect(takeover.status).toBe('claimed')
	if (takeover.status !== 'claimed') throw new Error('expected takeover')
	expect(takeover.delivery.storageLease).not.toBe(staleLease)

	const staleFinalize = await mailboxA.markInboundDeliveryReceived({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		storageLease: staleLease!,
		usageDurationMs: 10,
		usageMonth: '2026-07',
		usageBytes: 32,
		now: takeoverNow,
	})
	expect(staleFinalize.status).toBe('lease-lost')

	const received = await mailboxA.markInboundDeliveryReceived({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		storageLease: takeover.delivery.storageLease!,
		usageDurationMs: 25,
		usageMonth: '2026-07',
		usageBytes: 64,
		now: takeoverNow,
	})
	expect(received.status).toBe('received')
	if (received.status !== 'received') throw new Error('expected received')
	expect(received.delivery.state).toBe('received')
	expect(received.delivery.finalizationToken).toBe(
		takeover.delivery.storageLease,
	)
	expect(received.delivery.subscriptionEffectState).toBe('pending')

	const rejectAfterReceived = await mailboxA.markInboundDeliveryRejected({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		reason: 'too-late',
		now: takeoverNow,
	})
	// No message row → lease-lost (D1 would throw); with message would be already-received.
	expect(rejectAfterReceived.status).toBe('lease-lost')

	// Rejected path on a separate delivery.
	const rejectedDelivery = insertInput(ownerA, {
		fingerprint: 'fp-rejected',
		deliveryId: 'email-inbound-delivery:rejected',
		messageId: 'email-inbound-message:rejected',
		threadId: 'email-inbound-thread:rejected',
	})
	await mailboxA.insertChargedPendingInboundDelivery({
		ownerId: ownerA,
		delivery: rejectedDelivery,
		now,
	})
	const rejected = await mailboxA.markInboundDeliveryRejected({
		ownerId: ownerA,
		deliveryId: rejectedDelivery.deliveryId,
		reason: 'policy',
		expectedStorageLease: null,
		expectedState: 'pending',
		now,
	})
	expect(rejected.status).toBe('rejected')

	// Due listing + owner isolation.
	const stalePending = insertInput(ownerA, {
		fingerprint: 'fp-stale',
		deliveryId: 'email-inbound-delivery:stale',
		messageId: 'email-inbound-message:stale',
		threadId: 'email-inbound-thread:stale',
	})
	await mailboxA.insertChargedPendingInboundDelivery({
		ownerId: ownerA,
		delivery: stalePending,
		now: '2026-07-19T00:00:00.000Z',
	})
	const dueStale = await mailboxA.listDueStaleInboundDeliveries({
		ownerId: ownerA,
		now: '2026-07-22T00:00:00.000Z',
		limit: 50,
	})
	expect(
		dueStale.deliveries.some((d) => d.deliveryId === stalePending.deliveryId),
	).toBe(true)

	const foreign = insertInput(ownerB, {
		fingerprint: 'fp-b',
		deliveryId: 'email-inbound-delivery:owner-b',
		messageId: 'email-inbound-message:owner-b',
		threadId: 'email-inbound-thread:owner-b',
	})
	await mailboxB.insertChargedPendingInboundDelivery({
		ownerId: ownerB,
		delivery: foreign,
		now,
	})
	expect(
		await mailboxA.getInboundDelivery({
			ownerId: ownerA,
			deliveryId: foreign.deliveryId,
		}),
	).toBeNull()
	await runInDurableObject(stubFor(ownerA), async (instance: Mailbox) => {
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.insertChargedPendingInboundDelivery({
				ownerId: ownerB,
				delivery: foreign,
				now,
			}),
		)
	})

	// Dedupe prune.
	await runInDurableObject(stubFor(ownerA), async (_instance, state) => {
		state.storage.sql.exec(
			`UPDATE email_delivery_events
			SET dedupe_expires_at = ?, updated_at = ?
			WHERE provider = ?`,
			'2026-07-21T00:00:00.000Z',
			now,
			mailboxInboundDedupeProvider,
		)
	})
	const pruned = await mailboxA.pruneExpiredInboundDedupePointers({
		ownerId: ownerA,
		now: '2026-07-22T00:00:00.000Z',
		limit: 50,
	})
	expect(pruned.pruned).toBeGreaterThan(0)

	// Defer reconcile.
	const deferred = await mailboxA.deferInboundDeliveryReconciliation({
		ownerId: ownerA,
		deliveryId: stalePending.deliveryId,
		now,
	})
	expect(deferred.status).toBe('deferred')

	// Mirror upsert compatibility still works alongside ledger rows.
	const mirror = await mailboxA.upsertDeliveryEvent({
		ownerId: ownerA,
		event: {
			id: 'mirror-compat-event',
			messageId: null,
			inboxId: null,
			eventType: 'failed',
			provider: 'kody',
			providerMessageId: null,
			providerEventId: 'mirror-compat-event',
			detailJson: '{}',
			needsEffectReconcile: false,
			state: null,
			fingerprint: null,
			storageLease: null,
			storageLeaseAt: null,
			cleanupLease: null,
			cleanupLeaseAt: null,
			cleanupRetryAt: null,
			expectedAttachmentCount: null,
			finalizationToken: null,
			reconcileAfter: null,
			dedupeExpiresAt: null,
			usageEffectRecordedAt: null,
			usageEffectSuppressedAt: null,
			usageStartedAt: null,
			usageMonth: null,
			usageBytes: null,
			usageDurationMs: null,
			usageEffectRetryAt: null,
			usageEffectLease: null,
			usageEffectLeaseAt: null,
			subscriptionEffectState: null,
			subscriptionEffectLease: null,
			subscriptionEffectLeaseAt: null,
			subscriptionEffectRetryAt: null,
			subscriptionEffectAttemptCount: null,
			subscriptionEffectDeadLetterAt: null,
			subscriptionEffectLastError: null,
			createdAt: now,
			updatedAt: now,
		},
	})
	expect(mirror.accepted).toBe(true)

	// Export / purge / retention coexistence.
	const exported = await mailboxA.exportMailbox({ pageSize: 50 })
	expect(
		exported.rows.some(
			(row) =>
				row.kind === 'delivery_event' &&
				row.row.provider === mailboxInboundProvider,
		),
	).toBe(true)
	await mailboxA.purge()
	expect(
		await mailboxA.getInboundDelivery({
			ownerId: ownerA,
			deliveryId: delivery.deliveryId,
		}),
	).toBeNull()
	// Re-init after purge still at schema v2.
	await runInDurableObject(stubFor(ownerA), async (_instance, state) => {
		const version = state.storage.sql
			.exec<{ value: number }>(
				`SELECT value FROM mailbox_meta WHERE key = ?`,
				mailboxMetaSchemaVersionKey,
			)
			.toArray()[0]?.value
		expect(Number(version)).toBe(mailboxSchemaVersion)
	})
})

test('Mailbox inbound ledger warm-migrates v1 schema indexes to v2', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('warm-v2')
	const stub = stubFor(ownerId)
	await runInDurableObject(stub, async (instance: Mailbox, state) => {
		expect(instance).toBeInstanceOf(Mailbox)
		// Simulate a warm v1 object that somehow lacks v2 indexes.
		state.storage.sql.exec(
			`UPDATE mailbox_meta SET value = 1 WHERE key = ?`,
			mailboxMetaSchemaVersionKey,
		)
		state.storage.sql.exec(
			`DROP INDEX IF EXISTS idx_email_delivery_events_reconcile_after`,
		)
		state.storage.sql.exec(
			`DROP INDEX IF EXISTS idx_email_delivery_events_usage_effect_retry`,
		)
		state.storage.sql.exec(
			`DROP INDEX IF EXISTS idx_email_delivery_events_subscription_effect_retry`,
		)
		state.storage.sql.exec(
			`DROP INDEX IF EXISTS idx_email_delivery_events_stale_state`,
		)
		state.storage.sql.exec(
			`DROP INDEX IF EXISTS idx_email_delivery_events_dedupe_provider_expires`,
		)
		// Re-run schema init (same path as constructor / purge).
		initializeMailboxSchema(state.storage)
		const version = state.storage.sql
			.exec<{ value: number }>(
				`SELECT value FROM mailbox_meta WHERE key = ?`,
				mailboxMetaSchemaVersionKey,
			)
			.toArray()[0]?.value
		expect(Number(version)).toBe(mailboxSchemaVersion)
		const schemaV2Indexes = [
			'idx_email_delivery_events_reconcile_after',
			'idx_email_delivery_events_usage_effect_retry',
			'idx_email_delivery_events_subscription_effect_retry',
			'idx_email_delivery_events_stale_state',
			'idx_email_delivery_events_dedupe_provider_expires',
		] as const
		const indexes = state.storage.sql
			.exec<{ name: string }>(
				`SELECT name FROM sqlite_master
				WHERE type = 'index'
					AND name IN (
						'idx_email_delivery_events_reconcile_after',
						'idx_email_delivery_events_usage_effect_retry',
						'idx_email_delivery_events_subscription_effect_retry',
						'idx_email_delivery_events_stale_state',
						'idx_email_delivery_events_dedupe_provider_expires'
					)
				ORDER BY name ASC`,
			)
			.toArray()
			.map((row) => row.name)
		expect(indexes).toEqual([...schemaV2Indexes].sort())
		for (const name of schemaV2Indexes) {
			expect(indexes.filter((entry) => entry === name)).toHaveLength(1)
		}
	})
})

test('inbound ledger rejects non-finite expectedAttachmentCount, usageDurationMs, and usageBytes', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('non-finite')
	const mailbox = rpcFor(ownerId)
	const now = '2026-07-22T00:00:00.000Z'
	const delivery = insertInput(ownerId, {
		fingerprint: 'fp-non-finite',
		deliveryId: 'email-inbound-delivery:non-finite',
		messageId: 'email-inbound-message:non-finite',
		threadId: 'email-inbound-thread:non-finite',
	})
	await mailbox.insertChargedPendingInboundDelivery({
		ownerId,
		delivery,
		now,
	})

	await runInDurableObject(stubFor(ownerId), async (instance: Mailbox) => {
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			await assertMailboxThrows(
				/expectedAttachmentCount must be a non-negative finite number/,
				() =>
					instance.claimInboundDeliveryStorage({
						ownerId,
						deliveryId: delivery.deliveryId,
						expectedAttachmentCount: value,
						now,
					}),
			)
		}
	})

	const claim = await mailbox.claimInboundDeliveryStorage({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 0,
		now,
	})
	expect(claim.status).toBe('claimed')
	if (claim.status !== 'claimed') throw new Error('expected claim')
	const storageLease = claim.delivery.storageLease!

	await runInDurableObject(stubFor(ownerId), async (instance: Mailbox) => {
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			await assertMailboxThrows(
				/usageDurationMs must be a non-negative finite number/,
				() =>
					instance.markInboundDeliveryReceived({
						ownerId,
						deliveryId: delivery.deliveryId,
						storageLease,
						usageDurationMs: value,
						usageMonth: '2026-07',
						usageBytes: 8,
						now,
					}),
			)
			await assertMailboxThrows(
				/usageBytes must be a non-negative finite number/,
				() =>
					instance.markInboundDeliveryReceived({
						ownerId,
						deliveryId: delivery.deliveryId,
						storageLease,
						usageDurationMs: 5,
						usageMonth: '2026-07',
						usageBytes: value,
						now,
					}),
			)
		}
	})
})
