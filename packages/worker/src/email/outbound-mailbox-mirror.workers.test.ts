import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { rpcFor } from './mailbox-test-helpers.ts'
import { sendOutboundEmail } from './outbound.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const cloudflareEmailApi =
	'https://api.cloudflare.test/client/v4/accounts/account-123/email/sending/send'

const platformBaseUrl = 'https://kody.example.com'
// User mail lives on the inbox. subdomain derived from APP_BASE_URL.
const platformDomain = 'inbox.kody.example.com'

async function seedVerifiedAccount(input: { email: string }) {
	const username = `sender-${crypto.randomUUID().slice(0, 8)}`
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
			VALUES (?, ?, ?, ?, 'max', ?)`,
	)
		.bind(
			username,
			input.email,
			'test-password-hash',
			new Date().toISOString(),
			stableUserId,
		)
		.run()
	return { username, from: `${username}@${platformDomain}` }
}

test('sendOutboundEmail mirrors outbound message graph into Mailbox on success', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `mailbox-sent-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })
	const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
	const sendEnv = {
		...env,
		APP_BASE_URL: platformBaseUrl,
		EMAIL: {
			async send() {
				return { messageId: 'provider-mailbox-sent' }
			},
		},
	}

	const result = await sendOutboundEmail({
		env: sendEnv,
		userId,
		accountEmail,
		recipientPolicy: 'self',
		subject: 'Mailbox mirror sent',
		text: 'Mirrored body',
		attachments: [
			{
				filename: 'note.pdf',
				contentType: 'application/pdf',
				contentBase64: bytesToBase64(pdfBytes),
			},
		],
	})

	expect(result.status).toBe('sent')
	expect(result.message.threadId).toBeTruthy()
	const mailbox = rpcFor(userId)
	const mirroredMessage = await mailbox.getMessage({
		messageId: result.message.id,
	})
	expect(mirroredMessage).toMatchObject({
		id: result.message.id,
		direction: 'outbound',
		processingStatus: 'sent',
		providerMessageId: 'provider-mailbox-sent',
		subject: 'Mailbox mirror sent',
		threadId: result.message.threadId,
	})
	const mirroredThread = await mailbox.getThread({
		threadId: result.message.threadId!,
	})
	expect(mirroredThread).toMatchObject({
		id: result.message.threadId,
		subjectNormalized: 'mailbox mirror sent',
	})
	const mirroredAttachments = await mailbox.listAttachmentsForMessage({
		messageId: result.message.id,
	})
	expect(mirroredAttachments).toEqual([
		expect.objectContaining({
			filename: 'note.pdf',
			contentType: 'application/pdf',
			size: pdfBytes.byteLength,
			storageKind: 'external',
		}),
	])
	const mirroredEvents = await mailbox.listDeliveryEvents({
		messageId: result.message.id,
		limit: 10,
	})
	expect(mirroredEvents.map((event) => event.eventType).sort()).toEqual([
		'send_requested',
		'sent',
	])
}, 30_000)

test('sendOutboundEmail mirrors failed outbound graph into Mailbox', async () => {
	silenceIncidentalRuntimeWarnings(['cloudflare-email-api-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `mailbox-fail-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })

	using _server = createMswNodeServer(
		[
			http.post(cloudflareEmailApi, () =>
				HttpResponse.json(
					{ success: false, errors: [{ message: 'provider down' }] },
					{ status: 500 },
				),
			),
		],
		{ onUnhandledRequest: 'bypass' },
	)

	const result = await sendOutboundEmail({
		env: {
			...env,
			APP_BASE_URL: platformBaseUrl,
			EMAIL: undefined as unknown as SendEmail,
			CLOUDFLARE_ACCOUNT_ID: 'account-123',
			CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
			CLOUDFLARE_API_TOKEN: 'token-123',
		},
		userId,
		accountEmail,
		recipientPolicy: 'self',
		subject: 'Mailbox mirror failed',
		text: 'Body',
	})

	expect(result.status).toBe('failed')
	expect(result.error).toBe('provider down')
	const mailbox = rpcFor(userId)
	const mirroredMessage = await mailbox.getMessage({
		messageId: result.message.id,
	})
	expect(mirroredMessage).toMatchObject({
		id: result.message.id,
		direction: 'outbound',
		processingStatus: 'failed',
		error: 'provider down',
		threadId: result.message.threadId,
	})
	expect(
		await mailbox.getThread({ threadId: result.message.threadId! }),
	).toMatchObject({ id: result.message.threadId })
	const mirroredEvents = await mailbox.listDeliveryEvents({
		messageId: result.message.id,
		limit: 10,
	})
	expect(mirroredEvents.map((event) => event.eventType).sort()).toEqual([
		'failed',
		'send_requested',
	])
}, 30_000)
