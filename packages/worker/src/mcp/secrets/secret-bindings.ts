import { secretScopeValues, type SecretScope } from './types.ts'
import { type StorageContext } from '#mcp/storage.ts'

export const defaultSecretLookupOrder = [
	...secretScopeValues,
] as Array<SecretScope>

export function resolveSecretScopeOrder(storageContext: StorageContext | null) {
	return defaultSecretLookupOrder.filter(
		(scope) => getSecretBindingKey(scope, storageContext) != null,
	)
}

export function getSecretBindingKey(
	scope: SecretScope,
	storageContext: StorageContext | null,
) {
	if (scope === 'user') return ''
	if (scope === 'package') {
		const packageId = storageContext?.packageId?.trim()
		return packageId || null
	}
	if (scope === 'session') {
		const sessionId = storageContext?.sessionId?.trim()
		return sessionId || null
	}
	return null
}
