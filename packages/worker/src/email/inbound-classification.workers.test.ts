import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { resolveInboundEmailClassification } from './inbound-classification.ts'
import { upsertEmailSenderRule } from './sender-rules.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const dmarcFail =
	'mx.example.com; dmarc=fail (p=reject) header.from=example.net; spf=fail smtp.mailfrom=example.net; dkim=fail header.d=example.net'
const dmarcPass = 'mx.example.com; spf=pass; dkim=pass; dmarc=pass'

test('classification requires the sender-rules schema', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(`DROP TABLE email_sender_rules`).run()

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId: ownerIdFromStored('classification-user'),
			envelopeFrom: 'sender@example.test',
			authResults: 'dmarc=fail',
		}),
	).rejects.toThrow('no such table: email_sender_rules')
})

test('spoofed sender matching an allow address rule is quarantined', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-spoof-addr-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'friend@example.net',
		effect: 'allow',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			envelopeFrom: 'friend@example.net',
			authResults: dmarcFail,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: 'Sender failed DMARC authentication.',
	})
})

test('spoofed sender matching an allow domain rule is quarantined', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-spoof-dom-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'domain',
		value: 'trusted.example',
		effect: 'allow',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			envelopeFrom: 'news@trusted.example',
			authResults: dmarcFail,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: 'Sender failed DMARC authentication.',
	})
})

test('authenticated sender matching an allow rule is accepted', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-auth-allow-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'friend@example.net',
		effect: 'allow',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			envelopeFrom: 'friend@example.net',
			authResults: dmarcPass,
		}),
	).resolves.toEqual({
		classification: 'accepted',
		classificationReason: null,
	})
})

test('block rule quarantines authenticated mail', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-block-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'blocked@spam.example',
		effect: 'block',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			envelopeFrom: 'blocked@spam.example',
			authResults: dmarcPass,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: 'Sender matched block rule blocked@spam.example.',
	})
})
