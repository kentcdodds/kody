/**
 * Detects percent-encoded and base64-encoded secret placeholder forms the
 * gateway will not fill, so it can refuse them instead of forwarding a
 * usable credential reference.
 *
 * Literal `{{…}}` placeholders stay filled. Percent-encoded punctuation in
 * the URL path/query and in form-urlencoded components is still filled by
 * the existing decode-and-replace path; those sites never call
 * {@link assertNoUnfilledEncodedPlaceholder}.
 */

const percentEncodedPlaceholderPattern =
	/%7B%7B(?:secret(?:%3A|-basic%3A|%2F)|integration-token%3A)/i

/**
 * Base64 of common placeholder openers (`{{secret:`, `{{secret/`,
 * `{{secret-basic:`, `{{integration-token:`). Generated once so a scan does
 * not re-encode on every chunk.
 */
const base64PlaceholderOpeners = [
	'{{secret:',
	'{{secret/',
	'{{secret-basic:',
	'{{integration-token:',
].flatMap((opener) => {
	const encoded = btoa(opener)
	// Chunk boundaries and padding may drop trailing `=`; match the stem.
	const stem = encoded.replace(/=+$/, '')
	return stem.length >= 8 ? [stem] : []
})

export class EncodedPlaceholderError extends Error {
	override name = 'EncodedPlaceholderError'
}

/**
 * Clear, actionable refusal when the body (or another non-fill site) holds
 * an encoded placeholder form the gateway will not fill.
 */
export function encodedPlaceholderRefusalMessage(kind: 'percent' | 'base64') {
	switch (kind) {
		case 'percent':
			return 'The request body holds a percent-encoded credential placeholder (for example %7B%7Bsecret%3A…%7D%7D). The fetch gateway fills literal {{secret:…}} / {{integration-token:…}} placeholders (and percent-encoded forms only in the URL path, query, or form-urlencoded components). Put the placeholder in literal form, move it to a header or URL, or remove it.'
		case 'base64':
			return 'The request body holds a base64-encoded credential placeholder. The fetch gateway fills literal {{secret:…}} / {{integration-token:…}} placeholders only. Decode the placeholder to literal form before sending, put it in a header or URL, or remove it.'
		default: {
			const exhaustive: never = kind
			throw new Error(
				`Unhandled encoded placeholder kind: ${String(exhaustive)}`,
			)
		}
	}
}

/**
 * Throws {@link EncodedPlaceholderError} when `text` (latin1 / binary-as-text)
 * holds a percent-encoded or base64-encoded placeholder opener the caller
 * will not fill.
 */
export function assertNoUnfilledEncodedPlaceholder(text: string) {
	if (percentEncodedPlaceholderPattern.test(text)) {
		throw new EncodedPlaceholderError(
			encodedPlaceholderRefusalMessage('percent'),
		)
	}
	for (const opener of base64PlaceholderOpeners) {
		if (text.includes(opener)) {
			throw new EncodedPlaceholderError(
				encodedPlaceholderRefusalMessage('base64'),
			)
		}
	}
}

/** True when `text` holds an encoded placeholder form this module refuses. */
export function holdsUnfilledEncodedPlaceholder(text: string) {
	try {
		assertNoUnfilledEncodedPlaceholder(text)
		return false
	} catch (error) {
		if (error instanceof EncodedPlaceholderError) return true
		throw error
	}
}
