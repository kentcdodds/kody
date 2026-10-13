/**
 * Fills literal secret placeholders in a request body as it streams, with a
 * carry-over buffer so a placeholder split across chunks is still found.
 * Multipart parts use the same literal scan (placeholders inside parts fill).
 *
 * Holdback and fill operate on original body bytes only: substituted
 * credential values are never carried into a later scan, so nested
 * `{{secret:…}}` text inside a value (or a value that, with the next chunk,
 * would form a new placeholder) stays literal — same single-pass guarantee as
 * {@link replaceSecretPlaceholders}.
 *
 * Format-aware escaping matches the buffered body path: JSON values are
 * JSON-escaped, form-urlencoded values are form-encoded, text/multipart stay
 * literal. Encoded placeholder forms this path will not fill are refused via
 * {@link assertNoUnfilledEncodedPlaceholder} (forms still refuse base64).
 */
import {
	assertNoUnfilledEncodedPlaceholder,
	assertNoUnfilledBase64Placeholder,
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

const literalSecretStarters = [
	'{{secret:',
	'{{secret-basic:',
	'{{integration-token:',
	'{{secret/',
] as const

const percentSecretStarters = [
	'%7B%7Bsecret%3A',
	'%7B%7Bsecret-basic%3A',
	'%7B%7Bintegration-token%3A',
	'%7B%7Bsecret%2F',
] as const

/** Shortest unique base64 opener stems used for end-of-chunk holdback. */
const base64HoldStems = [
	'{{secret:',
	'{{secret/',
	'{{secret-basic:',
	'{{integration-token:',
].flatMap((opener) => {
	const stem = btoa(opener).replace(/=+$/, '')
	return stem.length >= 8 ? [stem] : []
})

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

/** Escaped fill value as latin1 binary so UTF-8 secrets splice correctly. */
function escapedFillBinary(value: string, format: PlaceholderStreamBodyFormat) {
	return bytesToBinary(
		new TextEncoder().encode(escapeFilledValue(value, format)),
	)
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

function matchesAnyStarterPrefix(
	tail: string,
	starters: ReadonlyArray<string>,
) {
	for (const starter of starters) {
		const length = Math.min(starter.length, tail.length)
		if (length > 0 && starter.slice(0, length) === tail.slice(0, length)) {
			return true
		}
		if (tail.startsWith(starter)) return true
	}
	return false
}

function unclosedCouldBeLiteralSecret(tail: string) {
	if (!tail.includes('{{')) return false
	return matchesAnyStarterPrefix(tail, literalSecretStarters)
}

function unclosedCouldBePercentSecret(tail: string) {
	const upper = tail.toUpperCase()
	if (!upper.includes('%7B')) return false
	// Incomplete `%7B` / `%7B%7B` punctuation before the kind stem.
	if (
		upper === '%' ||
		upper === '%7' ||
		upper === '%7B' ||
		upper === '%7B%' ||
		upper === '%7B%7' ||
		upper === '%7B%7B' ||
		upper.startsWith('%7B%7B')
	) {
		return (
			matchesAnyStarterPrefix(
				upper,
				percentSecretStarters.map((s) => s.toUpperCase()),
			) ||
			upper === '%' ||
			upper === '%7' ||
			upper === '%7B' ||
			upper === '%7B%' ||
			upper === '%7B%7' ||
			upper === '%7B%7B' ||
			percentSecretStarters.some((starter) =>
				starter.toUpperCase().startsWith(upper),
			)
		)
	}
	return false
}

function unclosedCouldBeBase64Secret(tail: string) {
	for (const stem of base64HoldStems) {
		for (
			let length = 8;
			length <= Math.min(stem.length, tail.length);
			length += 1
		) {
			if (tail.endsWith(stem.slice(0, length))) return true
		}
	}
	return false
}

/**
 * Holdback for an unclosed secret-shaped opener (literal, percent, or base64),
 * or 0 when the text is safe to emit.
 */
function streamingHoldBytes(text: string): {
	reject: 'window' | null
	hold: number
} {
	const lastLiteralClose = text.lastIndexOf('}}')
	const lastPercentClose = text.toUpperCase().lastIndexOf('%7D%7D')
	let cut = -1
	if (lastLiteralClose !== -1) cut = Math.max(cut, lastLiteralClose + 2)
	if (lastPercentClose !== -1) cut = Math.max(cut, lastPercentClose + 6)
	const rest = cut === -1 ? text : text.slice(cut)

	const literalOpen = rest.lastIndexOf('{{')
	// Prefer a full `%7B%7B` opener; a lone trailing `%7B` still needs holdback.
	const restUpper = rest.toUpperCase()
	let percentOpen = restUpper.lastIndexOf('%7B%7B')
	if (percentOpen === -1) {
		const lone = restUpper.lastIndexOf('%7B')
		const partialPct = restUpper.lastIndexOf('%')
		percentOpen = lone !== -1 ? lone : partialPct
	}
	const candidates: Array<{
		start: number
		kind: 'literal' | 'percent' | 'base64'
	}> = []
	if (literalOpen !== -1) {
		candidates.push({ start: literalOpen, kind: 'literal' })
	}
	if (percentOpen !== -1) {
		candidates.push({ start: percentOpen, kind: 'percent' })
	}
	// Base64 openers have no reliable start marker; hold a suffix that could
	// complete into a known opener stem.
	if (unclosedCouldBeBase64Secret(rest)) {
		let holdLength = 0
		for (const stem of base64HoldStems) {
			for (
				let length = 8;
				length <= Math.min(stem.length, rest.length);
				length += 1
			) {
				if (rest.endsWith(stem.slice(0, length))) {
					holdLength = Math.max(holdLength, length)
				}
			}
		}
		if (holdLength > 0) {
			candidates.push({ start: rest.length - holdLength, kind: 'base64' })
		}
	}

	if (candidates.length === 0) {
		const trailing =
			rest.endsWith('{') || rest.toUpperCase().endsWith('%') ? 1 : 0
		return { reject: null, hold: trailing }
	}

	// Rightmost holdable unclosed opener wins. An earlier closed or non-secret
	// `%…` must not hide a later `{{secret` split across the next chunk.
	candidates.sort((a, b) => b.start - a.start)
	for (const candidate of candidates) {
		const tail = rest.slice(candidate.start)
		const closed =
			candidate.kind === 'literal'
				? tail.includes('}}')
				: candidate.kind === 'percent'
					? tail.toUpperCase().includes('%7D%7D')
					: false
		if (closed) continue
		const couldBe =
			candidate.kind === 'literal'
				? unclosedCouldBeLiteralSecret(tail)
				: candidate.kind === 'percent'
					? unclosedCouldBePercentSecret(tail)
					: true
		if (!couldBe) continue
		if (tail.length > placeholderStreamHoldLimitBytes) {
			return { reject: 'window', hold: 0 }
		}
		return { reject: null, hold: tail.length }
	}
	return {
		reject: null,
		hold: rest.endsWith('{') || rest.toUpperCase().endsWith('%') ? 1 : 0,
	}
}

function eofHasUnresolvedSecret(text: string) {
	const hold = streamingHoldBytes(text)
	if (hold.hold === 0) return false
	const tail = text.slice(text.length - hold.hold)
	if (tail.length <= 2 && !tail.toUpperCase().includes('%7')) return false
	return (
		unclosedCouldBeLiteralSecret(tail) ||
		unclosedCouldBePercentSecret(tail) ||
		unclosedCouldBeBase64Secret(tail)
	)
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
	/** Settles when the source is fully consumed, cancelled, or failed. */
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
	 * When true (form bodies), percent-encoded placeholders are filled; base64
	 * encoded forms are still refused. When false, both percent and base64
	 * encoded forms are refused.
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

	const refuseEncoded = (text: string) => {
		if (input.allowPercentEncoded) {
			assertNoUnfilledBase64Placeholder(text)
			return
		}
		assertNoUnfilledEncodedPlaceholder(text)
	}

	const fillCompletePlaceholders = async (text: string) => {
		refuseEncoded(text)
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
			escaped.set(placeholder, escapedFillBinary(secretValue, input.format))
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

	const reader = input.source.getReader()
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (failed) {
				controller.close()
				settleDone()
				return
			}
			try {
				// Keep reading while a holdback emits nothing so the consumer
				// is not stalled waiting for a second pull scheduling edge.
				while (controller.desiredSize === null || controller.desiredSize > 0) {
					const { done: sourceDone, value } = await reader.read()
					if (sourceDone) {
						if (carry.length > 0) {
							refuseEncoded(carry)
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
						controller.close()
						settleDone()
						return
					}
					// Hold and scan original body bytes only. Filling before
					// holdback would re-scan credential text on the next chunk
					// when a value ends with an unclosed `{{secret…` opener.
					const text = carry + bytesToBinary(value)
					carry = ''
					const hold = streamingHoldBytes(text)
					if (hold.reject === 'window') {
						throw new Error(
							`A credential placeholder in the request body exceeds the ${placeholderStreamHoldLimitBytes}-byte inspection window. Shorten the placeholder or buffer the body.`,
						)
					}
					const emitLength = text.length - hold.hold
					if (hold.hold > 0) {
						carry = text.slice(emitLength)
					}
					if (emitLength > 0) {
						const filled = await fillCompletePlaceholders(
							text.slice(0, emitLength),
						)
						if (filled.length > 0) {
							controller.enqueue(binaryToBytes(filled))
						}
						return
					}
				}
			} catch (error) {
				fail(error)
				try {
					reader.releaseLock()
				} catch {
					// Reader may already be released.
				}
				controller.error(error)
			}
		},
		cancel(reason) {
			settleDone()
			return reader.cancel(reason)
		},
	})

	return {
		stream,
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
