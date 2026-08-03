import { expect, test } from 'vitest'
import { baseMessage, rpcFor, uniqueUserId } from './mailbox-test-helpers.ts'

async function insertMessage(input: {
	userId: string
	sequence: number
	subject: string
	fromAddress: string
	envelopeFrom?: string | null
	direction?: 'inbound' | 'outbound'
	inboxId?: string | null
}) {
	const id = `search-message-${crypto.randomUUID()}`
	const createdAt = new Date(
		Date.parse('2026-07-01T00:00:00.000Z') + input.sequence * 1000,
	).toISOString()
	await rpcFor(input.userId).upsertMessageGraph({
		ownerId: input.userId,
		message: baseMessage(input.userId, {
			id,
			subject: input.subject,
			fromAddress: input.fromAddress,
			envelopeFrom: input.envelopeFrom ?? null,
			direction: input.direction ?? 'inbound',
			inboxId: input.inboxId ?? null,
			createdAt,
			updatedAt: createdAt,
		}),
	})
	return id
}

test('Mailbox search matches subject, from address, and envelope sender case-insensitively', async () => {
	const userId = uniqueUserId('search')
	const bySubject = await insertMessage({
		userId,
		sequence: 1,
		subject: 'Invoice #123 due Friday',
		fromAddress: 'billing@acme.example',
	})
	const byFrom = await insertMessage({
		userId,
		sequence: 2,
		subject: 'Weekly digest',
		fromAddress: 'no-reply@invoices.example',
	})
	const byEnvelope = await insertMessage({
		userId,
		sequence: 3,
		subject: 'Hello',
		fromAddress: 'friend@example.net',
		envelopeFrom: 'bounce+invoice@mailer.example',
	})
	await insertMessage({
		userId,
		sequence: 4,
		subject: 'Unrelated',
		fromAddress: 'someone@example.net',
	})
	const results = await rpcFor(userId).searchMessages({
		query: 'INVOICE',
		limit: 25,
	})
	expect(results.messages.map((message) => message.id)).toEqual([
		byEnvelope,
		byFrom,
		bySubject,
	])
}, 30_000)

test('Mailbox search treats LIKE wildcards in the query literally', async () => {
	const userId = uniqueUserId('search-literals')
	const literalPercent = await insertMessage({
		userId,
		sequence: 1,
		subject: 'Save 100% today',
		fromAddress: 'deals@example.net',
	})
	await insertMessage({
		userId,
		sequence: 2,
		subject: 'Save 100 dollars today',
		fromAddress: 'deals@example.net',
	})
	const literalUnderscore = await insertMessage({
		userId,
		sequence: 3,
		subject: 'snake_case release notes',
		fromAddress: 'dev@example.net',
	})
	await insertMessage({
		userId,
		sequence: 4,
		subject: 'snakeXcase release notes',
		fromAddress: 'dev@example.net',
	})

	expect(
		(
			await rpcFor(userId).searchMessages({ query: '100%', limit: 25 })
		).messages.map((message) => message.id),
	).toEqual([literalPercent])
	expect(
		(
			await rpcFor(userId).searchMessages({ query: 'snake_case', limit: 25 })
		).messages.map((message) => message.id),
	).toEqual([literalUnderscore])
}, 30_000)

test('Mailbox search applies filters and result limits', async () => {
	const userId = uniqueUserId('search-filters')
	const inboxId = `inbox-${crypto.randomUUID()}`
	const inboundInInbox = await insertMessage({
		userId,
		sequence: 1,
		subject: 'Filtered report',
		fromAddress: 'reports@example.net',
		inboxId,
	})
	const outbound = await insertMessage({
		userId,
		sequence: 2,
		subject: 'Filtered report reply',
		fromAddress: 'me@example.net',
		direction: 'outbound',
	})
	const inboundElsewhere = await insertMessage({
		userId,
		sequence: 3,
		subject: 'Filtered report elsewhere',
		fromAddress: 'reports@example.net',
	})
	const mailbox = rpcFor(userId)

	expect(
		(
			await mailbox.searchMessages({
				query: 'filtered report',
				direction: 'outbound',
				limit: 25,
			})
		).messages.map((message) => message.id),
	).toEqual([outbound])
	expect(
		(
			await mailbox.searchMessages({
				query: 'filtered report',
				inboxId,
				limit: 25,
			})
		).messages.map((message) => message.id),
	).toEqual([inboundInInbox])
	expect(
		(
			await mailbox.searchMessages({
				query: 'filtered report',
				limit: 2,
			})
		).messages.map((message) => message.id),
	).toEqual([inboundElsewhere, outbound])
}, 30_000)
