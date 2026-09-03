import { expect, test } from 'vitest'
import { toHex } from '@kody-internal/shared/hex.ts'
import {
	maxKeptInboundRawBytes,
	prepareInboundRawMime,
} from './skinny-inbound-mime.ts'

const textEncoder = new TextEncoder()

function multipartWithAttachment(input: {
	text: string
	filename: string
	attachmentBody: string
	contentType?: string
}) {
	const boundary = 'kody-skinny-boundary'
	return [
		'From: Sender <sender@example.net>',
		'To: user@example.com',
		'Subject: Invoice',
		'Message-ID: <skinny@example.net>',
		'MIME-Version: 1.0',
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		input.text,
		`--${boundary}`,
		`Content-Type: ${input.contentType ?? 'application/pdf'}`,
		'Content-Transfer-Encoding: 7bit',
		`Content-Disposition: attachment; filename="${input.filename}"`,
		'',
		input.attachmentBody,
		`--${boundary}--`,
		'',
	].join('\r\n')
}

test('prepareInboundRawMime keeps small messages and reduces oversized attachments', async () => {
	const small = multipartWithAttachment({
		text: 'Please see the attached invoice.',
		filename: 'note.txt',
		attachmentBody: 'tiny',
		contentType: 'text/plain',
	})
	const smallBytes = textEncoder.encode(small)
	const unchanged = await prepareInboundRawMime(smallBytes, {
		maxKeptBytes: 16_384,
	})
	expect(unchanged).toMatchObject({
		rawMime: small,
		keptRawSize: smallBytes.byteLength,
		originalRawSize: smallBytes.byteLength,
		reduced: false,
		omittedAttachments: [],
		originalSha256: null,
	})

	const attachmentBody = 'P'.repeat(80_000)
	const large = multipartWithAttachment({
		text: 'Please see the attached invoice.',
		filename: 'invoice.pdf',
		attachmentBody,
	})
	const largeBytes = textEncoder.encode(large)
	expect(largeBytes.byteLength).toBeGreaterThan(16_384)
	const reduced = await prepareInboundRawMime(largeBytes, {
		maxKeptBytes: 16_384,
	})
	expect(reduced.reduced).toBe(true)
	expect(reduced.keptRawSize).toBeLessThanOrEqual(16_384)
	expect(reduced.originalRawSize).toBe(largeBytes.byteLength)
	const expectedDigest = new Uint8Array(largeBytes.byteLength)
	expectedDigest.set(largeBytes)
	expect(reduced.originalSha256).toBe(
		toHex(
			new Uint8Array(await crypto.subtle.digest('SHA-256', expectedDigest)),
		),
	)
	expect(reduced.rawMime).toContain('Please see the attached invoice.')
	expect(reduced.rawMime).toContain('X-Kody-Inbound-Reduced: 1')
	expect(reduced.rawMime).toContain(
		`X-Kody-Original-Size: ${largeBytes.byteLength}`,
	)
	expect(reduced.rawMime).not.toContain(attachmentBody)
	expect(reduced.omittedAttachments).toEqual([
		expect.objectContaining({
			filename: 'invoice.pdf',
			contentType: 'application/pdf',
			disposition: 'attachment',
			size: attachmentBody.length,
			storageKind: 'unavailable',
		}),
	])
	expect(reduced.rawMime).toContain('invoice.pdf')

	const underPlatformCap = await prepareInboundRawMime(
		textEncoder.encode(
			multipartWithAttachment({
				text: 'Fits the persist ceiling.',
				filename: 'tiny.pdf',
				attachmentBody: 'pdf',
			}),
		),
	)
	expect(underPlatformCap.reduced).toBe(false)
	expect(underPlatformCap.keptRawSize).toBeLessThanOrEqual(
		maxKeptInboundRawBytes,
	)

	const hugeText = 'Keep this invoice note. '.repeat(2_000)
	const huge = [
		'From: Sender <sender@example.net>',
		'To: user@example.com',
		'Subject: Huge text',
		'Message-ID: <huge@example.net>',
		'Content-Type: text/plain; charset=utf-8',
		'',
		hugeText,
	].join('\r\n')
	const hugeReduced = await prepareInboundRawMime(textEncoder.encode(huge), {
		maxKeptBytes: 4_096,
	})
	expect(hugeReduced.reduced).toBe(true)
	expect(hugeReduced.keptRawSize).toBeLessThanOrEqual(4_096)
	expect(hugeReduced.rawMime).toContain('Keep this invoice note.')
	expect(hugeReduced.rawMime).toContain('[truncated]')

	const encodedHtml = Buffer.from('<p>Hidden encoded html</p>').toString(
		'base64',
	)
	const encoded = [
		'From: Sender <sender@example.net>',
		'To: user@example.com',
		'Subject: Encoded',
		'Message-ID: <encoded@example.net>',
		'Content-Type: multipart/mixed; boundary="b"',
		'',
		'--b',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Visible plain body.',
		'--b',
		'Content-Type: text/html; charset=utf-8',
		'Content-Transfer-Encoding: base64',
		'',
		encodedHtml,
		'--b',
		'Content-Type: application/pdf',
		'Content-Disposition: attachment; filename="bin.pdf"',
		'',
		'P'.repeat(8_000),
		'--b--',
		'',
	].join('\r\n')
	const encodedReduced = await prepareInboundRawMime(
		textEncoder.encode(encoded),
		{ maxKeptBytes: 4_096 },
	)
	expect(encodedReduced.keptRawSize).toBeLessThanOrEqual(4_096)
	expect(encodedReduced.rawMime).toContain('Visible plain body.')
	expect(encodedReduced.rawMime).not.toContain('Hidden encoded html')
	expect(encodedReduced.omittedAttachments).toEqual([
		expect.objectContaining({
			filename: 'bin.pdf',
			storageKind: 'unavailable',
		}),
	])
})
