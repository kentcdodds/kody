import { storageScopeValues, type StorageScope } from '#mcp/storage.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'

export function buildValueEntityId(input: {
	name: string
	scope: StorageScope
}) {
	return `${input.scope}:${encodeURIComponent(input.name)}`
}

export function parseValueEntityId(id: string): {
	name: string
	scope: StorageScope
} {
	const separator = id.indexOf(':')
	if (separator <= 0 || separator === id.length - 1) {
		throw new Error('Value entities must use the format "{scope}:{name}".')
	}
	const scope = id.slice(0, separator).trim()
	if (!storageScopeValues.includes(scope as StorageScope)) {
		throw new Error('Value entity scope must be one of: session, app, or user.')
	}
	const encodedName = id.slice(separator + 1).trim()
	if (!encodedName) {
		throw new Error('Value entity name must not be empty.')
	}
	try {
		const name = decodeURIComponent(encodedName)
		if (!name) {
			throw new Error('Value entity name must not be empty.')
		}
		return { name, scope: scope as StorageScope }
	} catch {
		throw new Error('Value entity name must be URL-encoded when needed.')
	}
}

export function describeValue(row: ValueMetadata): string {
	const description = row.description.trim()
	if (description) return description
	if (row.scope === 'app' && row.appId) {
		return `Persisted app-scoped value for app ${row.appId}.`
	}
	return `Persisted ${row.scope}-scoped value.`
}
