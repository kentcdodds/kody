/**
 * Redacts credential values a remote echoes back in its response, before the
 * calling code sees it (credentials plan v4, open call 15). Matching is exact,
 * like run output redaction: each substituted value becomes
 * `[REDACTED SECRET]` in response headers and in the body bytes.
 */
import { redactedSecretText } from './execution-secret-redactor.ts'

const encoder = new TextEncoder()

/** One char per byte, so string search runs on raw bytes of any encoding. */
function bytesToBinary(bytes: Uint8Array) {
	let binary = ''
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
	}
	return binary
}

function binaryToBytes(binary: string) {
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

function distinctValues(values: Iterable<string>) {
	return [...new Set(values)]
		.filter((value) => value.length > 0)
		.sort((left, right) => right.length - left.length)
}

/**
 * A byte stream transform that replaces every value with the redaction text,
 * including a value split across chunks. It holds back at most the longest
 * value's length minus one byte between chunks.
 */
export function createEchoRedactionStream(
	values: Iterable<string>,
): TransformStream<Uint8Array, Uint8Array> {
	const patterns = distinctValues(values).map((value) =>
		bytesToBinary(encoder.encode(value)),
	)
	const replacement = bytesToBinary(encoder.encode(redactedSecretText))
	const holdBack = Math.max(0, ...patterns.map((pattern) => pattern.length - 1))
	let carry = ''
	return new TransformStream({
		transform(chunk, controller) {
			const text = carry + bytesToBinary(chunk)
			let output = ''
			let position = 0
			for (;;) {
				let matchAt = -1
				let matchLength = 0
				for (const pattern of patterns) {
					const index = text.indexOf(pattern, position)
					if (index !== -1 && (matchAt === -1 || index < matchAt)) {
						matchAt = index
						matchLength = pattern.length
					}
				}
				if (matchAt === -1) break
				output += text.slice(position, matchAt) + replacement
				position = matchAt + matchLength
			}
			// A match starting before `safeEnd` would already be complete in
			// `text`, so everything before it is final.
			const safeEnd = Math.max(position, text.length - holdBack)
			output += text.slice(position, safeEnd)
			carry = text.slice(safeEnd)
			if (output) controller.enqueue(binaryToBytes(output))
		},
		flush(controller) {
			if (carry) controller.enqueue(binaryToBytes(carry))
		},
	})
}

function redactText(text: string, values: ReadonlyArray<string>) {
	let next = text
	for (const value of values) next = next.replaceAll(value, redactedSecretText)
	return next
}

function redactHeaders(headers: Headers, values: ReadonlyArray<string>) {
	const next = new Headers()
	for (const [name, value] of headers) {
		if (name === 'set-cookie') continue
		next.set(name, redactText(value, values))
	}
	for (const cookie of headers.getSetCookie()) {
		next.append('set-cookie', redactText(cookie, values))
	}
	return next
}

/**
 * `response` with every `values` entry redacted from its headers and body.
 * The body length can change, so `content-length` is dropped.
 */
export function redactEchoedSecrets(
	response: Response,
	values: Iterable<string>,
): Response {
	const distinct = distinctValues(values)
	if (distinct.length === 0) return response
	const headers = redactHeaders(response.headers, distinct)
	if (response.body) headers.delete('content-length')
	const redacted = new Response(
		response.body?.pipeThrough(createEchoRedactionStream(distinct)) ?? null,
		{
			status: response.status,
			statusText: redactText(response.statusText, distinct),
			headers,
		},
	)
	// The constructor cannot set these, and callers read `url` to see where a
	// fetch landed.
	Object.defineProperties(redacted, {
		url: { value: response.url },
		redirected: { value: response.redirected },
	})
	return redacted
}
