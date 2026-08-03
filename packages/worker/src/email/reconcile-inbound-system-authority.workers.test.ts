import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { sweepStaleInboundDeliveries } from './reconcile-inbound-deliveries.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('an invalid system marker does not prevent ordinary user reconciliation', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, event_type, provider, detail_json, created_at,
			needs_effect_reconcile, state, fingerprint, updated_at
		) VALUES (
			'user-due-without-system-marker', 'ordinary-user', 'receive_started',
			'cloudflare-email-routing',
			'{"state":"pending","userId":"ordinary-user"}',
			'2026-07-31T00:00:00.000Z', 0, 'pending', 'ordinary-fingerprint',
			'2026-07-31T00:00:00.000Z'
		)`,
	).run()
	await env.APP_DB.prepare(
		`DELETE FROM system_email_graph_authority WHERE singleton = 1`,
	).run()

	try {
		const result = await sweepStaleInboundDeliveries({
			env: {
				...env,
				APP_BASE_URL: 'https://kody.example.com',
			},
			now: new Date('2026-08-03T00:00:00.000Z'),
		})
		expect(result.usersProcessed).toBe(1)
		expect(consoleWarn).toHaveBeenCalledWith(
			'inbound-email-user-reconciliation-failed',
			'ordinary-user',
			expect.any(Error),
		)
	} finally {
		await env.APP_DB.prepare(
			`INSERT OR IGNORE INTO system_email_graph_authority (
				singleton, authority, cutover_at, graph_mismatch_count,
				provider_link_count
			) VALUES (1, 'dedicated', CURRENT_TIMESTAMP, 0, 0)`,
		).run()
	}
})
