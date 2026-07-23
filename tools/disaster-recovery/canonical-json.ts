import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
	)
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(',')}}`
}

export function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex')
}
