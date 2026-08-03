import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { resolveInboundEmailClassification } from './inbound-classification.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('classification falls through to the auth verdict when sender rules are not deployed', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(`DROP TABLE email_sender_rules`).run()

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId: 'classification-user',
			envelopeFrom: 'sender@example.test',
			authResults: 'dmarc=fail',
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: 'Sender failed DMARC authentication.',
	})
})

test('classification propagates sender-rule database failures other than a missing table', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.batch([
		env.APP_DB.prepare(`DROP TABLE email_sender_rules`),
		env.APP_DB.prepare(`CREATE TABLE email_sender_rules (id TEXT PRIMARY KEY)`),
	])

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId: 'classification-user',
			envelopeFrom: 'sender@example.test',
			authResults: null,
		}),
	).rejects.toThrow('no such column: user_id')
})
