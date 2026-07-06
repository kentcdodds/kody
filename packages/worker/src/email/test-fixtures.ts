/**
 * Shared fixtures for email test suites.
 */

export type TestForwardableEmailMessage = ForwardableEmailMessage & {
	rejectedReason: string | null
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
