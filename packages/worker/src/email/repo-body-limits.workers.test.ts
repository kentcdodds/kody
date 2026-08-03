import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	maxRestorableTextColumnBytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import {
	createSystemEmailThread,
	getSystemEmailMessageById,
	insertSystemEmailMessage,
} from './system-email-graph-store.ts'
import { emailBodyTruncationNotice } from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('dedicated system email bodies remain bounded for backup restore', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const oversized = `<p>${'x'.repeat(maxRestorableTextColumnBytes + 10_000)}</p>`
	const stored = await insertSystemEmailMessage({
		db: env.APP_DB,
		message: {
			processingStatus: 'stored',
			fromAddress: 'sender@example.com',
			textBody: 'short text body',
			htmlBody: oversized,
			rawMimeKey: 'emails/system/raw.mime',
		},
	})

	expect(stored.textBody).toBe('short text body')
	expect(stored.htmlBody?.endsWith(emailBodyTruncationNotice)).toBe(true)
	expect(utf8ByteLength(stored.htmlBody ?? '')).toBeLessThanOrEqual(
		maxRestorableTextColumnBytes,
	)
})

test('dedicated system thread and message reads remain owner-isolated', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const thread = await createSystemEmailThread({
		db: env.APP_DB,
		subjectNormalized: 'hello thread',
		rootMessageIdHeader: '<root@example.com>',
	})
	const message = await insertSystemEmailMessage({
		db: env.APP_DB,
		message: {
			threadId: thread.id,
			processingStatus: 'stored',
			fromAddress: 'sender@example.com',
			subject: 'hello',
		},
	})
	await expect(
		getSystemEmailMessageById({ db: env.APP_DB, messageId: message.id }),
	).resolves.toMatchObject({
		id: message.id,
		userId: 'system:email',
		threadId: thread.id,
	})
})
