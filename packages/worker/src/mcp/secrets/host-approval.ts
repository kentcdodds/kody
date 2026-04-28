import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { normalizeHost } from './allowed-hosts.ts'
import { type SecretScope } from './types.ts'

export function buildSecretHostApprovalUrl(input: {
	baseUrl: string
	name: string
	scope: SecretScope
	requestedHost: string
	storageContext: StorageContext | null
}) {
	const secretPath = buildAccountSecretPath({
		name: input.name,
		scope: input.scope,
		appId: input.storageContext?.appId ?? null,
		sessionId: input.storageContext?.sessionId ?? null,
	})
	const url = new URL(secretPath, input.baseUrl)
	url.searchParams.set('allowed-host', normalizeHost(input.requestedHost))
	return url.toString()
}
