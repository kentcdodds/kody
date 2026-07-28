/**
 * D1 disaster-recovery restore safety limits.
 *
 * Cloudflare D1's SQL import path rejects individual statements above its
 * documented 100 KB statement-length limit with `statement too long:
 * SQLITE_TOOBIG` (verified live 2026-07-27 against a production export: a
 * dump filtered to statements <= 100,000 bytes imported cleanly while the
 * same dump with 100–200 KB statements failed). D1's own export writes one
 * INSERT per row, so any row whose serialized form exceeds that limit makes
 * the whole backup un-importable.
 *
 * Every D1 write path that can store large text therefore bounds stored
 * column sizes so a full row (all columns plus INSERT framing and SQL
 * escaping overhead) stays comfortably below the import limit.
 */

/** D1 import per-statement ceiling (bytes of SQL text). */
export const d1ImportMaxStatementBytes = 100_000

/**
 * Upper bound for any single large text column persisted to D1. Leaves
 * headroom below {@link d1ImportMaxStatementBytes} for the other row
 * columns, INSERT framing, and quote-escaping expansion in SQL dumps.
 */
export const maxRestorableTextColumnBytes = 65_536

export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point.
 */
export function truncateToUtf8Bytes(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value)
	if (encoded.byteLength <= maxBytes) return value
	const sliced = encoded.slice(0, maxBytes)
	return new TextDecoder('utf-8', { fatal: false })
		.decode(sliced)
		.replace(/\uFFFD+$/, '')
}
