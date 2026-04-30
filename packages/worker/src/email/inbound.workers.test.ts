import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	getEmailDomain,
	getEmailLocalPart,
	requireNormalizedEmailAddress,
} from './address.ts'
import { handleInboundEmail } from './inbound.ts'
import {
	createEmailInbox,
	createEmailInboxAddress,
	createEmailThread,
	listEmailMessages,
	upsertEmailSenderPolicy,
} from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

function createForwardableEmailMessage(input: {
	from: string
	to: string
	raw: string
}): ForwardableEmailMessage & { rejectedReason: string | null } {
	const encoded = new TextEncoder().encode(input.raw)
	const headers = new Headers()
	for (const line of input.raw.split(/\r?\n/)) {
		if (!line.trim()) break
		const separator = line.indexOf(':')
		if (separator <= 0) continue
		headers.append(line.slice(0, separator), line.slice(separator + 1).trim())
	}
	return {
		from: input.from,
		to: input.to,
		headers,
		raw: new Blob([encoded]).stream(),
		rawSize: encoded.byteLength,
		rejectedReason: null,
		setReject(reason: string) {
			this.rejectedReason = reason
		},
		async forward() {
			return { messageId: 'unused-forward' }
		},
		async reply() {
			return { messageId: 'unused-reply' }
		},
	}
}

test('inbound email handler stores quarantined and accepted messages by sender policy', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-user-${crypto.randomUUID()}`
	const address = requireNormalizedEmailAddress(
		`support-${crypto.randomUUID()}@example.com`,
	)
	const inbox = await createEmailInbox({
		db: env.APP_DB,
		userId,
		name: 'Support',
		description: 'Support inbox',
		mode: 'quarantine',
	})
	await createEmailInboxAddress({
		db: env.APP_DB,
		inboxId: inbox.id,
		userId,
		address,
		localPart: getEmailLocalPart(address),
		domain: getEmailDomain(address),
	})

	const quarantinedMessage = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: address,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${address}`,
			'Subject: Unknown sender',
			'Message-ID: <unknown@example.net>',
			'',
			'Please help.',
		].join('\r\n'),
	})
	await handleInboundEmail(quarantinedMessage, env)
	expect(quarantinedMessage.rejectedReason).toBeNull()

	await upsertEmailSenderPolicy({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		kind: 'domain',
		value: 'trusted.example',
		effect: 'allow',
	})
	const acceptedMessage = createForwardableEmailMessage({
		from: 'agent@trusted.example',
		to: address,
		raw: [
			'From: Agent <agent@trusted.example>',
			`To: ${address}`,
			'Subject: Approved sender',
			'Message-ID: <approved@trusted.example>',
			'',
			'Approved body.',
		].join('\r\n'),
	})
	await handleInboundEmail(acceptedMessage, env)
	expect(acceptedMessage.rejectedReason).toBeNull()

	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 10,
	})
	expect(messages.map((message) => message.policyDecision)).toEqual([
		'accepted',
		'quarantined',
	])
	expect(messages[0]).toMatchObject({
		fromAddress: 'agent@trusted.example',
		subject: 'Approved sender',
		processingStatus: 'stored',
	})
	expect(messages[1]).toMatchObject({
		fromAddress: 'stranger@example.net',
		subject: 'Unknown sender',
		error: null,
	})

	const normalizedExistingThread = await createEmailThread({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		subjectNormalized: 'normalized subject',
	})
	const subjectMatchedMessage = createForwardableEmailMessage({
		from: 'agent@trusted.example',
		to: address,
		raw: [
			'From: Agent <agent@trusted.example>',
			`To: ${address}`,
			'Subject: Re: Normalized Subject',
			'',
			'Subject match body.',
		].join('\r\n'),
	})
	await handleInboundEmail(subjectMatchedMessage, env)
	const subjectMatched = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 1,
	})
	expect(subjectMatched[0]?.threadId).toBe(normalizedExistingThread.id)
})

test('inbound email handler rejects unknown aliases without persisting them', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const recipient = `missing-${crypto.randomUUID()}@example.com`
	const message = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: recipient,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${recipient}`,
			'Subject: Unknown alias',
			'',
			'Please help.',
		].join('\r\n'),
	})

	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toBe('Unknown Kody email alias.')
	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId: 'unknown',
		limit: 10,
	})
	expect(messages).toEqual([])
})
