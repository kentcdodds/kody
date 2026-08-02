import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { insertInput } from './mailbox-inbound-ledger-test-helpers.ts'
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
		await assertMailboxThrows(/missing-row bootstrap intent/, () =>
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
		await assertMailboxThrows(/missing-row bootstrap intent/, () =>
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
		await assertMailboxThrows(/missing-row bootstrap intent/, () =>
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
