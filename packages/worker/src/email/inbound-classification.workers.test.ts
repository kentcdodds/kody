import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { resolveInboundEmailClassification } from './inbound-classification.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('classification requires the sender-rules schema', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(`DROP TABLE email_sender_rules`).run()

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId: 'classification-user',
			envelopeFrom: 'sender@example.test',
			authResults: 'dmarc=fail',
		}),
	).rejects.toThrow('no such table: email_sender_rules')
})
