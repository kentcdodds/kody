import {
	buildAccountSecretPath,
	joinOriginAndEncodedPath,
} from '@kody-internal/shared/account-secret-route.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { type SecretScope } from './types.ts'

export function buildSecretCapabilityApprovalUrl(input: {
	baseUrl: string
	name: string
	scope: SecretScope
	capabilityName: string
	storageContext: StorageContext | null
}) {
	const secretPath = buildAccountSecretPath({
		name: input.name,
		scope: input.scope,
		packageId: input.storageContext?.packageId ?? null,
		sessionId: input.storageContext?.sessionId ?? null,
	})
	const search = new URLSearchParams()
	search.set('capability', input.capabilityName)
	return `${joinOriginAndEncodedPath(input.baseUrl, secretPath)}?${search}`
}
