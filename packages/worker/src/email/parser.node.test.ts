import { expect, test } from 'vitest'
import { parseForwardableEmailMessage } from './parser.ts'

function createMessage(raw: string): ForwardableEmailMessage {
	const headers = new Headers()
	for (const line of raw.split(/\r?\n/)) {
		if (!line) break
		const separator = line.indexOf(':')
		if (separator > 0) {
			headers.append(line.slice(0, separator), line.slice(separator + 1).trim())
		}
	}
	return {
		from: 'sender@example.com',
		to: 'support@example.com',
		headers,
		raw: new Response(raw).body!,
		rawSize: new TextEncoder().encode(raw).byteLength,
		setReject() {},
		async forward() {
			return { messageId: 'forwarded' }
		},
		async reply() {
			return { messageId: 'reply' }
		},
	} satisfies ForwardableEmailMessage
}

test('parseForwardableEmailMessage extracts headers, bodies, and attachment metadata', async () => {
	const raw = [
		'From: Sender <sender@example.com>',
		'To: Support <support@example.com>',
		'Subject: Hello',
		'Message-ID: <message@example.com>',
		'Content-Type: multipart/mixed; boundary="b"',
		'',
		'--b',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Plain body',
		'--b',
		'Content-Type: text/plain; name="note.txt"',
		'Content-Disposition: attachment; filename="note.txt"',
		'',
		'Attachment body',
		'--b--',
		'',
	].join('\r\n')

	const parsed = await parseForwardableEmailMessage(createMessage(raw))

	expect(parsed).toMatchObject({
		envelopeFrom: 'sender@example.com',
		envelopeTo: 'support@example.com',
		headerFrom: 'sender@example.com',
		subject: 'Hello',
		messageId: '<message@example.com>',
		textBody: expect.stringContaining('Plain body'),
	})
	expect(parsed.to.map((entry) => entry.address)).toContain('support@example.com')
	expect(parsed.attachments).toEqual([
		expect.objectContaining({
			filename: 'note.txt',
			contentType: 'text/plain',
			disposition: 'attachment',
			size: expect.any(Number),
		}),
	])
})

test('parseForwardableEmailMessage rejects oversized raw MIME', async () => {
	await expect(
		parseForwardableEmailMessage(createMessage('Subject: Oversized\n\nbody'), {
			maxRawSize: 5,
		}),
	).rejects.toThrow(/too large/)
})
