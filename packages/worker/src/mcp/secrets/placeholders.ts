import { type SecretScope } from '#mcp/secrets/types.ts'

const secretPlaceholderRegex =
	/\{\{secret:([a-zA-Z0-9._-]+)(?:\|scope=(session|app|user))?\}\}/g

export type ReferencedSecret = {
	name: string
	scope: SecretScope | null
}

export function parseSecretPlaceholders(value: string) {
	const secrets: Array<ReferencedSecret> = []
	for (const match of value.matchAll(secretPlaceholderRegex)) {
		const name = match[1]?.trim()
		if (!name) continue
		const scope = match[2]
		secrets.push({
			name,
			scope:
				scope === 'app' || scope === 'session' || scope === 'user'
					? scope
					: null,
		})
	}
	return secrets
}

export function buildSecretPlaceholder(secret: ReferencedSecret) {
	return secret.scope
		? `{{secret:${secret.name}|scope=${secret.scope}}}`
		: `{{secret:${secret.name}}}`
}

export function replaceSecretPlaceholders(
	value: string,
	replacements: ReadonlyMap<string, string>,
) {
	let nextValue = value
	for (const [placeholder, secretValue] of replacements.entries()) {
		nextValue = nextValue.replaceAll(placeholder, secretValue)
	}
	return nextValue
}
