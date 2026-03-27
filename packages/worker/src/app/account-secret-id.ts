import { type SecretScope } from '#mcp/secrets/types.ts'

type AccountSecretRouteScope = SecretScope
const accountSecretsBasePath = '/account/secrets'

export type AccountSecretRouteIdInput = {
	name: string
	scope: AccountSecretRouteScope
	appId?: string | null
	sessionId?: string | null
}

export type ParsedAccountSecretRouteId = {
	name: string
	scope: AccountSecretRouteScope
	appId: string | null
	sessionId: string | null
}

export type ParsedAccountSecretRoutePath = ParsedAccountSecretRouteId & {
	id: string
}

export function buildAccountSecretId(input: AccountSecretRouteIdInput) {
	const bindingId =
		input.scope === 'app'
			? (input.appId ?? '')
			: input.scope === 'session'
				? (input.sessionId ?? '')
				: ''
	return `${input.scope}::${encodeURIComponent(bindingId)}::${encodeURIComponent(
		input.name,
	)}`
}

export function parseAccountSecretId(
	secretId: string,
): ParsedAccountSecretRouteId | null {
	const [scope, encodedBindingId, encodedName, ...rest] = secretId.split('::')
	if (rest.length > 0) return null
	if (scope !== 'app' && scope !== 'session' && scope !== 'user') return null

	try {
		const name = decodeURIComponent(encodedName ?? '')
		const bindingId = decodeURIComponent(encodedBindingId ?? '')
		if (!name.trim()) return null

		return {
			name,
			scope,
			appId: scope === 'app' ? bindingId || null : null,
			sessionId: scope === 'session' ? bindingId || null : null,
		}
	} catch {
		return null
	}
}

export function buildAccountSecretPath(input: AccountSecretRouteIdInput) {
	const name = encodeURIComponent(input.name)
	if (input.scope === 'user') {
		return `${accountSecretsBasePath}/user/${name}`
	}
	if (input.scope === 'app') {
		const appId = encodeURIComponent(input.appId ?? '')
		return `${accountSecretsBasePath}/app/${appId}/${name}`
	}
	const sessionId = encodeURIComponent(input.sessionId ?? '')
	return `${accountSecretsBasePath}/session/${sessionId}/${name}`
}

export function parseAccountSecretPath(
	pathname: string,
): ParsedAccountSecretRoutePath | null {
	const segments = pathname.replace(/\/+$/, '').split('/')
	if (segments.length === 0) return null

	const [empty, account, secrets, ...rest] = segments
	if (empty !== '' || account !== 'account' || secrets !== 'secrets') {
		return null
	}

	try {
		if (rest.length === 2 && rest[0] === 'user') {
			const parsed = {
				name: decodeURIComponent(rest[1] ?? ''),
				scope: 'user' as const,
				appId: null,
				sessionId: null,
			}
			if (!parsed.name.trim()) return null
			const id = buildAccountSecretId(parsed)
			return { ...parsed, id }
		}
		if (rest.length === 3 && rest[0] === 'app') {
			const parsed = {
				name: decodeURIComponent(rest[2] ?? ''),
				scope: 'app' as const,
				appId: decodeURIComponent(rest[1] ?? '') || null,
				sessionId: null,
			}
			if (!parsed.name.trim() || !parsed.appId) return null
			const id = buildAccountSecretId(parsed)
			return { ...parsed, id }
		}
		if (rest.length === 3 && rest[0] === 'session') {
			const parsed = {
				name: decodeURIComponent(rest[2] ?? ''),
				scope: 'session' as const,
				appId: null,
				sessionId: decodeURIComponent(rest[1] ?? '') || null,
			}
			if (!parsed.name.trim() || !parsed.sessionId) return null
			const id = buildAccountSecretId(parsed)
			return { ...parsed, id }
		}
		return null
	} catch {
		return null
	}
}
