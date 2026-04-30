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

test('inbound email handler stores all routed inbound messages', async () => {
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
	})
	await createEmailInboxAddress({
		db: env.APP_DB,
		inboxId: inbox.id,
		userId,
		address,
		localPart: getEmailLocalPart(address),
		domain: getEmailDomain(address),
	})

	const firstMessage = createForwardableEmailMessage({
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
	await handleInboundEmail(firstMessage, env)
	expect(firstMessage.rejectedReason).toBeNull()

	const secondMessage = createForwardableEmailMessage({
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
	await handleInboundEmail(secondMessage, env)
	expect(secondMessage.rejectedReason).toBeNull()

	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 10,
	})
	expect(messages).toHaveLength(2)
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
	const subjectOnlyMessage = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Re: Normalized Subject',
			'',
			'Subject-only body.',
		].join('\r\n'),
	})
	await handleInboundEmail(subjectOnlyMessage, env)
	const subjectOnly = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 1,
	})
	expect(subjectOnly[0]?.threadId).not.toBe(normalizedExistingThread.id)
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

test('inbound email handler rejects malformed messages without persisting them', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-parse-user-${crypto.randomUUID()}`
	const address = requireNormalizedEmailAddress(
		`parse-${crypto.randomUUID()}@example.com`,
	)
	const inbox = await createEmailInbox({
		db: env.APP_DB,
		userId,
		name: 'Parse failures',
		description: 'Parse failure inbox',
	})
	await createEmailInboxAddress({
		db: env.APP_DB,
		inboxId: inbox.id,
		userId,
		address,
		localPart: getEmailLocalPart(address),
		domain: getEmailDomain(address),
	})
	const message = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: 'Subject: Too large\r\n\r\nBody',
	})
	Object.defineProperty(message, 'rawSize', {
		value: 600 * 1024,
	})

	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toMatch(/too large/)
	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 10,
	})
	expect(messages).toEqual([])
})
