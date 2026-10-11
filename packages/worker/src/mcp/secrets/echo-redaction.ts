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
 * including a value split across chunks. At one position the longest value
 * wins, so a value that begins with a shorter one is redacted whole. It holds
 * back at most the longest value's length minus one byte between chunks.
 *
 * `preserveLength` masks each value with as many `*` bytes instead, for
 * responses whose headers describe byte offsets (range responses).
 */
export function createEchoRedactionStream(
	values: Iterable<string>,
	options: { preserveLength?: boolean } = {},
): TransformStream<Uint8Array, Uint8Array> {
	const patterns = distinctValues(values).map((value) =>
		bytesToBinary(encoder.encode(value)),
	)
	const redactionText = bytesToBinary(encoder.encode(redactedSecretText))
	const replacementFor = (pattern: string) =>
		options.preserveLength ? '*'.repeat(pattern.length) : redactionText
	const longest = Math.max(0, ...patterns.map((pattern) => pattern.length))
	let carry = ''
	const drain = (text: string, final: boolean) => {
		let output = ''
		let position = 0
		for (;;) {
			let matchAt = -1
			let matched = ''
			for (const pattern of patterns) {
				const index = text.indexOf(pattern, position)
				if (index !== -1 && (matchAt === -1 || index < matchAt)) {
					matchAt = index
					matched = pattern
				}
			}
			if (matchAt === -1) break
			// A longer value starting here may still be completed by the next
			// chunk, so the match waits until every value would fit.
			if (!final && matchAt + longest > text.length) break
			output += text.slice(position, matchAt) + replacementFor(matched)
			position = matchAt + matched.length
		}
		// Anything before `safeEnd` cannot start a value that ends past `text`.
		const safeEnd = final
			? text.length
			: Math.max(position, text.length - (longest - 1))
		output += text.slice(position, safeEnd)
		carry = text.slice(safeEnd)
		return output
	}
	return new TransformStream({
		transform(chunk, controller) {
			const output = drain(carry + bytesToBinary(chunk), false)
			if (output) controller.enqueue(binaryToBytes(output))
		},
		flush(controller) {
			const output = drain(carry, true)
			if (output) controller.enqueue(binaryToBytes(output))
		},
	})
}

function redactText(text: string, values: ReadonlyArray<string>) {
	let next = text
	for (const value of values) next = next.replaceAll(value, redactedSecretText)
	return next
}

function isRangeResponse(response: Response) {
	return response.status === 206 || response.headers.has('content-range')
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
 * `response` with every `values` entry redacted from its URL, headers, and
 * body. The body length can change, so `content-length` is dropped, except on
 * range responses: there each value is masked byte for byte so
 * `content-range` and `content-length` stay true.
 */
export function redactEchoedSecrets(
	response: Response,
	values: Iterable<string>,
): Response {
	const distinct = distinctValues(values)
	if (distinct.length === 0) return response
	const preserveLength = isRangeResponse(response)
	const headers = redactHeaders(response.headers, distinct)
	if (response.body && !preserveLength) headers.delete('content-length')
	const redacted = new Response(
		response.body?.pipeThrough(
			createEchoRedactionStream(distinct, { preserveLength }),
		) ?? null,
		{
			status: response.status,
			statusText: redactText(response.statusText, distinct),
			headers,
		},
	)
	return withLanding(redacted, {
		url: redactText(response.url, distinct),
		redirected: response.redirected,
	})
}

/**
 * The Response constructor cannot set `url` or `redirected`, and callers read
 * `url` to see where a fetch landed (a redirect can carry the value in it).
 * `clone()` copies only the internal slots, so it reapplies them too.
 */
function withLanding(
	response: Response,
	landing: { url: string; redirected: boolean },
): Response {
	const clone = response.clone.bind(response)
	return Object.defineProperties(response, {
		url: { value: landing.url },
		redirected: { value: landing.redirected },
		clone: { value: () => withLanding(clone(), landing) },
	})
}
