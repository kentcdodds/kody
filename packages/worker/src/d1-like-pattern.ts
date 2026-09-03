/**
 * Cloudflare D1 rejects LIKE / GLOB patterns longer than 50 bytes with
 * `D1_ERROR: LIKE or GLOB pattern too complex` (SQLite's
 * SQLITE_MAX_LIKE_PATTERN_LENGTH is lowered from its 50,000 default). A user
 * query or a 64-hex stable user id wrapped in `%…%` crosses that easily, so
 * every bound LIKE pattern is built here and trimmed to fit.
 *
 * Use `instr(column, ?) > 0` instead when matching a fixed substring that may
 * exceed the budget on its own (see `account/data-targets.ts`).
 */
export const d1MaxLikePatternBytes = 50

const likeEscapePattern = /[\\%_]/g

export function escapeLikePattern(value: string) {
	return value.replace(likeEscapePattern, (char) => `\\${char}`)
}

function utf8ByteLength(value: string) {
	return new TextEncoder().encode(value).length
}

/**
 * Trim `value` (already escaped) so that `%${value}%` fits in
 * `d1MaxLikePatternBytes`, never ending on a dangling escape backslash and
 * never splitting a multi-byte character.
 */
function fitEscapedValue(value: string, budgetBytes: number) {
	let result = value
	while (result.length > 0 && utf8ByteLength(result) > budgetBytes) {
		result = result.slice(0, -1)
	}
	// Dropping the character after a backslash would leave an escape that
	// swallows the closing `%`; drop the backslash as well.
	let trailingBackslashes = 0
	for (let index = result.length - 1; index >= 0; index -= 1) {
		if (result[index] !== '\\') break
		trailingBackslashes += 1
	}
	if (trailingBackslashes % 2 === 1) {
		result = result.slice(0, -1)
	}
	return result
}

/**
 * `%value%` contains-pattern for `LIKE ? ESCAPE '\'`, escaped and trimmed to
 * D1's pattern limit. Callers that want a raw (unescaped) token, such as the
 * `[a-z0-9]+` community tokens, pass `{ escape: false }`.
 */
export function d1ContainsLikePattern(
	value: string,
	options: { escape?: boolean } = {},
) {
	const escaped = options.escape === false ? value : escapeLikePattern(value)
	const budget = d1MaxLikePatternBytes - 2
	return `%${fitEscapedValue(escaped, budget)}%`
}
