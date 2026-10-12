/**
 * Fills literal secret placeholders in a request body as it streams, with a
 * carry-over buffer so a placeholder split across chunks is still found.
 * Multipart parts use the same literal scan (placeholders inside parts fill).
 *
 * Format-aware escaping matches the buffered body path: JSON values are
 * JSON-escaped, form-urlencoded values are form-encoded, text/multipart stay
 * literal. Encoded placeholder forms this path will not fill are refused via
 * {@link assertNoUnfilledEncodedPlaceholder}.
 */
import {
	assertNoUnfilledEncodedPlaceholder,
	EncodedPlaceholderError,
} from './encoded-placeholder.ts'
import {
	buildBasicAuthSecretPlaceholderFromReference,
	buildIntegrationTokenPlaceholder,
	buildProviderSecretPlaceholder,
	buildSecretPlaceholder,
	decodeSecretPlaceholderPunctuation,
	parseBasicAuthSecretPlaceholders,
	parseIntegrationTokenPlaceholders,
	parseProviderSecretPlaceholders,
	parseSecretPlaceholders,
	replaceSecretPlaceholders,
	type ReferencedBasicAuthSecretPlaceholder,
	type ReferencedProviderSecret,
	type ReferencedSecret,
} from './placeholders.ts'

/** Literal or percent-encoded `{{…}}` span (same idea as path fill). */
const placeholderSpanPattern = /(?:\{|%7B){2}.*?(?:\}|%7D){2}/gi

/** Body formats the stream filler knows how to escape. */
export type PlaceholderStreamBodyFormat = 'text' | 'json' | 'form' | 'multipart'

/**
 * Longest placeholder we will hold across chunks. Vault refs can be long;
 * past this an unclosed `{{secret…` prefix fails closed.
 */
export const placeholderStreamHoldLimitBytes = 4096

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

function escapeFilledValue(value: string, format: PlaceholderStreamBodyFormat) {
	switch (format) {
		case 'json':
			return JSON.stringify(value).slice(1, -1)
		case 'form':
			return new URLSearchParams([['', value]]).toString().slice(1)
		case 'text':
		case 'multipart':
			return value
		default: {
			const exhaustive: never = format
			throw new Error(`Unhandled body format: ${String(exhaustive)}`)
		}
	}
}

function unclosedCouldBeSecret(tail: string) {
	if (!tail.includes('{{')) return false
	const starters = [
		'{{secret:',
		'{{secret-basic:',
		'{{integration-token:',
		'{{secret/',
	]
	for (const starter of starters) {
		const length = Math.min(starter.length, tail.length)
		if (starter.slice(0, length) === tail.slice(0, length)) return true
		if (tail.startsWith(starter)) return true
	}
	return false
}

/**
 * Holdback for an unclosed secret-shaped `{{…` prefix, or 0 when the text is
 * safe to emit.
 */
function streamingHoldBytes(text: string): {
	reject: 'window' | null
	hold: number
} {
	const lastClose = text.lastIndexOf('}}')
	const rest = lastClose === -1 ? text : text.slice(lastClose + 2)
	const open = rest.lastIndexOf('{{')
	if (open === -1) {
		return { reject: null, hold: rest.endsWith('{') ? 1 : 0 }
	}
	const tail = rest.slice(open)
	if (tail.includes('}}') || !unclosedCouldBeSecret(tail)) {
		return { reject: null, hold: rest.endsWith('{') ? 1 : 0 }
	}
	if (tail.length > placeholderStreamHoldLimitBytes) {
		return { reject: 'window', hold: 0 }
	}
	return { reject: null, hold: tail.length }
}

function eofHasUnresolvedSecret(text: string) {
	const lastClose = text.lastIndexOf('}}')
	const rest = lastClose === -1 ? text : text.slice(lastClose + 2)
	const open = rest.lastIndexOf('{{')
	if (open === -1) return false
	const tail = rest.slice(open)
	if (tail.length <= 2) return false
	return unclosedCouldBeSecret(tail)
}

export type PlaceholderReferenceBatch = {
	secrets: ReadonlyArray<ReferencedSecret>
	basicAuth: ReadonlyArray<ReferencedBasicAuthSecretPlaceholder>
	integrationTokens: ReadonlyArray<string>
	providerSecrets: ReadonlyArray<ReferencedProviderSecret>
}

/** Every distinct placeholder reference in `text` (literal forms only). */
export function collectLiteralPlaceholderReferences(
	text: string,
): PlaceholderReferenceBatch {
	return {
		secrets: parseSecretPlaceholders(text),
		basicAuth: parseBasicAuthSecretPlaceholders(text),
		integrationTokens: parseIntegrationTokenPlaceholders(text),
		providerSecrets: parseProviderSecretPlaceholders(text),
	}
}

export function batchHasPlaceholders(batch: PlaceholderReferenceBatch) {
	return (
		batch.secrets.length > 0 ||
		batch.basicAuth.length > 0 ||
		batch.integrationTokens.length > 0 ||
		batch.providerSecrets.length > 0
	)
}

/**
 * Resolve callback: given newly seen placeholder text, ensure
 * `replacements` holds every literal placeholder token in it. May resolve
 * credentials asynchronously. Returns values that were substituted (for echo
 * redaction), including Basic Auth encoded credentials when applicable.
 */
export type ResolveBodyPlaceholders = (
	batch: PlaceholderReferenceBatch,
) => Promise<ReadonlyArray<string>>

export type PlaceholderStreamFill = {
	stream: ReadableStream<Uint8Array>
	/** Settles when the source is fully consumed and the transform flushed. */
	done: Promise<void>
	/** Values filled so far (grows until {@link done}). */
	substitutedValues: Array<string>
}

/**
 * Transform that fills literal placeholders chunk-by-chunk. Callers that
 * already resolved URL/header placeholders pass them in `replacements`; body
 * placeholders discovered mid-stream call `resolve`.
 */
export function createPlaceholderFillStream(input: {
	source: ReadableStream<Uint8Array>
	format: PlaceholderStreamBodyFormat
	replacements: Map<string, string>
	resolve: ResolveBodyPlaceholders
	/**
	 * When true (form bodies), percent-encoded placeholders are left for the
	 * form component path; when false, encoded forms are refused.
	 */
	allowPercentEncoded?: boolean
}): PlaceholderStreamFill {
	const substitutedValues: Array<string> = []
	const recorded = new Set<string>()
	const recordValues = (values: ReadonlyArray<string>) => {
		for (const value of values) {
			if (value.length === 0 || recorded.has(value)) continue
			recorded.add(value)
			substitutedValues.push(value)
		}
	}
	let settleDone: () => void
	let rejectDone: (error: unknown) => void
	let settled = false
	const done = new Promise<void>((resolve, reject) => {
		settleDone = () => {
			if (settled) return
			settled = true
			resolve()
		}
		rejectDone = (error) => {
			if (settled) return
			settled = true
			reject(error)
		}
	})
	done.catch(() => {})

	let carry = ''
	let failed = false

	const fail = (error: unknown) => {
		if (failed) return
		failed = true
		rejectDone(error)
	}

	const fillCompletePlaceholders = async (text: string) => {
		if (!input.allowPercentEncoded) {
			assertNoUnfilledEncodedPlaceholder(text)
		}
		const batch = collectLiteralPlaceholderReferences(
			input.allowPercentEncoded
				? decodeSecretPlaceholderPunctuation(text)
				: text,
		)
		if (batchHasPlaceholders(batch)) {
			const values = await input.resolve(batch)
			recordValues(values)
		}
		recordValues([...input.replacements.values()])
		const escaped = new Map<string, string>()
		for (const [placeholder, secretValue] of input.replacements) {
			escaped.set(placeholder, escapeFilledValue(secretValue, input.format))
		}
		if (!input.allowPercentEncoded) {
			return replaceSecretPlaceholders(text, escaped)
		}
		// Form bodies: fill literal and percent-encoded spans, same as the
		// buffered form path's decode-then-replace per component.
		return text.replaceAll(placeholderSpanPattern, (span) => {
			const decoded = decodeSecretPlaceholderPunctuation(span)
			const next = replaceSecretPlaceholders(decoded, escaped)
			return next === decoded ? span : next
		})
	}

	const transform = new TransformStream<Uint8Array, Uint8Array>({
		async transform(chunk, controller) {
			if (failed) return
			try {
				const text = carry + bytesToBinary(chunk)
				carry = ''
				const filled = await fillCompletePlaceholders(text)
				const hold = streamingHoldBytes(filled)
				if (hold.reject === 'window') {
					throw new Error(
						`A credential placeholder in the request body exceeds the ${placeholderStreamHoldLimitBytes}-byte inspection window. Shorten the placeholder or buffer the body.`,
					)
				}
				const emitLength = filled.length - hold.hold
				if (emitLength > 0) {
					controller.enqueue(binaryToBytes(filled.slice(0, emitLength)))
				}
				if (hold.hold > 0) {
					carry = filled.slice(filled.length - hold.hold)
				}
			} catch (error) {
				fail(error)
				controller.error(error)
			}
		},
		async flush(controller) {
			if (failed) {
				settleDone()
				return
			}
			try {
				if (carry.length > 0) {
					if (!input.allowPercentEncoded) {
						assertNoUnfilledEncodedPlaceholder(carry)
					}
					if (eofHasUnresolvedSecret(carry)) {
						throw new Error(
							'The request body ends with an unclosed credential placeholder. Close the {{…}} form or remove it.',
						)
					}
					const filled = await fillCompletePlaceholders(carry)
					carry = ''
					if (filled.length > 0) {
						controller.enqueue(binaryToBytes(filled))
					}
				}
				settleDone()
			} catch (error) {
				fail(error)
				controller.error(error)
			}
		},
	})

	return {
		stream: input.source.pipeThrough(transform),
		done,
		substitutedValues,
	}
}

export { EncodedPlaceholderError }

/** Build replacement keys a Basic Auth placeholder may appear as. */
export function basicAuthReplacementKeys(
	placeholder: ReferencedBasicAuthSecretPlaceholder,
) {
	const rendered = buildBasicAuthSecretPlaceholderFromReference(placeholder)
	return [
		rendered,
		`Basic ${rendered}`,
		`basic ${rendered}`,
		`BASIC ${rendered}`,
	]
}

export function secretReplacementKey(secret: ReferencedSecret) {
	return buildSecretPlaceholder(secret)
}

export function integrationTokenReplacementKey(name: string) {
	return buildIntegrationTokenPlaceholder(name)
}

export function providerSecretReplacementKey(secret: ReferencedProviderSecret) {
	return buildProviderSecretPlaceholder(secret)
}
