import { type SecretScope } from '#mcp/secrets/types.ts'

const secretPlaceholderRegex =
	/\{\{secret:([a-zA-Z0-9._-]+)(?:\|scope=(session|app|user))?\}\}/g
const basicAuthSecretPlaceholderRegex =
	/\{\{secret-basic:username=([a-zA-Z0-9._-]+),password=([a-zA-Z0-9._-]+)(?:\|scope=(session|app|user))?\}\}/g

export type ReferencedSecret = {
	name: string
	scope: SecretScope | null
}

export type ReferencedBasicAuthSecretPlaceholder = {
	username: ReferencedSecret
	password: ReferencedSecret
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

export function parseBasicAuthSecretPlaceholders(value: string) {
	const placeholders: Array<ReferencedBasicAuthSecretPlaceholder> = []
	for (const match of value.matchAll(basicAuthSecretPlaceholderRegex)) {
		const usernameSecretName = match[1]?.trim()
		const passwordSecretName = match[2]?.trim()
		if (!usernameSecretName || !passwordSecretName) continue
		const scope = parseSecretScope(match[3])
		placeholders.push({
			username: {
				name: usernameSecretName,
				scope,
			},
			password: {
				name: passwordSecretName,
				scope,
			},
			scope,
		})
	}
	return placeholders
}

export function parseSecretPlaceholdersFromFormUrlEncoded(value: string) {
	const secrets: Array<ReferencedSecret> = []
	for (const [key, entryValue] of new URLSearchParams(value)) {
		secrets.push(...parseSecretPlaceholders(key))
		secrets.push(...parseSecretPlaceholders(entryValue))
	}
	return secrets
}

export function parseBasicAuthSecretPlaceholdersFromFormUrlEncoded(
	value: string,
) {
	const placeholders: Array<ReferencedBasicAuthSecretPlaceholder> = []
	for (const [key, entryValue] of new URLSearchParams(value)) {
		placeholders.push(...parseBasicAuthSecretPlaceholders(key))
		placeholders.push(...parseBasicAuthSecretPlaceholders(entryValue))
	}
	return placeholders
}

export function buildSecretPlaceholder(secret: ReferencedSecret) {
	return secret.scope
		? `{{secret:${secret.name}|scope=${secret.scope}}}`
		: `{{secret:${secret.name}}}`
}

export function buildBasicAuthSecretPlaceholder(input: {
	usernameSecret: string
	passwordSecret: string
	scope?: SecretScope | null
}) {
	return input.scope
		? `{{secret-basic:username=${input.usernameSecret},password=${input.passwordSecret}|scope=${input.scope}}}`
		: `{{secret-basic:username=${input.usernameSecret},password=${input.passwordSecret}}}`
}

export function buildBasicAuthSecretPlaceholderFromReference(
	placeholder: ReferencedBasicAuthSecretPlaceholder,
) {
	return buildBasicAuthSecretPlaceholder({
		usernameSecret: placeholder.username.name,
		passwordSecret: placeholder.password.name,
		scope: placeholder.scope,
	})
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

export function replaceSecretPlaceholdersInFormUrlEncoded(
	value: string,
	replacements: ReadonlyMap<string, string>,
) {
	const nextParams = new URLSearchParams()
	for (const [key, entryValue] of new URLSearchParams(value)) {
		nextParams.append(
			replaceSecretPlaceholders(key, replacements),
			replaceSecretPlaceholders(entryValue, replacements),
		)
	}
	return nextParams.toString()
}

export function containsSecretPlaceholder(value: string) {
	return /\{\{secret(?::|-basic:)/.test(value)
}

function parseSecretScope(scope: string | undefined) {
	return scope === 'app' || scope === 'session' || scope === 'user'
		? scope
		: null
}
