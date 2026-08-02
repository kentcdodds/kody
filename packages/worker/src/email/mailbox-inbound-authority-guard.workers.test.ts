import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { emailRawMimeKey } from './blob-keys.ts'
import { insertInput } from './mailbox-inbound-ledger-test-helpers.ts'
import { mailboxUpsertDeliveryEventsMax } from './mailbox-types.ts'
import {
	assertMailboxThrows,
	baseDeliveryEvent,
	rpcFor,
	stubFor,
	uniqueUserId,
} from './mailbox-test-helpers.ts'

function preClaimAuditEvent(input: {
	inboxId: string
	day: string
	count?: number
}) {
	const at = `${input.day}T12:00:00.000Z`
	return baseDeliveryEvent({
		id: `email-rejections:${input.inboxId}:${input.day}`,
		inboxId: input.inboxId,
		eventType: 'rejected',
		provider: 'cloudflare-email-routing',
		detailJson: JSON.stringify({
			aggregate: true,
			day: input.day,
			count: input.count ?? 1,
			last_reason: 'Recipient mailbox is over quota.',
			last_phase: 'entitlement',
			last_at: at,
		}),
		createdAt: at,
		updatedAt: at,
	})
}

function legacyPendingEvent(ownerId: string, deliveryId: string) {
	const messageId = `email-inbound-message:${deliveryId}`
	const fingerprint = `fingerprint-${deliveryId}`
	const detail = {
		fingerprint,
		deliveryId,
		messageId,
		threadId: `email-inbound-thread:${deliveryId}`,
		rawMimeKey: emailRawMimeKey(ownerId, messageId),
		userId: ownerId,
		inboxId: 'inbox-legacy',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		provider: 'cloudflare-email-routing',
		quotaDay: '2026-08-02',
		dedupeExpiresAt: '2026-08-04T12:00:00.000Z',
		state: 'pending' as const,
	}
	return baseDeliveryEvent({
		id: deliveryId,
		inboxId: detail.inboxId,
		eventType: 'receive_started',
		provider: 'cloudflare-email-routing',
		providerEventId: deliveryId,
		detailJson: JSON.stringify(detail),
		state: 'pending',
		fingerprint,
		dedupeExpiresAt: detail.dedupeExpiresAt,
		createdAt: '2026-08-02T12:00:00.000Z',
		updatedAt: '2026-08-02T12:00:00.000Z',
	})
}

test('D1 mirror accepts only non-authoritative bounded inbound rejection audits', async () => {
	const ownerId = uniqueUserId('audit-guard')
	const mailbox = rpcFor(ownerId)
	const audit = preClaimAuditEvent({
		inboxId: 'inbox-audit',
		day: '2026-08-02',
	})

	await expect(
		mailbox.upsertDeliveryEvent({ ownerId, event: audit }),
	).resolves.toEqual({
		inserted: true,
		accepted: true,
		updatedLatestStatus: false,
	})
	await expect(
		mailbox.upsertDeliveryEvents({
			ownerId,
			events: [
				{
					...audit,
					detailJson: preClaimAuditEvent({
						inboxId: 'inbox-audit',
						day: '2026-08-02',
						count: 2,
					}).detailJson,
				},
			],
		}),
	).resolves.toEqual({
		results: [{ eventId: audit.id, inserted: false, accepted: true }],
	})

	await runInDurableObject(stubFor(ownerId), async (instance) => {
		await assertMailboxThrows(/missing-row bootstrap RPC/, () =>
			instance.upsertDeliveryEvents({
				ownerId,
				events: [
					{
						...audit,
						state: 'pending',
						fingerprint: 'smuggled-authority-state',
					},
				],
			}),
		)
		await assertMailboxThrows(/missing-row bootstrap RPC/, () =>
			instance.upsertDeliveryEvents({
				ownerId,
				events: [
					baseDeliveryEvent({
						id: 'email-inbound-delivery:lifecycle',
						provider: 'cloudflare-email-routing',
						eventType: 'receive_started',
						state: 'pending',
						fingerprint: 'lifecycle-fingerprint',
					}),
				],
			}),
		)
		await assertMailboxThrows(/missing-row bootstrap RPC/, () =>
			instance.upsertDeliveryEvents({
				ownerId,
				events: [
					baseDeliveryEvent({
						id: 'email-inbound-dedupe:lifecycle',
						provider: 'cloudflare-email-routing-dedupe',
						eventType: 'receive_started',
						state: 'pending',
						fingerprint: 'lifecycle-fingerprint',
					}),
				],
			}),
		)
	})
})

test('audit-shaped D1 snapshots cannot overwrite authoritative Mailbox rows', async () => {
	const ownerId = uniqueUserId('audit-collision')
	const mailbox = rpcFor(ownerId)
	const audit = preClaimAuditEvent({
		inboxId: 'inbox-collision',
		day: '2026-08-02',
	})
	const authoritative = insertInput(ownerId, {
		deliveryId: audit.id,
		inboxId: 'inbox-collision',
		fingerprint: 'authoritative-fingerprint',
	})
	await mailbox.insertChargedPendingInboundDelivery({
		ownerId,
		delivery: authoritative,
		now: '2026-08-02T11:00:00.000Z',
	})

	await expect(
		mailbox.upsertDeliveryEvents({ ownerId, events: [audit] }),
	).resolves.toEqual({
		results: [{ eventId: audit.id, inserted: false, accepted: false }],
	})
	await expect(
		mailbox.getInboundDelivery({
			ownerId,
			deliveryId: audit.id,
		}),
	).resolves.toMatchObject({
		state: 'pending',
		fingerprint: 'authoritative-fingerprint',
	})
})

test('bootstrapDeliveryEvents is owner-bound, validated, bounded, transactional, and missing-only', async () => {
	const ownerId = uniqueUserId('bootstrap-rpc')
	const otherOwnerId = uniqueUserId('bootstrap-rpc-other')
	const mailbox = rpcFor(ownerId)
	const deliveryId = 'email-inbound-delivery:legacy-rpc'
	const pending = legacyPendingEvent(ownerId, deliveryId)

	await expect(
		mailbox.bootstrapDeliveryEvents({ ownerId, events: [pending] }),
	).resolves.toEqual({
		inserted: 1,
		existing: 0,
		skipped: 0,
		results: [{ eventId: deliveryId, status: 'inserted' }],
	})
	await mailbox.claimInboundDeliveryStorage({
		ownerId,
		deliveryId,
		expectedAttachmentCount: 3,
		now: '2026-08-02T13:00:00.000Z',
	})
	const newer = await mailbox.getInboundDelivery({ ownerId, deliveryId })
	expect(newer).toMatchObject({ state: 'storing', expectedAttachmentCount: 3 })

	await expect(
		mailbox.bootstrapDeliveryEvents({ ownerId, events: [pending] }),
	).resolves.toMatchObject({ inserted: 0, existing: 1, skipped: 0 })
	expect(
		await mailbox.getInboundDelivery({ ownerId, deliveryId }),
	).toMatchObject({
		state: 'storing',
		expectedAttachmentCount: 3,
		updatedAt: newer?.updatedAt,
	})
	const skippedId = 'email-inbound-delivery:provider-id-conflict'
	await mailbox.upsertDeliveryEvent({
		ownerId,
		event: baseDeliveryEvent({
			id: 'provider-id-conflict-holder',
			provider: 'kody',
			providerEventId: skippedId,
		}),
	})
	await expect(
		mailbox.bootstrapDeliveryEvents({
			ownerId,
			events: [legacyPendingEvent(ownerId, skippedId)],
		}),
	).resolves.toEqual({
		inserted: 0,
		existing: 0,
		skipped: 1,
		results: [{ eventId: skippedId, status: 'skipped' }],
	})
	const malformedId = 'email-inbound-delivery:malformed-schedule'
	const malformed = legacyPendingEvent(ownerId, malformedId)
	await expect(
		mailbox.bootstrapDeliveryEvents({
			ownerId,
			events: [
				{
					...malformed,
					reconcileAfter: 'not-a-timestamp',
					detailJson: JSON.stringify({
						...JSON.parse(malformed.detailJson),
						reconcileAfter: 'not-a-timestamp',
					}),
				},
			],
		}),
	).resolves.toEqual({
		inserted: 0,
		existing: 0,
		skipped: 1,
		results: [{ eventId: malformedId, status: 'skipped' }],
	})

	await runInDurableObject(stubFor(ownerId), async (instance) => {
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.bootstrapDeliveryEvents({
				ownerId: otherOwnerId,
				events: [
					legacyPendingEvent(otherOwnerId, 'email-inbound-delivery:other'),
				],
			}),
		)
		await assertMailboxThrows(
			/requires an inbound lifecycle or dedupe snapshot/,
			() =>
				instance.bootstrapDeliveryEvents({
					ownerId,
					events: [baseDeliveryEvent({ id: 'not-inbound', provider: 'kody' })],
				}),
		)
		await assertMailboxThrows(/valid owner-bound complete snapshot/, () =>
			instance.bootstrapDeliveryEvents({
				ownerId,
				events: [
					legacyPendingEvent(ownerId, 'email-inbound-delivery:txn-valid'),
					{
						...legacyPendingEvent(
							ownerId,
							'email-inbound-delivery:txn-invalid',
						),
						state: 'storing',
					},
				],
			}),
		)
		await assertMailboxThrows(/exceed max of 100/, () =>
			instance.bootstrapDeliveryEvents({
				ownerId,
				events: Array.from(
					{ length: mailboxUpsertDeliveryEventsMax + 1 },
					(_, index) =>
						legacyPendingEvent(
							ownerId,
							`email-inbound-delivery:overflow-${index}`,
						),
				),
			}),
		)
	})
	expect(
		await mailbox.getInboundDelivery({
			ownerId,
			deliveryId: 'email-inbound-delivery:txn-valid',
		}),
	).toBeNull()
})
