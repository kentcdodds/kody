import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import { rpcFor } from './mailbox-test-helpers.ts'
import { sweepStaleInboundDeliveries } from './reconcile-inbound-deliveries.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const appBaseUrl = 'https://kody.example.com'
const sweepNow = new Date('2026-08-03T00:00:00.000Z')

async function seedStaleUserDelivery(label: string, createdAt: string) {
	const email = `${label}-${crypto.randomUUID()}@example.test`
	const userId = await createStableUserIdFromEmail(email)
	const inboxId = `${label}-inbox-${crypto.randomUUID()}`
	const deliveryId = `${label}-delivery-${crypto.randomUUID()}`
	const messageId = `${label}-message-${crypto.randomUUID()}`
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, deleting_at
			) VALUES (?, ?, 'hash', ?, NULL)`,
		).bind(`${label}-${crypto.randomUUID()}`, email, userId),
		env.APP_DB.prepare(
			`INSERT INTO email_inboxes (
				id, user_id, name, description, enabled, created_at, updated_at
			) VALUES (?, ?, 'Reconcile fixture', '', 1, ?, ?)`,
		).bind(inboxId, userId, createdAt, createdAt),
	])
	await rpcFor(userId).insertChargedPendingInboundDelivery({
		ownerId: userId,
		delivery: {
			fingerprint: `${label}-fingerprint-${crypto.randomUUID()}`,
			deliveryId,
			messageId,
			threadId: `${label}-thread-${crypto.randomUUID()}`,
			rawMimeKey: emailRawMimeKey(userId, messageId),
			inboxId,
			recipient: email,
			envelopeFrom: 'sender@example.test',
			provider: 'cloudflare-email-routing',
			quotaDay: createdAt.slice(0, 10),
			dedupeExpiresAt: '2026-08-04T00:00:00.000Z',
		},
		now: createdAt,
	})
	const authority = createUserInboundDeliveryAuthority({
		env: { ...env, APP_BASE_URL: appBaseUrl },
		userId,
	})
	expect(await authority.get(deliveryId)).toMatchObject({
		deliveryId,
		state: 'pending',
	})
	return { userId, deliveryId }
}

async function restoreSystemMarker() {
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO system_email_graph_authority (
			singleton, authority, cutover_at, graph_mismatch_count,
			provider_link_count
		) VALUES (1, 'dedicated', CURRENT_TIMESTAMP, 0, 0)`,
	).run()
}

test('ordinary user reconciliation succeeds without a system authority marker', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const fixture = await seedStaleUserDelivery(
		'user-only',
		'2026-07-31T00:00:00.000Z',
	)
	await env.APP_DB.prepare(
		`DELETE FROM system_email_graph_authority WHERE singleton = 1`,
	).run()

	try {
		const result = await sweepStaleInboundDeliveries({
			env: { ...env, APP_BASE_URL: appBaseUrl },
			now: sweepNow,
		})
		expect(result).toMatchObject({
			usersProcessed: 1,
			recovered: 0,
			cleaned: 1,
			pointersPruned: 0,
			effectsProcessed: 0,
			errors: 0,
		})
		expect(consoleWarn).not.toHaveBeenCalled()
		expect(
			await rpcFor(fixture.userId).getInboundDelivery({
				ownerId: fixture.userId,
				deliveryId: fixture.deliveryId,
			}),
		).toMatchObject({ state: 'orphan-cleaned' })
		expect(
			await env.APP_DB.prepare(
				`SELECT state FROM email_delivery_events
				WHERE id = ? AND user_id = ?`,
			)
				.bind(fixture.deliveryId, fixture.userId)
				.first(),
		).toEqual({ state: 'orphan-cleaned' })
	} finally {
		await restoreSystemMarker()
	}
})

test('system authority failure is isolated and does not block later user work', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const fixture = await seedStaleUserDelivery(
		'user-after-system',
		'2026-07-31T00:00:00.000Z',
	)
	const systemDeliveryId = `system-due-${crypto.randomUUID()}`
	await env.APP_DB.prepare(
		`INSERT INTO system_email_delivery_events (
			id, event_type, provider, detail_json, needs_effect_reconcile,
			state, fingerprint, created_at, updated_at
		) VALUES (
			?, 'receive_started', 'cloudflare-email-routing', '{}', 0,
			'pending', ?, '2026-07-30T00:00:00.000Z',
			'2026-07-30T00:00:00.000Z'
		)`,
	)
		.bind(systemDeliveryId, `system-fingerprint-${crypto.randomUUID()}`)
		.run()
	await env.APP_DB.prepare(
		`DELETE FROM system_email_graph_authority WHERE singleton = 1`,
	).run()

	try {
		const result = await sweepStaleInboundDeliveries({
			env: { ...env, APP_BASE_URL: appBaseUrl },
			now: sweepNow,
		})
		expect(result).toMatchObject({
			usersProcessed: 2,
			recovered: 0,
			cleaned: 1,
			pointersPruned: 0,
			effectsProcessed: 0,
			errors: 1,
		})
		expect(consoleWarn).toHaveBeenCalledTimes(1)
		expect(consoleWarn).toHaveBeenCalledWith(
			'inbound-email-user-reconciliation-failed',
			systemEmailOwnerId,
			expect.objectContaining({
				message: expect.stringContaining(
					'authority marker is missing or invalid',
				),
			}),
		)
		expect(
			await rpcFor(fixture.userId).getInboundDelivery({
				ownerId: fixture.userId,
				deliveryId: fixture.deliveryId,
			}),
		).toMatchObject({ state: 'orphan-cleaned' })
		expect(
			await env.APP_DB.prepare(
				`SELECT state FROM system_email_delivery_events WHERE id = ?`,
			)
				.bind(systemDeliveryId)
				.first(),
		).toEqual({ state: 'pending' })
	} finally {
		await restoreSystemMarker()
	}
})
