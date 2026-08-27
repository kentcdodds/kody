import {
	buildAccountSecretPath,
	joinOriginAndEncodedPath,
} from '@kody-internal/shared/account-secret-route.ts'
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
		packageId: input.storageContext?.packageId ?? null,
		sessionId: input.storageContext?.sessionId ?? null,
	})
	const search = new URLSearchParams()
	search.set('allowed-host', normalizeHost(input.requestedHost))
	return `${joinOriginAndEncodedPath(input.baseUrl, secretPath)}?${search}`
}
