/**
 * Shared fixtures for email test suites.
 */

export type TestForwardableEmailMessage = ForwardableEmailMessage & {
	rejectedReason: string | null
}

export const inboundInlinePngFilename = 'chart.png'
export const inboundInlinePngContentId = 'chart@inbound.test'

/**
 * Synthesize a Mimestream-like `multipart/related` message: HTML plus an
 * inline PNG. Callers pick `minRawBytes` (the large-inbound test uses
 * ~575 KiB, under the 768 KiB platform cap). Not a real customer MIME.
 */
export function createMultipartRelatedInlinePngRawMime(input: {
	from: string
	to: string
	subject: string
	messageId: string
	minRawBytes: number
}) {
	const boundary = 'kody-inline-png-boundary'
	const html = `<!doctype html><html><body><p>Budget alert</p><img src="cid:${inboundInlinePngContentId}" alt="chart"></body></html>`
	const prefix = [
		`From: Sender <${input.from}>`,
		`To: ${input.to}`,
		`Subject: ${input.subject}`,
		`Message-ID: <${input.messageId}>`,
		'MIME-Version: 1.0',
		`Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		'Content-Type: text/html; charset="utf-8"',
		'',
		html,
		`--${boundary}`,
		'Content-Type: image/png',
		'Content-Transfer-Encoding: base64',
		`Content-ID: <${inboundInlinePngContentId}>`,
		`Content-Disposition: inline; filename="${inboundInlinePngFilename}"`,
		'',
		'',
	].join('\r\n')
	const suffix = `\r\n--${boundary}--\r\n`
	const overhead = new TextEncoder().encode(prefix + suffix).byteLength
	const base64Length = Math.max(input.minRawBytes - overhead, 64)
	const paddedLength = base64Length + ((4 - (base64Length % 4)) % 4)
	const chunk =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
	const pngSignatureBase64 = 'iVBORw0KGgo'
	const remaining = Math.max(paddedLength - pngSignatureBase64.length, 0)
	return (
		prefix +
		pngSignatureBase64 +
		chunk.repeat(Math.ceil(remaining / chunk.length)).slice(0, remaining) +
		suffix
	)
}

export function createLargeMultipartRelatedInlinePngMessage(input: {
	from: string
	to: string
	subject: string
	messageId: string
	minRawBytes: number
}): TestForwardableEmailMessage {
	return createForwardableEmailMessage({
		from: input.from,
		to: input.to,
		raw: createMultipartRelatedInlinePngRawMime(input),
	})
}

export function createForwardableEmailMessage(input: {
	from: string
	to: string
	raw: string
}): TestForwardableEmailMessage {
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
