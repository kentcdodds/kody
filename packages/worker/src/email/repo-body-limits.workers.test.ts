import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	maxRestorableTextColumnBytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import { emailBodyTruncationNotice, insertEmailMessage } from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('stored email bodies are bounded so D1 backups stay importable', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const oversized = `<p>${'x'.repeat(maxRestorableTextColumnBytes + 10_000)}</p>`

	const stored = await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'inbound',
			userId: `user-${crypto.randomUUID()}`,
			fromAddress: 'sender@example.com',
			toAddresses: ['inbox@example.com'],
			subject: 'Giant newsletter',
			textBody: 'short text body',
			htmlBody: oversized,
			rawMimeKey: 'emails/user/raw.mime',
			processingStatus: 'stored',
		},
	})

	expect(stored.textBody).toBe('short text body')
	expect(stored.htmlBody?.endsWith(emailBodyTruncationNotice)).toBe(true)
	expect(utf8ByteLength(stored.htmlBody ?? '')).toBeLessThanOrEqual(
		maxRestorableTextColumnBytes,
	)
})
