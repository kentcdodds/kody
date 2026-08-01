import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	getEmailDeliveryEventMirrorProjection,
	getMailboxDeliveryEventMirrorInput,
} from './mailbox-snapshot-repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

async function createEmailDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	return { sqlite, db }
}

test('mailbox-snapshot-repo loads complete delivery-event projection and ready Mailbox input', async () => {
	const { db } = await createEmailDb()
	const detail = {
		state: 'received',
		fingerprint: 'fp-repo',
		storageLease: 'lease-repo',
		subscriptionEffectState: 'pending',
		usageStartedAt: '2026-07-02T09:59:00.000Z',
		// Stale JSON copies of promoted columns must not win after conversion.
		usageEffectRecordedAt: '2026-01-01T00:00:00.000Z',
		usageMonth: 'json-month',
		usageBytes: 1,
		usageDurationMs: 1,
	}
	await db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, inbox_id, event_type, provider,
				provider_message_id, provider_event_id, detail_json,
				needs_effect_reconcile, usage_effect_recorded_at, usage_month,
				usage_bytes, usage_duration_ms, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			'evt-1',
			'msg-1',
			'user-aaa',
			'inbox-1',
			'received',
			'cloudflare-email-routing',
			null,
			'provider-evt-1',
			JSON.stringify(detail),
			1,
			'2026-07-02T10:01:00.000Z',
			'2026-07',
			2048,
			120,
			'2026-07-02T10:00:00.000Z',
		)
		.run()

	const projection = await getEmailDeliveryEventMirrorProjection({
		db,
		ownerId: 'user-aaa',
		eventId: 'evt-1',
	})
	expect(projection).toEqual({
		id: 'evt-1',
		messageId: 'msg-1',
		userId: 'user-aaa',
		inboxId: 'inbox-1',
		eventType: 'received',
		provider: 'cloudflare-email-routing',
		providerMessageId: null,
		providerEventId: 'provider-evt-1',
		detailJson: JSON.stringify(detail),
		createdAt: '2026-07-02T10:00:00.000Z',
		needsEffectReconcile: true,
		usageEffectRecordedAt: '2026-07-02T10:01:00.000Z',
		usageMonth: '2026-07',
		usageBytes: 2048,
		usageDurationMs: 120,
	})

	expect(
		await getEmailDeliveryEventMirrorProjection({
			db,
			ownerId: 'other-user',
			eventId: 'evt-1',
		}),
	).toBeNull()
	expect(
		await getEmailDeliveryEventMirrorProjection({
			db,
			ownerId: 'user-aaa',
			eventId: 'missing',
		}),
	).toBeNull()

	const mailboxInput = await getMailboxDeliveryEventMirrorInput({
		db,
		ownerId: 'user-aaa',
		eventId: 'evt-1',
		sourceMutationAt: '2026-07-02T10:00:00.000Z',
	})
	expect(mailboxInput).toEqual(
		expect.objectContaining({
			id: 'evt-1',
			needsEffectReconcile: true,
			state: 'received',
			fingerprint: 'fp-repo',
			storageLease: 'lease-repo',
			subscriptionEffectState: 'pending',
			usageEffectRecordedAt: '2026-07-02T10:01:00.000Z',
			usageMonth: '2026-07',
			usageBytes: 2048,
			usageDurationMs: 120,
			usageStartedAt: '2026-07-02T09:59:00.000Z',
			createdAt: '2026-07-02T10:00:00.000Z',
			updatedAt: '2026-07-02T10:00:00.000Z',
		}),
	)
})
