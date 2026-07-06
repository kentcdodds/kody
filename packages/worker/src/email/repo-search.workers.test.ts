import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { searchEmailMessages } from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

let messageSequence = 0

async function insertMessage(input: {
	userId: string
	subject: string
	fromAddress: string
	envelopeFrom?: string | null
	direction?: 'inbound' | 'outbound'
	inboxId?: string | null
}) {
	messageSequence += 1
	const id = `search-message-${crypto.randomUUID()}`
	// Spread created_at values so ordering assertions are deterministic.
	const createdAt = new Date(
		Date.parse('2026-07-01T00:00:00.000Z') + messageSequence * 1000,
	).toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, inbox_id, from_address, envelope_from,
			subject, processing_status, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, 'stored', ?, ?)`,
	)
		.bind(
			id,
			input.direction ?? 'inbound',
			input.userId,
			input.inboxId ?? null,
			input.fromAddress,
			input.envelopeFrom ?? null,
			input.subject,
			createdAt,
			createdAt,
		)
		.run()
	return id
}

test('searchEmailMessages matches subject, from address, and envelope sender case-insensitively', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `search-user-${crypto.randomUUID()}`
	const otherUserId = `search-other-${crypto.randomUUID()}`
	const bySubject = await insertMessage({
		userId,
		subject: 'Invoice #123 due Friday',
		fromAddress: 'billing@acme.example',
	})
	const byFrom = await insertMessage({
		userId,
		subject: 'Weekly digest',
		fromAddress: 'no-reply@invoices.example',
	})
	const byEnvelope = await insertMessage({
		userId,
		subject: 'Hello',
		fromAddress: 'friend@example.net',
		envelopeFrom: 'bounce+invoice@mailer.example',
	})
	await insertMessage({
		userId,
		subject: 'Unrelated',
		fromAddress: 'someone@example.net',
	})
	await insertMessage({
		userId: otherUserId,
		subject: 'Invoice for the other user',
		fromAddress: 'billing@acme.example',
	})

	const results = await searchEmailMessages({
		db: env.APP_DB,
		userId,
		query: 'INVOICE',
		limit: 25,
	})

	// Newest first, and never another user's mail.
	expect(results.map((message) => message.id)).toEqual([
		byEnvelope,
		byFrom,
		bySubject,
	])
})

test('searchEmailMessages treats LIKE wildcards in the query literally', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `search-escape-user-${crypto.randomUUID()}`
	const literalPercent = await insertMessage({
		userId,
		subject: 'Save 100% today',
		fromAddress: 'deals@example.net',
	})
	await insertMessage({
		userId,
		subject: 'Save 100 dollars today',
		fromAddress: 'deals@example.net',
	})
	const literalUnderscore = await insertMessage({
		userId,
		subject: 'snake_case release notes',
		fromAddress: 'dev@example.net',
	})
	await insertMessage({
		userId,
		subject: 'snakeXcase release notes',
		fromAddress: 'dev@example.net',
	})

	const percentResults = await searchEmailMessages({
		db: env.APP_DB,
		userId,
		query: '100%',
		limit: 25,
	})
	expect(percentResults.map((message) => message.id)).toEqual([literalPercent])

	const underscoreResults = await searchEmailMessages({
		db: env.APP_DB,
		userId,
		query: 'snake_case',
		limit: 25,
	})
	expect(underscoreResults.map((message) => message.id)).toEqual([
		literalUnderscore,
	])
})

test('searchEmailMessages applies filters and the result limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `search-filter-user-${crypto.randomUUID()}`
	const inboxId = `inbox-${crypto.randomUUID()}`
	const inboundInInbox = await insertMessage({
		userId,
		subject: 'Filtered report',
		fromAddress: 'reports@example.net',
		inboxId,
	})
	const outbound = await insertMessage({
		userId,
		subject: 'Filtered report reply',
		fromAddress: 'me@example.net',
		direction: 'outbound',
	})
	const inboundElsewhere = await insertMessage({
		userId,
		subject: 'Filtered report elsewhere',
		fromAddress: 'reports@example.net',
	})

	const outboundOnly = await searchEmailMessages({
		db: env.APP_DB,
		userId,
		query: 'filtered report',
		direction: 'outbound',
		limit: 25,
	})
	expect(outboundOnly.map((message) => message.id)).toEqual([outbound])

	const inboxOnly = await searchEmailMessages({
		db: env.APP_DB,
		userId,
		query: 'filtered report',
		inboxId,
		limit: 25,
	})
	expect(inboxOnly.map((message) => message.id)).toEqual([inboundInInbox])

	const limited = await searchEmailMessages({
		db: env.APP_DB,
		userId,
		query: 'filtered report',
		limit: 2,
	})
	expect(limited.map((message) => message.id)).toEqual([
		inboundElsewhere,
		outbound,
	])
})
