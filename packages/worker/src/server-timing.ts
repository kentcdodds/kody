export type ServerTimingEntry = {
	name: string
	durationMs: number
	desc?: string
}

const tokenPattern = /^[A-Za-z0-9_-]+$/

/**
 * Request-scoped Server-Timing style phase measurement. Same shape as execute
 * `serverTiming`: `{ name, durationMs }`, returned on the response, not stored.
 * `Date.now()` in Workers only advances across I/O, which is what we want for
 * attributing Artifacts/git round trips.
 */
export async function pushServerTiming<T>(
	timings: Array<ServerTimingEntry> | undefined,
	name: string,
	run: () => Promise<T>,
): Promise<T> {
	if (!timings) return await run()
	const startedAt = Date.now()
	try {
		return await run()
	} finally {
		timings.push({ name, durationMs: Date.now() - startedAt })
	}
}

function quoteDesc(value: string) {
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function unquoteDesc(value: string) {
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		return value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
	}
	return value
}

export function formatServerTimingHeader(
	entries: Array<ServerTimingEntry>,
): string {
	return entries
		.filter((entry) => tokenPattern.test(entry.name))
		.map((entry) => {
			const dur = Math.max(0, Math.round(entry.durationMs))
			const desc =
				entry.desc && tokenPattern.test(entry.desc)
					? `;desc=${quoteDesc(entry.desc)}`
					: ''
			return `${entry.name};dur=${dur}${desc}`
		})
		.join(', ')
}

function splitServerTimingParts(header: string, delimiter = ',') {
	const parts: Array<string> = []
	let current = ''
	let inQuotes = false
	let escaped = false
	for (const char of header) {
		if (escaped) {
			current += char
			escaped = false
			continue
		}
		if (inQuotes && char === '\\') {
			current += char
			escaped = true
			continue
		}
		if (char === '"' && !inQuotes) inQuotes = true
		else if (char === '"' && inQuotes) inQuotes = false
		else if (char === delimiter && !inQuotes) {
			parts.push(current)
			current = ''
			continue
		}
		current += char
	}
	if (current) parts.push(current)
	return parts
}

export function parseServerTimingHeader(
	header: string | null | undefined,
): Array<ServerTimingEntry> {
	if (!header) return []
	const entries: Array<ServerTimingEntry> = []
	for (const part of splitServerTimingParts(header)) {
		const tokens = splitServerTimingParts(part, ';')
			.map((token) => token.trim())
			.filter(Boolean)
		const name = tokens[0]
		if (!name) continue
		let durationMs = 0
		let desc: string | undefined
		for (const token of tokens.slice(1)) {
			const separator = token.indexOf('=')
			if (separator === -1) continue
			const key = token.slice(0, separator).trim().toLowerCase()
			const raw = token.slice(separator + 1).trim()
			if (key === 'dur') {
				const parsed = Number(raw)
				if (Number.isFinite(parsed)) durationMs = parsed
			}
			if (key === 'desc') desc = unquoteDesc(raw)
		}
		entries.push(desc ? { name, durationMs, desc } : { name, durationMs })
	}
	return entries
}

export function applyServerTimingHeader(
	headers: Headers,
	entries: Array<ServerTimingEntry> | undefined,
) {
	if (!entries || entries.length === 0) return
	const formatted = formatServerTimingHeader(entries)
	if (!formatted) return
	const existing = headers.get('Server-Timing')
	headers.set(
		'Server-Timing',
		existing ? `${existing}, ${formatted}` : formatted,
	)
}
