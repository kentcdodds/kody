import { expect, test } from 'vitest'
import { insertInput } from './mailbox-inbound-ledger-test-helpers.ts'
import {
	baseDeliveryEvent,
	rpcFor,
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
}, 30_000)

test('generic upserts reject inbound authority state and allow pre-claim audits', async () => {
	const ownerId = uniqueUserId('generic-authority-guard')
	const mailbox = rpcFor(ownerId)
	const authorityEvent = baseDeliveryEvent({
		id: 'email-inbound-delivery:generic-authority-guard',
		eventType: 'receive_started',
		provider: 'cloudflare-email-routing',
		state: 'pending',
		fingerprint: 'generic-authority-fingerprint',
	})
	const dedupeEvent = baseDeliveryEvent({
		id: 'email-inbound-dedupe:generic-authority-guard',
		eventType: 'receive_started',
		provider: 'cloudflare-email-routing-dedupe',
		fingerprint: 'generic-dedupe-fingerprint',
		dedupeExpiresAt: '2026-08-05T00:00:00.000Z',
	})
	const audit = preClaimAuditEvent({
		inboxId: 'inbox-generic-authority-guard',
		day: '2026-08-03',
	})

	await expect(
		mailbox.upsertDeliveryEvents({
			ownerId,
			events: [authorityEvent, dedupeEvent, audit],
		}),
	).resolves.toEqual({
		results: [
			{
				eventId: authorityEvent.id,
				inserted: false,
				accepted: false,
			},
			{
				eventId: dedupeEvent.id,
				inserted: false,
				accepted: false,
			},
			{ eventId: audit.id, inserted: true, accepted: true },
		],
	})
	await expect(
		mailbox.getInboundDelivery({
			ownerId,
			deliveryId: authorityEvent.id,
		}),
	).resolves.toBeNull()
})
