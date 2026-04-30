import { expect, test } from 'vitest'
import { evaluateSenderPolicy } from './policy.ts'
import { type EmailSenderPolicyRecord } from './types.ts'

function policy(
	input: Partial<EmailSenderPolicyRecord> &
		Pick<EmailSenderPolicyRecord, 'kind' | 'value'>,
): EmailSenderPolicyRecord {
	return {
		id: input.id ?? `${input.kind}-${input.value}`,
		userId: 'user-1',
		inboxId: input.inboxId ?? null,
		packageId: input.packageId ?? null,
		kind: input.kind,
		value: input.value,
		effect: input.effect ?? 'allow',
		enabled: input.enabled ?? true,
		createdAt: '2026-04-30T00:00:00.000Z',
		updatedAt: '2026-04-30T00:00:00.000Z',
	}
}

test('sender policy accepts exact senders, domains, and reply tokens before default quarantine', async () => {
	const replyToken = 'reply-token-123'
	const exact = await evaluateSenderPolicy({
		fromAddress: 'Alice@Example.com',
		envelopeFrom: 'bounce@mailer.test',
		rules: [policy({ kind: 'sender', value: 'alice@example.com' })],
	})
	expect(exact).toMatchObject({
		decision: 'accepted',
		policyKind: 'sender',
	})

	const domain = await evaluateSenderPolicy({
		fromAddress: 'sender@trusted.example',
		envelopeFrom: null,
		rules: [policy({ kind: 'domain', value: 'trusted.example' })],
	})
	expect(domain).toMatchObject({
		decision: 'accepted',
		policyKind: 'domain',
	})

	const token = await evaluateSenderPolicy({
		fromAddress: 'unknown@example.com',
		envelopeFrom: null,
		replyToken,
		rules: [
			policy({ kind: 'sender', value: 'somebody@example.com' }),
			policy({ kind: 'reply_token', value: replyToken }),
		],
	})
	expect(token).toMatchObject({
		decision: 'accepted',
		policyKind: 'reply_token',
	})

	const quarantined = await evaluateSenderPolicy({
		fromAddress: 'unknown@example.com',
		envelopeFrom: null,
		rules: [policy({ kind: 'sender', value: 'somebody@example.com' })],
	})
	expect(quarantined).toMatchObject({
		decision: 'quarantined',
		ruleId: null,
	})
})
