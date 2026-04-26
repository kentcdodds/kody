import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { type SecretScope } from './types.ts'

export function buildSecretPackageApprovalUrl(input: {
	baseUrl: string
	name: string
	scope: SecretScope
	packageId: string
	kodyId: string | null
	token?: string | null
	storageContext: StorageContext | null
}) {
	if (input.scope === 'app' && !input.storageContext?.appId) {
		throw new Error('storageContext.appId is required for app-scope approvals.')
	}
	if (input.scope === 'session' && !input.storageContext?.sessionId) {
		throw new Error(
			'storageContext.sessionId is required for session-scope approvals.',
		)
	}
	const secretPath = buildAccountSecretPath({
		name: input.name,
		scope: input.scope,
		appId: input.storageContext?.appId ?? null,
		sessionId: input.storageContext?.sessionId ?? null,
	})
	const url = new URL(secretPath, input.baseUrl)
	url.searchParams.set('package_id', input.packageId)
	if (input.kodyId) {
		url.searchParams.set('package', input.kodyId)
	}
	if (input.token) {
		url.searchParams.set('request', input.token)
	}
	return url.toString()
}
