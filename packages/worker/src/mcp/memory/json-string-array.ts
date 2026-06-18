export function parseJsonStringArray(raw: string): Array<string> {
	try {
		const value = JSON.parse(raw) as unknown
		if (!Array.isArray(value)) return []
		return value.filter((item): item is string => typeof item === 'string')
	} catch {
		return []
	}
}
