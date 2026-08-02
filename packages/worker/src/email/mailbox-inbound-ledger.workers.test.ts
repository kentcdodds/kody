import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import { Mailbox } from './mailbox-do.ts'
import {
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
	mailboxInboundStorageLeaseMs,
	type MailboxInboundDeliveryInsertInput,
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

function insertInput(
	ownerId: string,
	overrides?: Partial<MailboxInboundDeliveryInsertInput>,
): MailboxInboundDeliveryInsertInput {
	const deliveryId =
		overrides?.deliveryId ?? `email-inbound-delivery:${crypto.randomUUID()}`
	const messageId =
		overrides?.messageId ?? `email-inbound-message:${crypto.randomUUID()}`
	const fingerprint =
		overrides?.fingerprint ?? crypto.randomUUID().replace(/-/g, '')
	return {
		fingerprint,
		deliveryId,
		messageId,
		threadId:
			overrides?.threadId ?? `email-inbound-thread:${crypto.randomUUID()}`,
		rawMimeKey: emailRawMimeKey(ownerId, messageId),
		inboxId: overrides?.inboxId ?? `inbox-${crypto.randomUUID()}`,
		recipient: overrides?.recipient ?? 'owner@example.com',
		envelopeFrom: overrides?.envelopeFrom ?? 'sender@example.com',
		quotaDay: overrides?.quotaDay ?? '2026-07-22',
		dedupeExpiresAt: overrides?.dedupeExpiresAt ?? '2026-07-24T00:00:00.000Z',
		usageStartedAt: overrides?.usageStartedAt,
		provider: overrides?.provider,
	}
}

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
			const indexes = state.storage.sql
				.exec<{ name: string }>(
					`SELECT name FROM sqlite_master
				WHERE type = 'index'
					AND name IN (
						'idx_email_delivery_events_reconcile_after',
						'idx_email_delivery_events_usage_effect_retry',
						'idx_email_delivery_events_subscription_effect_retry',
						'idx_email_delivery_events_stale_state',
						'idx_email_delivery_events_dedupe_provider_expires',
						'idx_email_delivery_events_state_created',
						'idx_email_delivery_events_dedupe_expires'
					)
				ORDER BY name ASC`,
				)
				.toArray()
				.map((row) => row.name)
			expect(indexes).toContain('idx_email_delivery_events_reconcile_after')
			expect(indexes).toContain('idx_email_delivery_events_usage_effect_retry')
			expect(indexes).toContain(
				'idx_email_delivery_events_subscription_effect_retry',
			)
			expect(indexes).toContain('idx_email_delivery_events_stale_state')
			expect(indexes).toContain(
				'idx_email_delivery_events_dedupe_provider_expires',
			)
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

	// Usage + subscription effect exactly-once leases / retry / dead-letter.
	const usageClaim = await mailboxA.claimInboundUsageEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: received.delivery.finalizationToken,
		now: takeoverNow,
	})
	expect(usageClaim.status).toBe('claimed')
	if (usageClaim.status !== 'claimed') throw new Error('expected usage claim')
	const usageBusy = await mailboxA.claimInboundUsageEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		now: takeoverNow,
	})
	expect(usageBusy.status).toBe('not-claimable')
	const usageDone = await mailboxA.completeInboundUsageEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		usageEffectLease: usageClaim.delivery.usageEffectLease!,
		mode: 'recorded',
		usageMonth: '2026-07',
		usageBytes: 64,
		usageDurationMs: 25,
		now: takeoverNow,
	})
	expect(usageDone.status).toBe('recorded')
	const usageReplay = await mailboxA.claimInboundUsageEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		now: takeoverNow,
	})
	expect(usageReplay.status).toBe('already-complete')

	const subClaim = await mailboxA.claimInboundSubscriptionEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: received.delivery.finalizationToken,
		now: takeoverNow,
	})
	expect(subClaim.status).toBe('claimed')
	if (subClaim.status !== 'claimed') throw new Error('expected sub claim')
	const fail1 = await mailboxA.failInboundSubscriptionEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		subscriptionEffectLease: subClaim.delivery.subscriptionEffectLease!,
		error: 'transient-1',
		now: takeoverNow,
	})
	expect(fail1.status).toBe('retry')

	const retryAt =
		fail1.status === 'retry'
			? fail1.delivery.subscriptionEffectRetryAt!
			: takeoverNow
	const subClaim2 = await mailboxA.claimInboundSubscriptionEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		now: retryAt,
	})
	expect(subClaim2.status).toBe('claimed')
	if (subClaim2.status !== 'claimed') throw new Error('expected sub claim 2')
	const fail2 = await mailboxA.failInboundSubscriptionEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		subscriptionEffectLease: subClaim2.delivery.subscriptionEffectLease!,
		error: 'transient-2',
		now: retryAt,
	})
	expect(fail2.status).toBe('retry')
	const retryAt2 =
		fail2.status === 'retry'
			? fail2.delivery.subscriptionEffectRetryAt!
			: retryAt
	const subClaim3 = await mailboxA.claimInboundSubscriptionEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		now: retryAt2,
	})
	expect(subClaim3.status).toBe('claimed')
	if (subClaim3.status !== 'claimed') throw new Error('expected sub claim 3')
	const dead = await mailboxA.failInboundSubscriptionEffect({
		ownerId: ownerA,
		deliveryId: delivery.deliveryId,
		subscriptionEffectLease: subClaim3.delivery.subscriptionEffectLease!,
		error: 'final',
		now: retryAt2,
	})
	expect(dead.status).toBe('dead-letter')

	// Suppression path on a fresh received delivery.
	const suppressDelivery = insertInput(ownerA, {
		fingerprint: 'fp-suppress',
		deliveryId: 'email-inbound-delivery:suppress',
		messageId: 'email-inbound-message:suppress',
		threadId: 'email-inbound-thread:suppress',
	})
	await mailboxA.insertChargedPendingInboundDelivery({
		ownerId: ownerA,
		delivery: suppressDelivery,
		now,
	})
	const suppressClaim = await mailboxA.claimInboundDeliveryStorage({
		ownerId: ownerA,
		deliveryId: suppressDelivery.deliveryId,
		expectedAttachmentCount: 0,
		now,
	})
	expect(suppressClaim.status).toBe('claimed')
	if (suppressClaim.status !== 'claimed') throw new Error('expected claim')
	const suppressReceived = await mailboxA.markInboundDeliveryReceived({
		ownerId: ownerA,
		deliveryId: suppressDelivery.deliveryId,
		storageLease: suppressClaim.delivery.storageLease!,
		usageDurationMs: 1,
		usageMonth: '2026-07',
		usageBytes: 1,
		now,
	})
	expect(suppressReceived.status).toBe('received')
	const usageSuppressClaim = await mailboxA.claimInboundUsageEffect({
		ownerId: ownerA,
		deliveryId: suppressDelivery.deliveryId,
		now,
	})
	expect(usageSuppressClaim.status).toBe('claimed')
	if (usageSuppressClaim.status !== 'claimed') {
		throw new Error('expected usage suppress claim')
	}
	expect(
		(
			await mailboxA.completeInboundUsageEffect({
				ownerId: ownerA,
				deliveryId: suppressDelivery.deliveryId,
				usageEffectLease: usageSuppressClaim.delivery.usageEffectLease!,
				mode: 'suppressed',
				usageMonth: '2026-07',
				usageBytes: 1,
				usageDurationMs: 1,
				now,
			})
		).status,
	).toBe('suppressed')
	const subSuppressClaim = await mailboxA.claimInboundSubscriptionEffect({
		ownerId: ownerA,
		deliveryId: suppressDelivery.deliveryId,
		now,
	})
	expect(subSuppressClaim.status).toBe('claimed')
	if (subSuppressClaim.status !== 'claimed') {
		throw new Error('expected sub suppress claim')
	}
	expect(
		(
			await mailboxA.completeInboundSubscriptionEffect({
				ownerId: ownerA,
				deliveryId: suppressDelivery.deliveryId,
				subscriptionEffectLease:
					subSuppressClaim.delivery.subscriptionEffectLease!,
				mode: 'suppressed',
				suppressionReason: 'quarantine',
				now,
			})
		).status,
	).toBe('suppressed')

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
		const hasReconcile = state.storage.sql
			.exec<{ name: string }>(
				`SELECT name FROM sqlite_master
				WHERE type = 'index'
					AND name = 'idx_email_delivery_events_reconcile_after'`,
			)
			.toArray()
		expect(hasReconcile.length).toBe(1)
	})
})
